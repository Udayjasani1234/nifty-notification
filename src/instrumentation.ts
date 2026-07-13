const TELEGRAM_BOT_TOKEN = "8882164490:AAEmber4ZZocHVe-nXmX-oHaKza3slZYd9s";
const TELEGRAM_CHAT_ID = "8503524860";
const CHECK_INTERVAL_MS = 30_000; // 30 seconds

const SYMBOLS = [
  { symbol: "^NSEI", name: "Nifty 50", points: 100 },
  { symbol: "^NSEBANK", name: "Bank Nifty", points: 300 },
  { symbol: "^BSESN", name: "Sensex", points: 300 },
];

const notified = new Set<string>();
let lastDate = "";

function formatNum(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

async function sendTelegram(message: string) {
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
        }),
      }
    );
  } catch {
    // ignore send errors
  }
}

async function fetchPrice(symbol: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  const json = await res.json();
  const meta = json.chart.result[0].meta;
  const quotes = json.chart.result[0].indicators.quote[0];
  const closes = quotes.close as (number | null)[];

  let price = meta.regularMarketPrice;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] != null) {
      price = closes[i] as number;
      break;
    }
  }

  const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
  return { price, prevClose };
}

async function checkAlerts() {
  // Reset notifications each new trading day
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
  if (today !== lastDate) {
    notified.clear();
    lastDate = today;
  }

  if (!isMarketOpen()) return;

  for (const { symbol, name, points } of SYMBOLS) {
    try {
      const { price, prevClose } = await fetchPrice(symbol);

      // Previous close crossing alert
      const prevCloseKey = `${symbol}:prevclose`;
      if (!notified.has(prevCloseKey)) {
        if (price > prevClose) {
          notified.add(prevCloseKey);
          await sendTelegram(
            `📈 <b>${name}</b> is ABOVE previous close!\nCMP: ${formatNum(price)} | Prev Close: ${formatNum(prevClose)}\nChange: +${formatNum(price - prevClose)} (+${(((price - prevClose) / prevClose) * 100).toFixed(2)}%)`
          );
        } else if (price < prevClose) {
          notified.add(prevCloseKey);
          await sendTelegram(
            `📉 <b>${name}</b> is BELOW previous close!\nCMP: ${formatNum(price)} | Prev Close: ${formatNum(prevClose)}\nChange: ${formatNum(price - prevClose)} (${(((price - prevClose) / prevClose) * 100).toFixed(2)}%)`
          );
        }
      }

      // Interval milestone alerts
      if (points > 0) {
        const diff = price - prevClose;
        const levels = Math.floor(Math.abs(diff) / points);
        const direction = diff > 0 ? 1 : -1;

        for (let i = 1; i <= levels; i++) {
          const milestone = prevClose + direction * i * points;
          const key = `${symbol}:${milestone}`;
          if (notified.has(key)) continue;
          notified.add(key);

          const arrow = direction > 0 ? "📈" : "📉";
          const sign = direction > 0 ? "+" : "-";
          await sendTelegram(
            `${arrow} <b>${name}</b> crossed ${formatNum(milestone)}!\n${sign}${i * points} points from prev close\nCMP: ${formatNum(price)}`
          );
        }
      }
    } catch {
      // skip errors silently
    }
  }
}

// OI monitoring runs separately via: python scripts/oi-monitor.py (uses Upstox API)

export function register() {
  setInterval(checkAlerts, CHECK_INTERVAL_MS);
  console.log(
    "🔔 Nifty price alert checker started (every 30s, market hours only)"
  );
  console.log(
    "📊 For OI alerts, run separately: python scripts/oi-monitor.py"
  );
}
