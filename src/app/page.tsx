"use client";

import { useState, useEffect, useRef, useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────────────
interface MarketData {
  symbol: string;
  name: string;
  price: number;
  open: number;
  prevClose: number;
  change: number;
  changePct: number;
  lastUpdated: Date;
}

interface OiStrike {
  strike: number;
  ce: { ltp: number; oi: number; prevOi: number; oiChange: number; oiPct: number };
  pe: { ltp: number; oi: number; prevOi: number; oiChange: number; oiPct: number };
}

interface OiChainData {
  symbol: string;
  expiry: string;
  strikes: OiStrike[];
}

interface OiAlert {
  id: number;
  time: Date;
  symbol: string;
  strike: number;
  type: "CE" | "PE";
  oiPct: number;
  oi: number;
  oiChange: number;
  ltp: number;
}

interface AlertUserConfig {
  name: string;
  oi_threshold: Record<string, number> | number;
}

// ── Helpers ────────────────────────────────────────────────────────────
function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true, timeZone: "Asia/Kolkata",
  });
}

function formatNum(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatOi(n: number): string {
  if (Math.abs(n) >= 1_00_000) return `${(n / 1_00_000).toFixed(2)}L`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function thresholdForUser(user: AlertUserConfig, symbol: string): number | null {
  if (typeof user.oi_threshold === "number") return user.oi_threshold;
  return user.oi_threshold?.[symbol] ?? null;
}

function lowestThreshold(users: AlertUserConfig[], symbol: string): number {
  const thresholds = users
    .map((user) => thresholdForUser(user, symbol))
    .filter((threshold): threshold is number => typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0);

  return thresholds.length > 0 ? Math.min(...thresholds) : Infinity;
}

async function fetchMarketData(symbol: string, name: string): Promise<MarketData> {
  const res = await fetch(`/api/market-data?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  const meta = json.chart.result[0].meta;
  const quotes = json.chart.result[0].indicators.quote[0];
  const closes = quotes.close as (number | null)[];
  let price = meta.regularMarketPrice;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) { price = closes[i] as number; break; }
  }
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const todayOpen = quotes.open && quotes.open[0] != null ? quotes.open[0] : prevClose;
  const change = price - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  return { symbol, name, price, open: todayOpen, prevClose, change, changePct, lastUpdated: new Date() };
}

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch { /* ignore */ }
}

// ── MarketCard ─────────────────────────────────────────────────────────
function MarketCard({ data, loading, error }: { data: MarketData | null; loading: boolean; error: string | null }) {
  const [flash, setFlash] = useState(false);
  const prevPrice = useRef(data?.price);

  useEffect(() => {
    if (data && prevPrice.current !== data.price) {
      prevPrice.current = data.price;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 300);
      return () => clearTimeout(t);
    }
  }, [data]);

  if (error) return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
      <h2 className="text-lg font-semibold text-red-400">{data?.name ?? "Loading..."}</h2>
      <p className="mt-2 text-sm text-red-300">{error}</p>
    </div>
  );

  if (loading || !data) return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 animate-pulse">
      <div className="h-5 w-32 bg-zinc-800 rounded mb-4" />
      <div className="h-10 w-48 bg-zinc-800 rounded mb-3" />
      <div className="h-4 w-40 bg-zinc-800 rounded" />
    </div>
  );

  const up = data.change >= 0;
  const accent = up ? "text-green-400" : "text-red-400";
  const borderColor = up ? "border-green-500/20 hover:border-green-500/40" : "border-red-500/20 hover:border-red-500/40";
  const pulseClass = up ? "animate-pulse-green" : "animate-pulse-red";

  return (
    <div className={`rounded-2xl border ${borderColor} bg-zinc-900/60 backdrop-blur p-6 transition-all duration-300`}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-300">{data.name}</h2>
        <span className={`w-2.5 h-2.5 rounded-full ${up ? "bg-green-400" : "bg-red-400"} ${pulseClass}`} />
      </div>
      <p className={`text-4xl font-bold font-mono tracking-tight ${accent} ${flash ? "price-flash" : ""}`}>
        {formatNum(data.price)}
      </p>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className={accent}>
          {up ? "+" : ""}{formatNum(data.change)} ({up ? "+" : ""}{data.changePct.toFixed(2)}%)
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-zinc-500">
        <span>Open: {formatNum(data.open)}</span>
        <span className="text-right">Prev Close: {formatNum(data.prevClose)}</span>
        <span>Updated: {formatTime(data.lastUpdated)}</span>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────
export default function Home() {
  const [nifty, setNifty] = useState<MarketData | null>(null);
  const [bankNifty, setBankNifty] = useState<MarketData | null>(null);
  const [sensex, setSensex] = useState<MarketData | null>(null);
  const [niftyErr, setNiftyErr] = useState<string | null>(null);
  const [bankErr, setBankErr] = useState<string | null>(null);
  const [sensexErr, setSensexErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [oiThresholds, setOiThresholds] = useState<Record<string, number>>({});
  const [alertUsers, setAlertUsers] = useState<AlertUserConfig[]>([]);
  const [oiChain, setOiChain] = useState<OiChainData[]>([]);
  const [activeSymbol, setActiveSymbol] = useState("NIFTY");
  const [oiAlerts, setOiAlerts] = useState<OiAlert[]>([]);
  const [permGranted, setPermGranted] = useState(false);
  const oiNotifiedRef = useRef<Set<string>>(new Set());
  const idRef = useRef(0);

  // ── Load thresholds from data.json via API ──
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((json) => {
        const users = Array.isArray(json.users) ? json.users : [];
        setAlertUsers(users);
        const user = users[0];
        if (user?.oi_threshold) {
          const t = user.oi_threshold;
          if (typeof t === "object") {
            setOiThresholds(t);
          }
        }
      })
      .catch(() => {});
  }, []);

  // ── Load persisted notifications from localStorage ──
  useEffect(() => {
    const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    const stored = localStorage.getItem("oi_notified");
    if (stored) {
      try {
        const { date, keys, alerts } = JSON.parse(stored);
        if (date === today) {
          oiNotifiedRef.current = new Set(keys);
          if (Array.isArray(alerts)) {
            // Restore time as Date objects
            setOiAlerts(alerts.map((a: OiAlert & { time: string }) => ({ ...a, time: new Date(a.time) })));
            idRef.current = alerts.length;
          }
        } else {
          // New day — clear old data
          localStorage.removeItem("oi_notified");
        }
      } catch {
        localStorage.removeItem("oi_notified");
      }
    }
  }, []);

  // Save notifications to localStorage whenever they change
  const saveToStorage = useCallback((keys: Set<string>, alerts: OiAlert[]) => {
    const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    localStorage.setItem("oi_notified", JSON.stringify({
      date: today,
      keys: [...keys],
      alerts,
    }));
  }, []);

  useEffect(() => {
    if ("Notification" in window) {
      if (Notification.permission === "granted") setPermGranted(true);
      else if (Notification.permission !== "denied")
        Notification.requestPermission().then((p) => setPermGranted(p === "granted"));
    }
  }, []);

  // ── Price fetch ──
  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchMarketData("^NSEI", "Nifty 50"),
      fetchMarketData("^NSEBANK", "Bank Nifty"),
      fetchMarketData("^BSESN", "Sensex"),
    ]);
    if (results[0].status === "fulfilled") { setNifty(results[0].value); setNiftyErr(null); }
    else setNiftyErr(results[0].reason?.message ?? "Failed to fetch");
    if (results[1].status === "fulfilled") { setBankNifty(results[1].value); setBankErr(null); }
    else setBankErr(results[1].reason?.message ?? "Failed to fetch");
    if (results[2].status === "fulfilled") { setSensex(results[2].value); setSensexErr(null); }
    else setSensexErr(results[2].reason?.message ?? "Failed to fetch");
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll(); // initial fetch always (to show last known prices)
    const id = setInterval(() => {
      if (isMarketOpen()) fetchAll();
    }, 30000);
    return () => clearInterval(id);
  }, [fetchAll]);

  // ── OI fetch & alert ──
  const checkOi = useCallback(async () => {
    try {
      const res = await fetch("/api/upstox-oi");
      if (!res.ok) return;
      const json = await res.json();

      // Always update option chain table
      setOiChain(json.data ?? []);

      // Only send alerts during market hours
      // if (!isMarketOpen()) return; // TODO: uncomment after testing

      for (const sym of json.data ?? []) {
        for (const row of sym.strikes ?? []) {
          for (const optType of ["ce", "pe"] as const) {
            const opt = row[optType];
            if (!opt || opt.prevOi === 0) continue;
            const pct: number = opt.oiPct;
            const symThreshold = lowestThreshold(alertUsers, sym.symbol);
            if (Math.abs(pct) < symThreshold) continue;

            const alertType = optType.toUpperCase() as "CE" | "PE";
            const key = `${sym.symbol}:${row.strike}:${alertType}:${Math.floor(Math.abs(pct) / symThreshold)}`;
            const dir = pct > 0 ? "UP" : "DOWN";
            const message = `${dir} <b>${sym.symbol} ${row.strike} ${alertType}</b>
OI% Change: <b>${pct.toFixed(2)}%</b>
OI: ${formatOi(opt.oi)} | Change: ${formatOi(opt.oiChange)}
LTP: ${opt.ltp}`;

            fetch("/api/send-telegram", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                message,
                symbol: sym.symbol,
                strike: row.strike,
                type: alertType,
                oiPct: pct,
              }),
            }).catch(() => {});
            if (oiNotifiedRef.current.has(key)) continue;
            oiNotifiedRef.current.add(key);

            const alert: OiAlert = {
              id: ++idRef.current,
              time: new Date(),
              symbol: sym.symbol,
              strike: row.strike,
              type: alertType,
              oiPct: pct,
              oi: opt.oi,
              oiChange: opt.oiChange,
              ltp: opt.ltp,
            };

            playBeep();
            if (permGranted) {
              const dir = pct > 0 ? "▲" : "▼";
              new Notification(`OI Alert: ${sym.symbol} ${row.strike} ${alert.type}`, {
                body: `OI% ${dir} ${Math.abs(pct).toFixed(2)}% | LTP: ${opt.ltp}`,
                icon: "/favicon.ico",
              });
            }


            setOiAlerts((prev) => {
              const updated = [alert, ...prev].slice(0, 100);
              saveToStorage(oiNotifiedRef.current, updated);
              return updated;
            });
          }
        }
      }
    } catch { /* ignore */ }
  }, [alertUsers, permGranted, saveToStorage]);

  useEffect(() => {
    checkOi(); // always fetch once on load to show latest data
    const id = setInterval(() => {
      if (isMarketOpen()) checkOi(); // repeat only during market hours
    }, 60000);
    return () => clearInterval(id);
  }, [checkOi]);

  const marketOpen = isMarketOpen();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100">
      <header className="border-b border-zinc-800/50 px-4 py-4">
        <div className="mx-auto max-w-6xl flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Nifty Notifications</h1>
            <p className="text-xs text-zinc-500 mt-0.5">Real-time market alerts</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            marketOpen ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-zinc-800 text-zinc-400 border border-zinc-700"
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${marketOpen ? "bg-green-400 animate-pulse" : "bg-zinc-500"}`} />
            {marketOpen ? "Live" : "Closed"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* OI threshold setting */}
        <div className="mb-6 flex flex-wrap items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 w-fit">
          <span className="text-sm text-zinc-400">OI Alert thresholds:</span>
          {["NIFTY", "BANKNIFTY", "SENSEX"].map((sym) => (
            <div key={sym} className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-500">{sym}</span>
              <input
                type="number"
                min={10}
                step={10}
                value={oiThresholds[sym] ?? ""}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) {
                    setOiThresholds((prev) => ({ ...prev, [sym]: v }));
                    oiNotifiedRef.current.clear();
                  }
                }}
                className="w-16 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
              <span className="text-xs text-zinc-500">%</span>
            </div>
          ))}
        </div>

        {/* Market cards */}
        <div className="grid gap-4 sm:grid-cols-3 mb-8">
          <MarketCard data={nifty} loading={loading} error={niftyErr} />
          <MarketCard data={bankNifty} loading={loading} error={bankErr} />
          <MarketCard data={sensex} loading={loading} error={sensexErr} />
        </div>

        <p className="text-xs text-zinc-600 mb-8 text-center">
          {marketOpen
            ? "Prices refresh every 30s · OI checks every 60s · Market hours only"
            : "APIs paused — market is closed (Mon–Fri 9:15 AM – 3:30 PM IST)"}
          {!permGranted && <span className="ml-2 text-yellow-500">— Allow notifications for browser alerts.</span>}
        </p>

        {/* OI Chain Table */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-zinc-400">Option Chain — OI Data</h3>
            <div className="flex gap-2">
              {["NIFTY", "BANKNIFTY", "SENSEX"].map((s) => (
                <button
                  key={s}
                  onClick={() => setActiveSymbol(s)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                    activeSymbol === s
                      ? "bg-zinc-100 text-zinc-900"
                      : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {(() => {
            const chain = oiChain.find((c) => c.symbol === activeSymbol);
            if (!chain) return (
              <p className="text-sm text-zinc-600 text-center py-6">
                {marketOpen ? "Loading OI data..." : "OI data loads during market hours (9:15 AM – 3:30 PM IST)"}
              </p>
            );
            return (
              <>
                <p className="text-xs text-zinc-600 mb-3">Expiry: {chain.expiry} · {chain.strikes.length} strikes</p>
                <div className="overflow-x-auto rounded-xl border border-zinc-800/60 bg-zinc-900/20 shadow-xl">
                  <table className="w-full text-sm font-mono whitespace-nowrap">
                    <thead>
                      <tr className="text-xs uppercase tracking-wider bg-zinc-900/80 text-zinc-400 border-b border-zinc-800">
                        <th colSpan={4} className="py-3 text-center bg-green-500/5 text-green-400 font-semibold border-r border-zinc-800/50">CALL (CE)</th>
                        <th className="py-3 text-center w-28 bg-zinc-800/30 text-zinc-300 border-x border-zinc-800/50">STRIKE</th>
                        <th colSpan={4} className="py-3 text-center bg-red-500/5 text-red-400 font-semibold border-l border-zinc-800/50">PUT (PE)</th>
                      </tr>
                      <tr className="text-xs text-zinc-500 border-b border-zinc-800 bg-zinc-900/40">
                        <th className="py-2.5 text-right pr-4 font-medium">LTP</th>
                        <th className="py-2.5 text-right pr-4 font-medium">OI</th>
                        <th className="py-2.5 text-right pr-4 font-medium">Open OI</th>
                        <th className="py-2.5 text-right pr-4 font-medium">Chg%</th>
                        <th className="py-2.5 text-center px-4 font-bold bg-zinc-800/30 border-x border-zinc-800/50">STRIKE</th>
                        <th className="py-2.5 text-left pl-4 font-medium">Chg%</th>
                        <th className="py-2.5 text-left pl-4 font-medium">Open OI</th>
                        <th className="py-2.5 text-left pl-4 font-medium">OI</th>
                        <th className="py-2.5 text-left pl-4 font-medium">LTP</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/40">
                      {chain.strikes.map((row) => {
                        const ceUp = row.ce.oiPct >= 0;
                        const peUp = row.pe.oiPct >= 0;
                        const symTh = oiThresholds[chain.symbol] ?? Infinity;
                        const ceAlert = Math.abs(row.ce.oiPct) >= symTh;
                        const peAlert = Math.abs(row.pe.oiPct) >= symTh;
                        return (
                          <tr key={row.strike} className="hover:bg-zinc-800/30 transition-colors group">
                            {/* CE side */}
                            <td className="py-3 text-right pr-4 text-zinc-300 font-medium group-hover:text-white transition-colors">{row.ce.ltp}</td>
                            <td className="py-3 text-right pr-4 text-zinc-400">{formatOi(row.ce.oi)}</td>
                            <td className="py-3 text-right pr-4 text-zinc-500">{formatOi(row.ce.prevOi)}</td>
                            <td className={`py-3 text-right pr-4 font-semibold ${ceAlert ? "text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]" : ceUp ? "text-green-400" : "text-red-400"}`}>
                              {row.ce.oiPct > 0 ? "+" : ""}{row.ce.oiPct.toFixed(1)}%
                            </td>
                            {/* Strike */}
                            <td className="py-3 text-center px-4 font-bold text-zinc-200 bg-zinc-800/20 border-x border-zinc-800/50 group-hover:bg-zinc-700/30 transition-colors">{row.strike}</td>
                            {/* PE side */}
                            <td className={`py-3 text-left pl-4 font-semibold ${peAlert ? "text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.5)]" : peUp ? "text-green-400" : "text-red-400"}`}>
                              {row.pe.oiPct > 0 ? "+" : ""}{row.pe.oiPct.toFixed(1)}%
                            </td>
                            <td className="py-3 text-left pl-4 text-zinc-500">{formatOi(row.pe.prevOi)}</td>
                            <td className="py-3 text-left pl-4 text-zinc-400">{formatOi(row.pe.oi)}</td>
                            <td className="py-3 text-left pl-4 text-zinc-300 font-medium group-hover:text-white transition-colors">{row.pe.ltp}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
        </div>

        {/* OI Alert history */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3">OI Alert History</h3>
          {oiAlerts.length === 0 ? (
            <p className="text-sm text-zinc-600">
              {marketOpen
                ? `Watching all strikes for OI% change ≥ thresholds (NIFTY: ${oiThresholds.NIFTY}%, BANKNIFTY: ${oiThresholds.BANKNIFTY}%, SENSEX: ${oiThresholds.SENSEX}%)...`
                : "Market is closed. OI alerts will appear here during market hours (9:15 AM – 3:30 PM IST)."}
            </p>
          ) : (
            <ul className="space-y-2 max-h-96 overflow-y-auto">
              {oiAlerts.map((a) => {
                const up = a.oiPct > 0;
                return (
                  <li key={a.id} className={`flex items-start gap-3 rounded-lg px-3 py-2 text-sm ${up ? "bg-green-500/5 text-green-300" : "bg-red-500/5 text-red-300"}`}>
                    <span className="shrink-0 text-xs text-zinc-500 font-mono pt-0.5">{formatTime(a.time)}</span>
                    <span className="flex-1">
                      <span className="font-semibold">{a.symbol} {a.strike} {a.type}</span>
                      {" "}{up ? "▲" : "▼"} OI {up ? "+" : ""}{a.oiPct.toFixed(2)}%
                      <span className="text-xs text-zinc-500 ml-2">OI: {formatOi(a.oi)} | Chg: {formatOi(a.oiChange)} | LTP: {a.ltp}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>

      <footer className="border-t border-zinc-800/50 py-4 text-center text-sm text-zinc-500">
        Designed by{" "}
        <a href="https://udaykjasani.vercel.app/" target="_blank" rel="noopener noreferrer" className="text-zinc-300 hover:text-white transition-colors">
          Uday Jasani
        </a>
      </footer>
    </div>
  );
}
