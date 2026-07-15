import { existsSync, readFileSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const configPath = join(process.cwd(), "src", "json", "data.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token;
const ledgerPath = join(process.cwd(), "notification-ledger.json");

type UserConfig = {
  name?: string;
  telegram_chat_id: string;
  oi_threshold?: Record<string, number> | number;
  active?: boolean;
};

type SendRequest = {
  message?: string;
  notificationKey?: string;
  alertKey?: string;
  symbol?: string;
  oiPct?: number;
  strike?: number | string;
  type?: string;
};

type NotificationLedger = {
  date: string;
  sent: string[];
};

let sendQueue: Promise<void> = Promise.resolve();

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function getUsers(): UserConfig[] {
  const latestConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  return (latestConfig.users ?? []).filter((user: UserConfig) => user.active !== false);
}

async function readLedger(): Promise<NotificationLedger> {
  const date = todayKey();
  if (!existsSync(ledgerPath)) return { date, sent: [] };

  try {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf-8")) as NotificationLedger;
    if (ledger.date !== date) return { date, sent: [] };
    return { date, sent: Array.isArray(ledger.sent) ? ledger.sent : [] };
  } catch {
    return { date, sent: [] };
  }
}

async function writeLedger(ledger: NotificationLedger) {
  await mkdir(process.cwd(), { recursive: true });
  await writeFile(ledgerPath, JSON.stringify(ledger, null, 2));
}

function userThreshold(user: UserConfig, symbol?: string): number | null {
  const threshold = user.oi_threshold;
  if (typeof threshold === "number") return threshold;
  if (threshold && symbol) return threshold[symbol] ?? null;
  return null;
}

function shouldSendToUser(user: UserConfig, symbol?: string, oiPct?: number): boolean {
  if (typeof oiPct !== "number" || !symbol) return true;
  const threshold = userThreshold(user, symbol);
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0) return false;
  return Math.abs(oiPct) >= threshold;
}

function alertLedgerKey(user: UserConfig, request: SendRequest): string {
  const threshold = userThreshold(user, request.symbol);

  if (
    request.symbol &&
    request.strike != null &&
    request.type &&
    typeof request.oiPct === "number" &&
    typeof threshold === "number" &&
    threshold > 0
  ) {
    const bucket = Math.floor(Math.abs(request.oiPct) / threshold);
    return `${request.symbol}:${request.strike}:${request.type}:${bucket}`;
  }

  return request.notificationKey ?? request.alertKey ?? request.message ?? "unknown";
}

function ledgerKey(user: UserConfig, request: SendRequest): string {
  return `${user.telegram_chat_id}:${alertLedgerKey(user, request)}`;
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
  const { message, symbol, oiPct } = payload;

  if (!message) {
    return Response.json({ error: "Missing message" }, { status: 400 });
  }

  return enqueue(async () => {
    const users = getUsers();
    const ledger = await readLedger();
    const sentKeys = new Set(ledger.sent);
    const results = [];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const user of users) {
      if (!shouldSendToUser(user, symbol, oiPct)) {
        skipped += 1;
        results.push({ chat_id: user.telegram_chat_id, status: "below-threshold" });
        continue;
      }

      const sentKey = ledgerKey(user, payload);
      if (sentKeys.has(sentKey)) {
        skipped += 1;
        results.push({ chat_id: user.telegram_chat_id, status: "duplicate" });
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
        sentKeys.add(sentKey);
        results.push({ chat_id: user.telegram_chat_id, status: "sent", body });
      } catch {
        failed += 1;
        results.push({ chat_id: user.telegram_chat_id, status: "failed" });
      }
    }

    await writeLedger({ date: ledger.date, sent: [...sentKeys] });

    return Response.json({ ok: true, sent, skipped, failed, results });
  });
}
