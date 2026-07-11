const TELEGRAM_BOT_TOKEN = "8882164490:AAEmber4ZZocHVe-nXmX-oHaKza3slZYd9s";
const TELEGRAM_CHAT_ID = "8503524860";

const SYMBOLS = [
  { symbol: "^NSEI", name: "Nifty 50" },
  { symbol: "^NSEBANK", name: "Bank Nifty" },
  { symbol: "^BSESN", name: "Sensex" },
];

// In-memory store for already-notified levels (resets on server restart)
const notified = new Set<string>();

async function sendTelegram(message: string) {
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

function formatNum(n: number): string {
  return n.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const intervalParam = url.searchParams.get("interval");
  const interval = intervalParam ? parseInt(intervalParam, 10) : 300;

  const results: string[] = [];

  for (const { symbol, name } of SYMBOLS) {
    try {
      const { price, prevClose } = await fetchPrice(symbol);

      // Check previous close crossing
      const prevCloseKey = `${symbol}:prevclose`;
      if (!notified.has(prevCloseKey)) {
        if (price > prevClose) {
          notified.add(prevCloseKey);
          const msg = `📈 <b>${name}</b> is ABOVE previous close!\nCMP: ${formatNum(price)} | Prev Close: ${formatNum(prevClose)}\nChange: +${formatNum(price - prevClose)} (+${((price - prevClose) / prevClose * 100).toFixed(2)}%)`;
          await sendTelegram(msg);
          results.push(msg);
        } else if (price < prevClose) {
          notified.add(prevCloseKey);
          const msg = `📉 <b>${name}</b> is BELOW previous close!\nCMP: ${formatNum(price)} | Prev Close: ${formatNum(prevClose)}\nChange: ${formatNum(price - prevClose)} (${((price - prevClose) / prevClose * 100).toFixed(2)}%)`;
          await sendTelegram(msg);
          results.push(msg);
        }
      }

      // Check interval-based milestones from previous close
      if (interval > 0) {
        const diff = price - prevClose;
        const levels = Math.floor(Math.abs(diff) / interval);
        const direction = diff > 0 ? 1 : -1;

        for (let i = 1; i <= levels; i++) {
          const milestone = prevClose + direction * i * interval;
          const key = `${symbol}:${milestone}`;
          if (notified.has(key)) continue;
          notified.add(key);

          const arrow = direction > 0 ? "📈" : "📉";
          const sign = direction > 0 ? "+" : "-";
          const msg = `${arrow} <b>${name}</b> crossed ${formatNum(milestone)}!\n${sign}${i * interval} points from prev close\nCMP: ${formatNum(price)}`;
          await sendTelegram(msg);
          results.push(msg);
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      results.push(`Error fetching ${name}: ${errMsg}`);
    }
  }

  return Response.json({
    ok: true,
    checked: new Date().toISOString(),
    interval,
    alerts: results,
    message:
      results.length > 0
        ? `${results.length} alert(s) sent to Telegram`
        : "No new alerts",
  });
}
