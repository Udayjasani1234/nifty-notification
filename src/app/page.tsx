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

interface NotificationEntry {
  id: number;
  time: Date;
  message: string;
  type: "up" | "down";
}

// ── Helpers ────────────────────────────────────────────────────────────
function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(
    now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

function formatNum(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

async function fetchMarketData(
  symbol: string,
  name: string
): Promise<MarketData> {
  const res = await fetch(`/api/market-data?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const json = await res.json();
  const meta = json.chart.result[0].meta;
  const quotes = json.chart.result[0].indicators.quote[0];
  const closes = quotes.close as (number | null)[];
  // last valid close
  let price = meta.regularMarketPrice;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      price = closes[i] as number;
      break;
    }
  }
  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const todayOpen =
    quotes.open && quotes.open[0] != null ? quotes.open[0] : prevClose;
  const change = price - prevClose;
  const changePct = prevClose !== 0 ? (change / prevClose) * 100 : 0;
  return {
    symbol,
    name,
    price,
    open: todayOpen,
    prevClose,
    change,
    changePct,
    lastUpdated: new Date(),
  };
}

function playBeep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch {
    // ignore audio errors
  }
}

// ── Components ─────────────────────────────────────────────────────────
function MarketCard({
  data,
  loading,
  error,
}: {
  data: MarketData | null;
  loading: boolean;
  error: string | null;
}) {
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

  if (error) {
    return (
      <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
        <h2 className="text-lg font-semibold text-red-400">
          {data?.name ?? "Loading..."}
        </h2>
        <p className="mt-2 text-sm text-red-300">{error}</p>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6 animate-pulse">
        <div className="h-5 w-32 bg-zinc-800 rounded mb-4" />
        <div className="h-10 w-48 bg-zinc-800 rounded mb-3" />
        <div className="h-4 w-40 bg-zinc-800 rounded" />
      </div>
    );
  }

  const up = data.change >= 0;
  const accent = up ? "text-green-400" : "text-red-400";
  const borderColor = up
    ? "border-green-500/20 hover:border-green-500/40"
    : "border-red-500/20 hover:border-red-500/40";
  const pulseClass = up ? "animate-pulse-green" : "animate-pulse-red";

  return (
    <div
      className={`rounded-2xl border ${borderColor} bg-zinc-900/60 backdrop-blur p-6 transition-all duration-300`}
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-zinc-300">{data.name}</h2>
        <span
          className={`w-2.5 h-2.5 rounded-full ${up ? "bg-green-400" : "bg-red-400"} ${pulseClass}`}
        />
      </div>
      <p
        className={`text-4xl font-bold font-mono tracking-tight ${accent} ${flash ? "price-flash" : ""}`}
      >
        {formatNum(data.price)}
      </p>
      <div className="mt-3 flex items-center gap-3 text-sm">
        <span className={accent}>
          {up ? "+" : ""}
          {formatNum(data.change)} ({up ? "+" : ""}
          {data.changePct.toFixed(2)}%)
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
  const [niftyPts, setNiftyPts] = useState(100);
  const [bankNiftyPts, setBankNiftyPts] = useState(300);
  const [sensexPts, setSensexPts] = useState(300);
  const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
  const [permGranted, setPermGranted] = useState(false);
  const notifiedRef = useRef<Set<string>>(new Set());
  const idRef = useRef(0);

  // Request notification permission
  useEffect(() => {
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        setPermGranted(true);
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then((p) =>
          setPermGranted(p === "granted")
        );
      }
    }
  }, []);

  const getInterval = useCallback(
    (symbol: string) => {
      if (symbol === "^NSEI") return niftyPts;
      if (symbol === "^NSEBANK") return bankNiftyPts;
      return sensexPts;
    },
    [niftyPts, bankNiftyPts, sensexPts]
  );

  const checkMilestones = useCallback(
    (data: MarketData) => {
      const pts = getInterval(data.symbol);
      if (pts <= 0) return;
      const diff = data.price - data.open;
      const level = Math.floor(Math.abs(diff) / pts);
      if (level === 0) return;

      const direction = diff > 0 ? 1 : -1;
      for (let i = 1; i <= level; i++) {
        const milestone = data.open + direction * i * pts;
        const key = `${data.symbol}:${milestone}`;
        if (notifiedRef.current.has(key)) continue;
        notifiedRef.current.add(key);

        const type = direction > 0 ? "up" : "down";
        const arrow = type === "up" ? "▲" : "▼";
        const msg = `${data.name} crossed ${formatNum(milestone)} ${arrow} (${type === "up" ? "+" : "-"}${i * pts} from open)`;

        if (permGranted) {
          new Notification(`${data.name} Alert`, { body: msg, icon: "/favicon.ico" });
        }
        playBeep();

        fetch("/api/send-telegram", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg }),
        }).catch(() => {});

        setNotifications((prev) => [
          { id: ++idRef.current, time: new Date(), message: msg, type },
          ...prev,
        ]);
      }
    },
    [getInterval, permGranted]
  );

  const fetchAll = useCallback(async () => {
    const results = await Promise.allSettled([
      fetchMarketData("^NSEI", "Nifty 50"),
      fetchMarketData("^NSEBANK", "Bank Nifty"),
      fetchMarketData("^BSESN", "Sensex"),
    ]);

    if (results[0].status === "fulfilled") {
      setNifty(results[0].value);
      setNiftyErr(null);
      checkMilestones(results[0].value);
    } else {
      setNiftyErr(results[0].reason?.message ?? "Failed to fetch");
    }

    if (results[1].status === "fulfilled") {
      setBankNifty(results[1].value);
      setBankErr(null);
      checkMilestones(results[1].value);
    } else {
      setBankErr(results[1].reason?.message ?? "Failed to fetch");
    }

    if (results[2].status === "fulfilled") {
      setSensex(results[2].value);
      setSensexErr(null);
      checkMilestones(results[2].value);
    } else {
      setSensexErr(results[2].reason?.message ?? "Failed to fetch");
    }

    setLoading(false);
  }, [checkMilestones]);

  // Initial fetch + interval
  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 20000);
    return () => clearInterval(id);
  }, [fetchAll]);

  const marketOpen = isMarketOpen();

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800/50 px-4 py-4">
        <div className="mx-auto max-w-4xl flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              Nifty Notifications
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              Real-time market alerts
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
                marketOpen
                  ? "bg-green-500/10 text-green-400 border border-green-500/20"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${marketOpen ? "bg-green-400 animate-pulse" : "bg-zinc-500"}`}
              />
              {marketOpen ? "Live" : "Closed"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        {/* Interval settings */}
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          {[
            { label: "Nifty 50", value: niftyPts, setter: setNiftyPts },
            { label: "Bank Nifty", value: bankNiftyPts, setter: setBankNiftyPts },
            { label: "Sensex", value: sensexPts, setter: setSensexPts },
          ].map(({ label, value, setter }) => (
            <div key={label} className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
              <span className="text-sm text-zinc-400 whitespace-nowrap">{label}</span>
              <input
                type="number"
                min={10}
                step={10}
                value={value}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v > 0) setter(v);
                }}
                className="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm font-mono text-zinc-100 focus:outline-none focus:border-zinc-500"
              />
              <span className="text-xs text-zinc-500">pts</span>
            </div>
          ))}
        </div>

        {/* Market cards */}
        <div className="grid gap-4 sm:grid-cols-3 mb-8">
          <MarketCard data={nifty} loading={loading} error={niftyErr} />
          <MarketCard data={bankNifty} loading={loading} error={bankErr} />
          <MarketCard data={sensex} loading={loading} error={sensexErr} />
        </div>

        {/* Auto-refresh note */}
        <p className="text-xs text-zinc-600 mb-8 text-center">
          Auto-refreshes every 20 seconds
          {!permGranted && (
            <span className="ml-2 text-yellow-500">
              — Notifications blocked. Allow them for alerts.
            </span>
          )}
        </p>

        {/* Notification history */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
          <h3 className="text-sm font-semibold text-zinc-400 mb-3">
            Notification History
          </h3>
          {notifications.length === 0 ? (
            <p className="text-sm text-zinc-600">
              No alerts yet. You will be notified when price crosses set point milestones.
            </p>
          ) : (
            <ul className="space-y-2 max-h-80 overflow-y-auto">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 rounded-lg px-3 py-2 text-sm ${
                    n.type === "up"
                      ? "bg-green-500/5 text-green-300"
                      : "bg-red-500/5 text-red-300"
                  }`}
                >
                  <span className="shrink-0 text-xs text-zinc-500 font-mono pt-0.5">
                    {formatTime(n.time)}
                  </span>
                  <span>{n.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <footer className="border-t border-zinc-800/50 py-4 text-center text-sm text-zinc-500">
        Designed by{" "}
        <a
          href="https://udaykjasani.vercel.app/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-zinc-300 hover:text-white transition-colors"
        >
          Uday Jasani
        </a>
      </footer>
    </div>
  );
}
