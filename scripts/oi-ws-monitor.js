/**
 * Real-time OI Monitor using Upstox WebSocket + Telegram Alerts
 *
 * Run: node scripts/oi-ws-monitor.js
 *
 * Flow:
 * 1. At market open (9:15 AM IST), fetch prev_oi via REST for all strikes
 * 2. Connect to Upstox WebSocket for real-time OI + LTP updates
 * 3. On each tick, calculate OI% and send Telegram alerts per-user
 * 4. At market close (3:30 PM IST), disconnect WebSocket
 * 5. Weekends: do nothing
 */

const WebSocket = require("ws");
const protobuf = require("protobufjs");
const fs = require("fs");
const path = require("path");

// ── Config ──────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "..", "src", "json", "data.json");
const PROTO_PATH = path.join(__dirname, "MarketDataFeed.proto");
const LEDGER_PATH = path.join(__dirname, "..", "notification-ledger.json");

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

const config = loadConfig();
const UPSTOX_TOKEN = config.upstox_access_token;
const TELEGRAM_BOT_TOKEN = config.telegram_bot_token;
const BASE = "https://api.upstox.com/v2";

const SYMBOLS = [
  { name: "NIFTY", key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
  { name: "SENSEX", key: "BSE_INDEX|SENSEX" },
];

const MIN_OI_GAP = 33; // default, overridden per-user by oi_min_gap

// ── State ───────────────────────────────────────────────────────────────
let prevOiData = {}; // instrumentKey -> { oi: number } (yesterday's closing OI)
let liveData = {};   // instrumentKey -> { oi, ltp, strike, symbol, type(CE/PE) }
let instrumentMap = {}; // instrumentKey -> { strike, symbol, type }
let ws = null;
let FeedResponse = null; // protobuf type
let connected = false;
let lastDate = "";

// Per-user tracking: "chatId:SYMBOL:STRIKE:TYPE" -> lastSentOiPct
let userLastSent = {};

// ── Helpers ─────────────────────────────────────────────────────────────
function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function todayStr() {
  const d = istNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isMarketOpen() {
  const now = istNow();
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // weekend
  const h = now.getHours();
  const m = now.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function isBeforeMarketOpen() {
  const now = istNow();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins < 9 * 60 + 15;
}

function timeStr() {
  const now = istNow();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
}

function formatOi(n) {
  if (Math.abs(n) >= 1e7) return (n / 1e7).toFixed(2) + "Cr";
  if (Math.abs(n) >= 1e5) return (n / 1e5).toFixed(2) + "L";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return String(n);
}

function upstoxHeaders() {
  return {
    Authorization: `Bearer ${UPSTOX_TOKEN}`,
    Accept: "application/json",
  };
}

function getUsers() {
  const cfg = loadConfig();
  return (cfg.users || []).filter((u) => u.active !== false);
}

function getUserThreshold(user, symbol) {
  const t = user.oi_threshold;
  if (typeof t === "number") return t;
  if (t && typeof t === "object") return t[symbol] ?? null;
  return null;
}

function getUserMinGap(user) {
  return typeof user.oi_min_gap === "number" ? user.oi_min_gap : MIN_OI_GAP;
}

// ── Ledger (file-based, shared with Next.js API) ────────────────────────
function readLedger() {
  const date = todayStr();
  if (!fs.existsSync(LEDGER_PATH)) return { date, sent: {} };
  try {
    const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8"));
    if (ledger.date !== date) return { date, sent: {} };
    return { date, sent: ledger.sent || {} };
  } catch {
    return { date, sent: {} };
  }
}

function writeLedger(ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// ── Telegram ────────────────────────────────────────────────────────────
async function sendTelegram(message, chatId) {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
    const body = await res.json();
    if (!body.ok) console.log(`  [!] Telegram error for ${chatId}: ${body.description}`);
    return body.ok;
  } catch (e) {
    console.log(`  [!] Telegram error: ${e.message}`);
    return false;
  }
}

// ── REST API: Fetch prev_oi for all strikes ─────────────────────────────
async function fetchWithAuth(url) {
  const res = await fetch(url, { headers: upstoxHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getNearestExpiry(instrumentKey) {
  const data = await fetchWithAuth(`${BASE}/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
  const contracts = data.data || [];
  const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
  return { expiry: expiries[0] || null, contracts };
}

async function fetchPrevOiForSymbol(sym) {
  console.log(`  Fetching prev_oi for ${sym.name}...`);
  const { expiry, contracts } = await getNearestExpiry(sym.key);
  if (!expiry) {
    console.log(`  [!] No expiry found for ${sym.name}`);
    return [];
  }

  // Get option chain with prev_oi
  const chainData = await fetchWithAuth(
    `${BASE}/option/chain?instrument_key=${encodeURIComponent(sym.key)}&expiry_date=${expiry}`
  );
  const chain = chainData.data || [];

  // Find instrument keys from contracts for this expiry
  const expiryContracts = contracts.filter((c) => c.expiry === expiry);
  const instrumentKeys = [];

  for (const item of chain) {
    const strike = item.strike_price;

    for (const [optType, optKey] of [["CE", "call_options"], ["PE", "put_options"]]) {
      const market = item[optKey]?.market_data || {};
      const prevOi = market.prev_oi || 0;
      const currentOi = market.oi || 0;
      const ltp = market.ltp || 0;

      // Find matching contract instrument key
      const contract = expiryContracts.find(
        (c) => c.strike_price === strike && c.instrument_type === optType
      );

      if (contract && contract.instrument_key) {
        const iKey = contract.instrument_key;
        prevOiData[iKey] = { prevOi, currentOi };
        instrumentMap[iKey] = { strike, symbol: sym.name, type: optType };
        liveData[iKey] = { oi: currentOi, ltp, strike, symbol: sym.name, type: optType };
        instrumentKeys.push(iKey);
      }
    }
  }

  console.log(`  ${sym.name}: ${instrumentKeys.length} instruments loaded (expiry: ${expiry})`);
  return instrumentKeys;
}

async function fetchAllPrevOi() {
  console.log("\nFetching prev_oi data via REST API...");
  const allKeys = [];

  for (const sym of SYMBOLS) {
    try {
      const keys = await fetchPrevOiForSymbol(sym);
      allKeys.push(...keys);
    } catch (e) {
      console.log(`  [!] Error fetching ${sym.name}: ${e.message}`);
    }
  }

  console.log(`Total instruments: ${allKeys.length}\n`);
  return allKeys;
}

// ── Spot prices via REST ────────────────────────────────────────────────
let spotPrices = {}; // symbol name -> price

async function fetchSpotPrices() {
  const keys = SYMBOLS.map((s) => s.key).join(",");
  try {
    const data = await fetchWithAuth(`${BASE}/market-quote/quotes?instrument_key=${encodeURIComponent(keys)}`);
    const quotes = data.data || {};
    for (const [qKey, val] of Object.entries(quotes)) {
      const sym = SYMBOLS.find((s) => qKey.includes(s.key));
      if (sym) spotPrices[sym.name] = val.last_price || 0;
    }
  } catch {
    // ignore
  }
}

// ── Alert Logic ─────────────────────────────────────────────────────────
function checkAlertForTick(instrumentKey, currentOi, ltp) {
  const info = instrumentMap[instrumentKey];
  if (!info) return;

  const prev = prevOiData[instrumentKey];
  if (!prev || !prev.prevOi || prev.prevOi === 0) return;

  const oiChange = currentOi - prev.prevOi;
  const oiPct = (oiChange / prev.prevOi) * 100;

  const users = getUsers();
  const ledger = readLedger();
  let ledgerChanged = false;

  for (const user of users) {
    const threshold = getUserThreshold(user, info.symbol);
    if (typeof threshold !== "number" || threshold <= 0) continue;

    // Rule 1: must be >= threshold
    if (Math.abs(oiPct) < threshold) continue;

    const chatId = user.telegram_chat_id;
    const ledgerKey = `${chatId}:${info.symbol}:${info.strike}:${info.type}`;

    // Rule 2 & 3: check gap from last sent
    const lastEntry = ledger.sent[ledgerKey];
    if (lastEntry) {
      const minGap = getUserMinGap(user);
      const gap = Math.abs(oiPct - lastEntry.oiPct);
      if (gap < minGap) continue;
    }

    // Send notification
    const dir = oiPct > 0 ? "\u{1F4C8}" : "\u{1F4C9}";
    const spot = spotPrices[info.symbol] || 0;
    const msg =
      `${dir} <b>${info.symbol} ${info.strike} ${info.type}</b>\n` +
      `OI% Change: <b>${oiPct.toFixed(2)}%</b>\n` +
      `OI: ${formatOi(currentOi)} | Change: ${formatOi(oiChange)}\n` +
      `Prev OI: ${formatOi(prev.prevOi)}\n` +
      `LTP: ${ltp}\n` +
      (spot ? `Spot: ${spot.toLocaleString("en-IN")}\n` : "");

    sendTelegram(msg, chatId).then((ok) => {
      if (ok) {
        console.log(`  [ALERT -> ${user.name || chatId}] ${info.symbol} ${info.strike} ${info.type} | OI%: ${oiPct.toFixed(2)}%`);
      }
    });

    // Record in ledger
    ledger.sent[ledgerKey] = { oiPct, time: new Date().toISOString() };
    ledgerChanged = true;
  }

  if (ledgerChanged) {
    writeLedger(ledger);
  }
}

// ── WebSocket Connection ────────────────────────────────────────────────
async function loadProtobuf() {
  const root = await protobuf.load(PROTO_PATH);
  FeedResponse = root.lookupType(
    "com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse"
  );
  console.log("Protobuf schema loaded.");
}

async function getWebSocketUrl() {
  const res = await fetch(`${BASE}/feed/market-data-feed/authorize`, {
    headers: upstoxHeaders(),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.authorized_redirect_uri;
}

function connectWebSocket(instrumentKeys) {
  return new Promise(async (resolve, reject) => {
    try {
      const wsUrl = await getWebSocketUrl();
      console.log("Connecting to WebSocket...");

      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${UPSTOX_TOKEN}`,
          Accept: "*/*",
        },
      });

      ws.on("open", () => {
        console.log("WebSocket connected!");
        connected = true;

        // Subscribe in batches of 100 (Upstox limit)
        const batchSize = 100;
        for (let i = 0; i < instrumentKeys.length; i += batchSize) {
          const batch = instrumentKeys.slice(i, i + batchSize);
          const subMsg = JSON.stringify({
            guid: `sub-${Date.now()}-${i}`,
            method: "sub",
            data: {
              mode: "full",
              instrumentKeys: batch,
            },
          });
          ws.send(Buffer.from(subMsg));
        }
        console.log(`Subscribed to ${instrumentKeys.length} instruments.`);
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const decoded = FeedResponse.decode(new Uint8Array(data));
          const obj = FeedResponse.toObject(decoded, { defaults: true });

          if (obj.type === 1 && obj.feeds) {
            // live_feed
            for (const [iKey, feed] of Object.entries(obj.feeds)) {
              let oi = 0;
              let ltp = 0;

              if (feed.fullFeed?.marketFF) {
                const mf = feed.fullFeed.marketFF;
                oi = mf.oi || 0;
                ltp = mf.ltpc?.ltp || 0;
              } else if (feed.firstLevelWithGreeks) {
                const flg = feed.firstLevelWithGreeks;
                oi = flg.oi || 0;
                ltp = flg.ltpc?.ltp || 0;
              } else if (feed.ltpc) {
                ltp = feed.ltpc.ltp || 0;
              }

              if (instrumentMap[iKey]) {
                const prev = liveData[iKey];
                liveData[iKey] = {
                  ...liveData[iKey],
                  oi: oi || prev?.oi || 0,
                  ltp: ltp || prev?.ltp || 0,
                };

                // Check alert on OI change
                if (oi > 0) {
                  checkAlertForTick(iKey, oi, ltp || prev?.ltp || 0);
                }
              }
            }
          }
        } catch (e) {
          // Ignore decode errors for non-protobuf messages
        }
      });

      ws.on("close", () => {
        console.log(`[${timeStr()}] WebSocket disconnected.`);
        connected = false;
        ws = null;
      });

      ws.on("error", (err) => {
        console.log(`[!] WebSocket error: ${err.message}`);
        connected = false;
      });
    } catch (e) {
      reject(e);
    }
  });
}

function disconnectWebSocket() {
  if (ws) {
    console.log(`[${timeStr()}] Disconnecting WebSocket...`);
    ws.close();
    ws = null;
    connected = false;
  }
}

// ── Main Loop ───────────────────────────────────────────────────────────
async function startSession() {
  console.log(`\n[${timeStr()}] Starting market session...`);

  // Reset daily state
  prevOiData = {};
  liveData = {};
  instrumentMap = {};
  userLastSent = {};

  // Fetch prev_oi via REST
  const instrumentKeys = await fetchAllPrevOi();
  if (instrumentKeys.length === 0) {
    console.log("[!] No instruments found. Retrying in 60s...");
    return false;
  }

  // Fetch spot prices
  await fetchSpotPrices();

  // Load protobuf if not loaded
  if (!FeedResponse) await loadProtobuf();

  // Connect WebSocket
  await connectWebSocket(instrumentKeys);

  // Notify users
  const users = getUsers();
  for (const user of users) {
    const t = user.oi_threshold;
    let threshStr = "";
    if (typeof t === "object") {
      threshStr = Object.entries(t).map(([k, v]) => `${k}: ${v}%`).join(", ");
    } else {
      threshStr = `${t}%`;
    }
    sendTelegram(
      `\u{1F6A8} OI Monitor (Real-time WebSocket)\n` +
      `Watching: NIFTY, BANKNIFTY, SENSEX\n` +
      `Your thresholds: ${threshStr}\n` +
      `Min gap: ${getUserMinGap(user)}%\n` +
      `Real-time updates active!`,
      user.telegram_chat_id
    );
  }

  return true;
}

async function main() {
  console.log("=".repeat(55));
  console.log("  OI Monitor (WebSocket) - Upstox + Telegram");
  console.log("=".repeat(55));

  const users = getUsers();
  console.log(`  Symbols  : ${SYMBOLS.map((s) => s.name).join(", ")}`);
  console.log(`  Users    : ${users.length}`);
  for (const u of users) {
    const t = u.oi_threshold;
    if (typeof t === "object") {
      const parts = Object.entries(t).map(([k, v]) => `${k}: ${v}%`).join(", ");
      console.log(`    - ${u.name} (${parts}, gap: ${getUserMinGap(u)}%)`);
    } else {
      console.log(`    - ${u.name} (threshold: ${t}%, gap: ${getUserMinGap(u)}%)`);
    }
  }
  console.log("  Mode     : WebSocket (real-time)");
  console.log("  Hours    : 9:15 AM - 3:30 PM IST (Mon-Fri)");
  console.log("=".repeat(55));

  // Test Upstox connection
  console.log("\nTesting Upstox connection...");
  try {
    const data = await fetchWithAuth(`${BASE}/user/profile`);
    const d = data.data || {};
    console.log(`Connected: ${d.user_name} (${d.user_id})`);
  } catch (e) {
    console.log(`[!] Connection failed: ${e.message}`);
    return;
  }

  // Periodically refresh spot prices (every 30s)
  setInterval(() => {
    if (connected) fetchSpotPrices().catch(() => {});
  }, 30000);

  // Main scheduler loop
  let sessionActive = false;

  setInterval(async () => {
    const today = todayStr();

    // Reset on new day
    if (today !== lastDate) {
      lastDate = today;
      sessionActive = false;
      disconnectWebSocket();
      console.log(`\n--- New day: ${today} ---`);
    }

    if (isMarketOpen() && !sessionActive && !connected) {
      // Market just opened — start session
      try {
        sessionActive = await startSession();
      } catch (e) {
        console.log(`[!] Session start error: ${e.message}`);
        sessionActive = false;
      }
    } else if (!isMarketOpen() && connected) {
      // Market closed — disconnect
      console.log(`\n[${timeStr()}] Market closed. Disconnecting...`);
      disconnectWebSocket();
      sessionActive = false;

      const users = getUsers();
      for (const user of users) {
        sendTelegram(
          `\u{1F6D1} OI Monitor stopped. Market closed.\nWill resume next trading day at 9:15 AM IST.`,
          user.telegram_chat_id
        );
      }
    }
  }, 10000); // check every 10 seconds

  // If market is already open, start immediately
  if (isMarketOpen()) {
    try {
      sessionActive = await startSession();
      lastDate = todayStr();
    } catch (e) {
      console.log(`[!] Initial session error: ${e.message}`);
    }
  } else {
    console.log(`\nMarket is closed. Waiting for 9:15 AM IST (Mon-Fri)...`);
    lastDate = todayStr();
  }
}

main().catch(console.error);
