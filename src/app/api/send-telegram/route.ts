import { existsSync, readFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

const configPath = join(process.cwd(), "src", "json", "data.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token;
const ledgerPath = join(process.cwd(), "notification-ledger.json");

type UserConfig = {
  name?: string;
  telegram_chat_id: string;
  oi_threshold?: Record<string, number> | number;
  oi_min_gap?: number; // minimum OI% difference before re-notifying same strike (default 33)
  active?: boolean;
};

type SendRequest = {
  message?: string;
  symbol?: string;
  oiPct?: number;
  strike?: number | string;
  type?: string;
};

// Ledger tracks last sent OI% per user per strike
type LedgerEntry = {
  oiPct: number;
  time: string;
};

type NotificationLedger = {
  date: string;
  // key format: "chatId:SYMBOL:STRIKE:CE/PE" -> { oiPct, time }
  sent: Record<string, LedgerEntry>;
};

let sendQueue: Promise<void> = Promise.resolve();

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function getUsers(): UserConfig[] {
  const latestConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  return (latestConfig.users ?? []).filter((u: UserConfig) => u.active !== false);
}

async function readLedger(): Promise<NotificationLedger> {
  const date = todayKey();
  if (!existsSync(ledgerPath)) return { date, sent: {} };

  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf-8")) as NotificationLedger;
    if (ledger.date !== date) return { date, sent: {} }; // new day, reset
    return { date, sent: ledger.sent ?? {} };
  } catch {
    return { date, sent: {} };
  }
}

async function writeLedger(ledger: NotificationLedger) {
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}

function getUserThreshold(user: UserConfig, symbol?: string): number | null {
  const t = user.oi_threshold;
  if (typeof t === "number") return t;
  if (t && symbol) return t[symbol] ?? null;
  return null;
}

function strikeKey(chatId: string, symbol: string, strike: string | number, type: string): string {
  return `${chatId}:${symbol}:${strike}:${type}`;
}

function shouldSend(
  user: UserConfig,
  request: SendRequest,
  ledger: NotificationLedger
): { send: boolean; reason: string } {
  const { symbol, oiPct, strike, type } = request;

  // Non-OI messages (plain text) — always send
  if (typeof oiPct !== "number" || !symbol || strike == null || !type) {
    return { send: true, reason: "non-oi-message" };
  }

  // Rule 1: OI% must be >= user's threshold for this symbol
  const threshold = getUserThreshold(user, symbol);
  if (typeof threshold !== "number" || threshold <= 0) {
    return { send: false, reason: "no-threshold-configured" };
  }
  if (Math.abs(oiPct) < threshold) {
    return { send: false, reason: "below-threshold" };
  }

  // Check ledger for last sent value for this user+strike
  const key = strikeKey(user.telegram_chat_id, symbol, strike, type);
  const lastEntry = ledger.sent[key];

  // Rule 2: First notification for this strike today — send
  if (!lastEntry) {
    return { send: true, reason: "first-alert" };
  }

  // Rule 3: Must have >= oi_min_gap from last sent OI%
  const minGap = user.oi_min_gap ?? 33;
  const gap = Math.abs(oiPct - lastEntry.oiPct);
  if (gap < minGap) {
    return { send: false, reason: `gap-too-small (${gap.toFixed(1)}% < ${minGap}%)` };
  }

  return { send: true, reason: "gap-met" };
}

async function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const previous = sendQueue;
  let release!: () => void;
  sendQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

export async function POST(request: Request) {
  const payload = (await request.json()) as SendRequest;
  const { message } = payload;

  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  return enqueue(async () => {
    const users = getUsers();
    const ledger = await readLedger();
    const results = [];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const user of users) {
      const { send, reason } = shouldSend(user, payload, ledger);

      if (!send) {
        skipped += 1;
        results.push({ chat_id: user.telegram_chat_id, status: reason });
        continue;
      }

      try {
        const res = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: user.telegram_chat_id,
              text: message,
              parse_mode: "HTML",
            }),
          }
        );
        const body = await res.json();

        if (!res.ok || body.ok === false) {
          failed += 1;
          results.push({ chat_id: user.telegram_chat_id, status: "failed", body });
          continue;
        }

        sent += 1;

        // Record the sent OI% in ledger for this user+strike
        if (payload.symbol && payload.strike != null && payload.type && typeof payload.oiPct === "number") {
          const key = strikeKey(user.telegram_chat_id, payload.symbol, payload.strike, payload.type);
          ledger.sent[key] = {
            oiPct: payload.oiPct,
            time: new Date().toISOString(),
          };
        }

        results.push({ chat_id: user.telegram_chat_id, status: "sent" });
      } catch {
        failed += 1;
        results.push({ chat_id: user.telegram_chat_id, status: "failed" });
      }
    }

    await writeLedger(ledger);

    return Response.json({ ok: true, sent, skipped, failed, results });
  });
}
