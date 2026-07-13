const UPSTOX_TOKEN = "eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzQkI2RlQiLCJqdGkiOiI2YTU0ZDNkNWJhMDhhZDYwZmRlMjRhMzkiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6ZmFsc2UsImlzRXh0ZW5kZWQiOnRydWUsImlhdCI6MTc4Mzk0NDE0OSwiaXNzIjoidWRhcGktZ2F0ZXdheS1zZXJ2aWNlIiwiZXhwIjoxODE1NTE2MDAwfQ.gfzUTnsYE4PJ2-gdtatMAa0tMxtwO7iSNDVI7E-5vpk";
const BASE = "https://api.upstox.com/v2";

const SYMBOLS = [
  { name: "NIFTY",     key: "NSE_INDEX|Nifty 50" },
  { name: "BANKNIFTY", key: "NSE_INDEX|Nifty Bank" },
  { name: "SENSEX",    key: "BSE_INDEX|SENSEX" },
];

function upstoxHeaders() {
  return {
    Authorization: `Bearer ${UPSTOX_TOKEN}`,
    Accept: "application/json",
  };
}

async function getNearestExpiry(instrumentKey: string): Promise<string | null> {
  const res = await fetch(`${BASE}/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`, {
    headers: upstoxHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const contracts: { expiry: string }[] = data.data ?? [];
  const expiries = [...new Set(contracts.map((c) => c.expiry))].sort();
  return expiries[0] ?? null;
}

async function getOptionChain(instrumentKey: string, expiry: string) {
  const res = await fetch(
    `${BASE}/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${expiry}`,
    { headers: upstoxHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data.data ?? [];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbolParam = url.searchParams.get("symbol"); // optional filter

  const results = [];

  for (const sym of SYMBOLS) {
    if (symbolParam && sym.name !== symbolParam) continue;

    try {
      const expiry = await getNearestExpiry(sym.key);
      if (!expiry) continue;

      const chain = await getOptionChain(sym.key, expiry);

      const strikes = chain.map((item: {
        strike_price: number;
        call_options?: { market_data?: { ltp?: number; oi?: number; prev_oi?: number; volume?: number } };
        put_options?: { market_data?: { ltp?: number; oi?: number; prev_oi?: number; volume?: number } };
      }) => {
        const ce = item.call_options?.market_data ?? {};
        const pe = item.put_options?.market_data ?? {};

        const ceOi = ce.oi ?? 0;
        const cePrevOi = ce.prev_oi ?? 0;
        const ceOiPct = cePrevOi !== 0 ? ((ceOi - cePrevOi) / cePrevOi) * 100 : 0;

        const peOi = pe.oi ?? 0;
        const pePrevOi = pe.prev_oi ?? 0;
        const peOiPct = pePrevOi !== 0 ? ((peOi - pePrevOi) / pePrevOi) * 100 : 0;

        return {
          strike: item.strike_price,
          ce: { ltp: ce.ltp ?? 0, oi: ceOi, prevOi: cePrevOi, oiChange: ceOi - cePrevOi, oiPct: parseFloat(ceOiPct.toFixed(2)) },
          pe: { ltp: pe.ltp ?? 0, oi: peOi, prevOi: pePrevOi, oiChange: peOi - pePrevOi, oiPct: parseFloat(peOiPct.toFixed(2)) },
        };
      });

      results.push({ symbol: sym.name, expiry, strikes });
    } catch {
      // skip errors
    }
  }

  return Response.json({ ok: true, data: results });
}
