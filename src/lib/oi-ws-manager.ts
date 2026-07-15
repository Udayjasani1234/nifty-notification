/**
 * Singleton WebSocket manager for Upstox real-time OI data.
 * - Connects to Upstox WebSocket during market hours
 * - Broadcasts live data to SSE clients
 * - Sends Telegram alerts per-user with threshold + gap logic
 */

import WebSocket from "ws";
import protobuf from "protobufjs";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

// ── Types ───────────────────────────────────────────────────────────────
interface UserConfig {
  name?: string;
  telegram_chat_id: string;
  oi_threshold?: Record<string, number> | number;
  oi_min_gap?: number;
  active?: boolean;
}

interface StrikeData {
  strike: number;
  symbol: string;
  type: string; // CE or PE
  oi: number;
  prevOi: number;
  oiChange: number;
  oiPct: number;
  ltp: number;
}

interface OiChainSnapshot {
  symbol: string;
  expiry: string;
  strikes: {
    strike: number;
    ce: { ltp: number; oi: number; prevOi: number; oiChange: number; oiPct: number };
    pe: { ltp: number; oi: number; prevOi: number; oiChange: number; oiPct: number };
  }[];
}

type SSEWriter = (data: string) => void;

// ── Paths ───────────────────────────────────────────────────────────────
const CONFIG_PATH = join(process.cwd(), "src", "json", "data.json");
const PROTO_PATH = join(process.cwd(), "scripts", "MarketDataFeed.proto");
const LEDGER_PATH = join(process.cwd(), "notification-ledger.json");
const BASE = "https://api.upstox.com/v2";

const SYMBOLS = [
  { name: "NIFTY", key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
  { name: "SENSEX", key: "BSE_INDEX|SENSEX" },
];

// ── Helpers ─────────────────────────────────────────────────────────────
function istNow(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function todayStr(): string {
  const d = istNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isMarketOpen(): boolean {
  const now = istNow();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function timeStr(): string {
  const now = istNow();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function formatOi(n: number): string {
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(2) + "L";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function getUsers(): UserConfig[] {
  const cfg = loadConfig();
  return (cfg.users ?? []).filter((u: UserConfig) => u.active !== false);
}

function getUserThreshold(user: UserConfig, symbol: string): number | null {
  const t = user.oi_threshold;
  if (typeof t === "number") return t;
  if (t && typeof t === "object") return t[symbol] ?? null;
  return null;
}

function getUserMinGap(user: UserConfig): number {
  return typeof user.oi_min_gap === "number" ? user.oi_min_gap : 33;
}

// ── Manager Class ───────────────────────────────────────────────────────
class OiWsManager {
  private ws: WebSocket | null = null;
  private FeedResponse: protobuf.Type | null = null;
  private connected = false;
  private initialized = false;
  private sessionActive = false;
  private lastDate = "";

  // Data state
  private prevOiData: Record<string, { prevOi: number }> = {};
  private liveData: Record<string, StrikeData> = {};
  private instrumentMap: Record<string, { strike: number; symbol: string; type: string }> = {};
  private expiryMap: Record<string, string> = {}; // symbol -> expiry
  private spotPrices: Record<string, number> = {};
  private token = "";
  private telegramToken = "";

  // In-memory dedup: "chatId:SYMBOL:STRIKE:TYPE" -> last sent oiPct
  private sentAlerts: Record<string, number> = {};

  // SSE clients
  private clients: Set<SSEWriter> = new Set();

  // Broadcast throttle
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  addClient(writer: SSEWriter) {
    this.clients.add(writer);
  }

  removeClient(writer: SSEWriter) {
    this.clients.delete(writer);
  }

  getSnapshot(): { data: OiChainSnapshot[]; marketOpen: boolean; connected: boolean } {
    return {
      data: this.buildChainData(),
      marketOpen: isMarketOpen(),
      connected: this.connected,
    };
  }

  private buildChainData(): OiChainSnapshot[] {
    const symbolStrikes: Record<string, Record<number, { ce: StrikeData | null; pe: StrikeData | null }>> = {};

    for (const data of Object.values(this.liveData)) {
      if (!symbolStrikes[data.symbol]) symbolStrikes[data.symbol] = {};
      if (!symbolStrikes[data.symbol][data.strike]) {
        symbolStrikes[data.symbol][data.strike] = { ce: null, pe: null };
      }
      if (data.type === "CE") symbolStrikes[data.symbol][data.strike].ce = data;
      else symbolStrikes[data.symbol][data.strike].pe = data;
    }

    const result: OiChainSnapshot[] = [];
    for (const sym of SYMBOLS) {
      const strikes = symbolStrikes[sym.name];
      if (!strikes) continue;

      const empty = { ltp: 0, oi: 0, prevOi: 0, oiChange: 0, oiPct: 0 };
      const strikeList = Object.keys(strikes)
        .map(Number)
        .sort((a, b) => a - b)
        .map((strike) => {
          const s = strikes[strike];
          const ce = s.ce
            ? { ltp: s.ce.ltp, oi: s.ce.oi, prevOi: s.ce.prevOi, oiChange: s.ce.oiChange, oiPct: s.ce.oiPct }
            : empty;
          const pe = s.pe
            ? { ltp: s.pe.ltp, oi: s.pe.oi, prevOi: s.pe.prevOi, oiChange: s.pe.oiChange, oiPct: s.pe.oiPct }
            : empty;
          return { strike, ce, pe };
        });

      result.push({ symbol: sym.name, expiry: this.expiryMap[sym.name] ?? "", strikes: strikeList });
    }

    return result;
  }

  private broadcast() {
    if (!this.dirty || this.clients.size === 0) return;
    this.dirty = false;
    const snapshot = JSON.stringify(this.getSnapshot());
    for (const writer of this.clients) {
      try {
        writer(snapshot);
      } catch {
        this.clients.delete(writer);
      }
    }
  }

  // ── Ledger ──────────────────────────────────────────────────────────
  private readLedger(): { date: string; sent: Record<string, { oiPct: number; time: string }> } {
    const date = todayStr();
    if (!existsSync(LEDGER_PATH)) return { date, sent: {} };
    try {
      const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf-8"));
      if (ledger.date !== date) return { date, sent: {} };
      return { date, sent: ledger.sent ?? {} };
    } catch {
      return { date, sent: {} };
    }
  }

  private writeLedger(ledger: { date: string; sent: Record<string, { oiPct: number; time: string }> }) {
    writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  }

  // ── Telegram ────────────────────────────────────────────────────────
  private async sendTelegram(message: string, chatId: string): Promise<boolean> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.telegramToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
      });
      const body = await res.json();
      if (!body.ok) console.log(`  [!] Telegram error for ${chatId}: ${body.description}`);
      return body.ok;
    } catch (e: unknown) {
      console.log(`  [!] Telegram error: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  }

  // ── Alert Logic ─────────────────────────────────────────────────────
  private checkAlertForTick(instrumentKey: string, currentOi: number, ltp: number) {
    const info = this.instrumentMap[instrumentKey];
    if (!info) return;

    const prev = this.prevOiData[instrumentKey];
    if (!prev || !prev.prevOi || prev.prevOi === 0) return;

    const oiChange = currentOi - prev.prevOi;
    const oiPct = (oiChange / prev.prevOi) * 100;

    const users = getUsers();

    for (const user of users) {
      const threshold = getUserThreshold(user, info.symbol);
      if (typeof threshold !== "number" || threshold <= 0) continue;
      if (Math.abs(oiPct) < threshold) continue;

      const chatId = user.telegram_chat_id;
      const alertKey = `${chatId}:${info.symbol}:${info.strike}:${info.type}`;

      // Check in-memory dedup
      const lastSentPct = this.sentAlerts[alertKey];
      if (lastSentPct !== undefined) {
        const minGap = getUserMinGap(user);
        const gap = Math.abs(oiPct - lastSentPct);
        if (gap < minGap) continue;
      }

      // Mark as sent IMMEDIATELY (before async Telegram call) to prevent duplicates
      this.sentAlerts[alertKey] = oiPct;

      const dir = oiPct > 0 ? "\u{1F4C8}" : "\u{1F4C9}";
      const spot = this.spotPrices[info.symbol] || 0;
      const msg =
        `${dir} <b>${info.symbol} ${info.strike} ${info.type}</b>\n` +
        `OI% Change: <b>${oiPct.toFixed(2)}%</b>\n` +
        `OI: ${formatOi(currentOi)} | Change: ${formatOi(oiChange)}\n` +
        `Prev OI: ${formatOi(prev.prevOi)}\n` +
        `LTP: ${ltp}\n` +
        (spot ? `Spot: ${spot.toLocaleString("en-IN")}\n` : "");

      this.sendTelegram(msg, chatId).then((ok) => {
        if (ok) {
          console.log(`  [ALERT -> ${user.name || chatId}] ${info.symbol} ${info.strike} ${info.type} | OI%: ${oiPct.toFixed(2)}%`);
          // Also persist to file ledger
          this.persistToLedger(alertKey, oiPct);
        }
      });
    }
  }

  private persistToLedger(alertKey: string, oiPct: number) {
    try {
      const ledger = this.readLedger();
      ledger.sent[alertKey] = { oiPct, time: new Date().toISOString() };
      this.writeLedger(ledger);
    } catch { /* ignore */ }
  }

  // ── REST API Fetching ───────────────────────────────────────────────
  private headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  private async fetchJson(url: string) {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private async fetchPrevOi(): Promise<string[]> {
    console.log("\n[OI-WS] Fetching prev_oi data via REST API...");
    const allKeys: string[] = [];

    for (const sym of SYMBOLS) {
      try {
        // Get nearest expiry
        const contractData = await this.fetchJson(`${BASE}/option/contract?instrument_key=${encodeURIComponent(sym.key)}`);
        const contracts: { expiry: string; strike_price: number; instrument_type: string; instrument_key: string }[] = contractData.data ?? [];
        const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
        const expiry = expiries[0];
        if (!expiry) continue;

        this.expiryMap[sym.name] = expiry;

        // Get option chain with prev_oi
        const chainData = await this.fetchJson(`${BASE}/option/chain?instrument_key=${encodeURIComponent(sym.key)}&expiry_date=${expiry}`);
        const chain = chainData.data ?? [];
        const expiryContracts = contracts.filter((c) => c.expiry === expiry);

        for (const item of chain) {
          const strike = item.strike_price;

          for (const [optType, optKey] of [["CE", "call_options"], ["PE", "put_options"]] as const) {
            const market = item[optKey]?.market_data ?? {};
            const prevOi = market.prev_oi || 0;
            const currentOi = market.oi || 0;
            const ltp = market.ltp || 0;

            const contract = expiryContracts.find((c) => c.strike_price === strike && c.instrument_type === optType);
            if (contract?.instrument_key) {
              const iKey = contract.instrument_key;
              this.prevOiData[iKey] = { prevOi };
              this.instrumentMap[iKey] = { strike, symbol: sym.name, type: optType };

              const oiChange = currentOi - prevOi;
              const oiPct = prevOi !== 0 ? parseFloat(((oiChange / prevOi) * 100).toFixed(2)) : 0;

              this.liveData[iKey] = { oi: currentOi, ltp, strike, symbol: sym.name, type: optType, prevOi, oiChange, oiPct };
              allKeys.push(iKey);
            }
          }
        }

        console.log(`  [OI-WS] ${sym.name}: ${expiryContracts.length} instruments (expiry: ${expiry})`);
      } catch (e: unknown) {
        console.log(`  [OI-WS] Error fetching ${sym.name}: ${e instanceof Error ? e.message : e}`);
      }
    }

    console.log(`[OI-WS] Total instruments: ${allKeys.length}`);
    this.dirty = true;
    return allKeys;
  }

  private async fetchSpotPrices() {
    const keys = SYMBOLS.map((s) => s.key).join(",");
    try {
      const data = await this.fetchJson(`${BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(keys)}`);
      const quotes = data.data ?? {};
      for (const [qKey, val] of Object.entries(quotes)) {
        const sym = SYMBOLS.find((s) => qKey.includes(s.key));
        if (sym) this.spotPrices[sym.name] = (val as { last_price?: number }).last_price ?? 0;
      }
    } catch { /* ignore */ }
  }

  // ── WebSocket ───────────────────────────────────────────────────────
  private async loadProtobuf() {
    if (this.FeedResponse) return;
    const root = await protobuf.load(PROTO_PATH);
    this.FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
    console.log("[OI-WS] Protobuf schema loaded.");
  }

  private async getWebSocketUrl(): Promise<string> {
    const res = await fetch("https://api.upstox.com/v3/feed/market-data-feed/authorize", { headers: this.headers() });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    const data = await res.json();
    return data.data.authorizedRedirectUri;
  }

  private async connectWebSocket(instrumentKeys: string[]) {
    const wsUrl = await this.getWebSocketUrl();
    console.log("[OI-WS] Connecting to WebSocket...");

    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "*/*" },
    });

    this.ws.on("open", () => {
      console.log("[OI-WS] WebSocket connected!");
      this.connected = true;

      const batchSize = 100;
      for (let i = 0; i < instrumentKeys.length; i += batchSize) {
        const batch = instrumentKeys.slice(i, i + batchSize);
        this.ws!.send(Buffer.from(JSON.stringify({
          guid: `sub-${Date.now()}-${i}`,
          method: "sub",
          data: { mode: "full", instrumentKeys: batch },
        })));
      }
      console.log(`[OI-WS] Subscribed to ${instrumentKeys.length} instruments.`);
    });

    this.ws.on("message", (data: Buffer) => {
      if (!this.FeedResponse) return;
      try {
        const decoded = this.FeedResponse.decode(new Uint8Array(data));
        const obj = this.FeedResponse.toObject(decoded, { defaults: true }) as {
          type: number;
          feeds: Record<string, {
            fullFeed?: { marketFF?: { oi?: number; ltpc?: { ltp?: number } } };
            firstLevelWithGreeks?: { oi?: number; ltpc?: { ltp?: number } };
            ltpc?: { ltp?: number };
          }>;
        };

        if (obj.type === 1 && obj.feeds) {
          for (const [iKey, feed] of Object.entries(obj.feeds)) {
            let oi = 0, ltp = 0;

            if (feed.fullFeed?.marketFF) {
              oi = feed.fullFeed.marketFF.oi || 0;
              ltp = feed.fullFeed.marketFF.ltpc?.ltp || 0;
            } else if (feed.firstLevelWithGreeks) {
              oi = feed.firstLevelWithGreeks.oi || 0;
              ltp = feed.firstLevelWithGreeks.ltpc?.ltp || 0;
            } else if (feed.ltpc) {
              ltp = feed.ltpc.ltp || 0;
            }

            const info = this.instrumentMap[iKey];
            if (!info) continue;

            const prev = this.liveData[iKey];
            const prevOi = this.prevOiData[iKey]?.prevOi ?? 0;
            const newOi = oi || prev?.oi || 0;
            const newLtp = ltp || prev?.ltp || 0;
            const oiChange = newOi - prevOi;
            const oiPct = prevOi !== 0 ? parseFloat(((oiChange / prevOi) * 100).toFixed(2)) : 0;

            this.liveData[iKey] = {
              ...info,
              oi: newOi,
              ltp: newLtp,
              prevOi,
              oiChange,
              oiPct,
            };
            this.dirty = true;

            // Only check alerts when OI actually changed
            if (oi > 0 && oi !== (prev?.oi ?? 0)) {
              this.checkAlertForTick(iKey, oi, newLtp);
            }
          }
        }
      } catch { /* ignore decode errors */ }
    });

    this.ws.on("close", () => {
      console.log(`[${timeStr()}] [OI-WS] WebSocket disconnected.`);
      this.connected = false;
      this.ws = null;
    });

    this.ws.on("error", (err: Error) => {
      console.log(`[OI-WS] WebSocket error: ${err.message}`);
      this.connected = false;
    });
  }

  private disconnectWebSocket() {
    if (this.ws) {
      console.log(`[${timeStr()}] [OI-WS] Disconnecting WebSocket...`);
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  // ── Session Management ──────────────────────────────────────────────
  private async startSession(): Promise<boolean> {
    console.log(`\n[${timeStr()}] [OI-WS] Starting market session...`);

    this.prevOiData = {};
    this.liveData = {};
    this.instrumentMap = {};
    this.expiryMap = {};
    this.sentAlerts = {};

    // Load existing ledger into memory (in case of restart mid-day)
    const ledger = this.readLedger();
    for (const [key, entry] of Object.entries(ledger.sent)) {
      this.sentAlerts[key] = entry.oiPct;
    }

    const cfg = loadConfig();
    this.token = cfg.upstox_access_token;
    this.telegramToken = cfg.telegram_bot_token;

    const instrumentKeys = await this.fetchPrevOi();
    if (instrumentKeys.length === 0) {
      console.log("[OI-WS] No instruments found. Retrying in 60s...");
      return false;
    }

    await this.fetchSpotPrices();
    await this.loadProtobuf();
    await this.connectWebSocket(instrumentKeys);

    return true;
  }

  // ── Init (called once) ──────────────────────────────────────────────
  init() {
    if (this.initialized) return;
    this.initialized = true;

    const cfg = loadConfig();
    this.token = cfg.upstox_access_token;
    this.telegramToken = cfg.telegram_bot_token;

    console.log("[OI-WS] Manager initialized.");

    // Broadcast throttle: send updates to SSE clients every 1 second
    this.broadcastTimer = setInterval(() => this.broadcast(), 1000);

    // Spot price refresh every 30s
    setInterval(() => {
      if (this.connected) this.fetchSpotPrices().catch(() => {});
    }, 30000);

    // Market hours scheduler
    setInterval(async () => {
      const today = todayStr();
      if (today !== this.lastDate) {
        this.lastDate = today;
        this.sessionActive = false;
        this.disconnectWebSocket();
        console.log(`\n[OI-WS] New day: ${today}`);
      }

      if (isMarketOpen() && !this.sessionActive && !this.connected) {
        try {
          this.sessionActive = await this.startSession();
        } catch (e: unknown) {
          console.log(`[OI-WS] Session start error: ${e instanceof Error ? e.message : e}`);
          this.sessionActive = false;
        }
      } else if (!isMarketOpen() && this.connected) {
        console.log(`\n[${timeStr()}] [OI-WS] Market closed. Disconnecting...`);
        this.disconnectWebSocket();
        this.sessionActive = false;

        console.log("[OI-WS] Market closed. Session ended.");
      }
    }, 10000);

    // If market is already open, start immediately
    if (isMarketOpen()) {
      this.lastDate = todayStr();
      this.startSession().then((ok) => {
        this.sessionActive = ok;
      }).catch((e) => {
        console.log(`[OI-WS] Initial session error: ${e.message}`);
      });
    } else {
      this.lastDate = todayStr();
      console.log("[OI-WS] Market is closed. Waiting for 9:15 AM IST (Mon-Fri)...");
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────
let instance: OiWsManager | null = null;

export function getManager(): OiWsManager {
  if (!instance) instance = new OiWsManager();
  return instance;
}
