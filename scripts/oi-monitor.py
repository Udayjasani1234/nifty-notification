"""
OI Monitor - Upstox API + Telegram alerts
Run: python scripts/oi-monitor.py
Checks every 60 seconds during market hours (9:15 AM - 3:30 PM IST)
"""

import sys
import os
sys.stdout.reconfigure(encoding='utf-8')
os.environ["PYTHONIOENCODING"] = "utf-8"

import requests
import time
from datetime import datetime
import pytz

# ── Configuration ──────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN = "8882164490:AAEmber4ZZocHVe-nXmX-oHaKza3slZYd9s"
TELEGRAM_CHAT_ID = "8503524860"
UPSTOX_ACCESS_TOKEN = "eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiIzQkI2RlQiLCJqdGkiOiI2YTU0ZDNkNWJhMDhhZDYwZmRlMjRhMzkiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6ZmFsc2UsImlzRXh0ZW5kZWQiOnRydWUsImlhdCI6MTc4Mzk0NDE0OSwiaXNzIjoidWRhcGktZ2F0ZXdheS1zZXJ2aWNlIiwiZXhwIjoxODE1NTE2MDAwfQ.gfzUTnsYE4PJ2-gdtatMAa0tMxtwO7iSNDVI7E-5vpk"
OI_THRESHOLD = 500  # Alert when OI% change >= this value

SYMBOLS = [
    {"name": "NIFTY",     "key": "NSE_INDEX|Nifty 50"},
    {"name": "BANKNIFTY", "key": "NSE_INDEX|Nifty Bank"},
    {"name": "SENSEX",    "key": "BSE_INDEX|SENSEX"},
]

IST = pytz.timezone("Asia/Kolkata")
UPSTOX_BASE = "https://api.upstox.com/v2"

notified = set()
last_date = ""
expiry_cache = {}  # symbol -> nearest expiry date


# ── Upstox Helpers ─────────────────────────────────────────────────────
def headers():
    return {"Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}", "Accept": "application/json"}


def get_nearest_expiry(instrument_key):
    """Cache nearest expiry per symbol per day"""
    today = datetime.now(IST).strftime("%Y-%m-%d")
    cache_key = f"{instrument_key}:{today}"
    if cache_key in expiry_cache:
        return expiry_cache[cache_key]

    r = requests.get(f"{UPSTOX_BASE}/option/contract",
                     headers=headers(),
                     params={"instrument_key": instrument_key},
                     timeout=10)
    if r.status_code != 200:
        return None

    contracts = r.json().get("data", [])
    expiries = sorted(set(c["expiry"] for c in contracts))
    if not expiries:
        return None

    nearest = expiries[0]
    expiry_cache[cache_key] = nearest
    return nearest


def fetch_option_chain(instrument_key, expiry):
    """Fetch full option chain for given symbol and expiry"""
    r = requests.get(f"{UPSTOX_BASE}/option/chain",
                     headers=headers(),
                     params={"instrument_key": instrument_key, "expiry_date": expiry},
                     timeout=15)
    if r.status_code != 200:
        print(f"[!] Option chain error {r.status_code}: {r.text[:200]}")
        return []
    return r.json().get("data", [])


def get_spot_price(instrument_key):
    """Get current spot price"""
    r = requests.get(f"{UPSTOX_BASE}/market-quote/quotes",
                     headers=headers(),
                     params={"instrument_key": instrument_key},
                     timeout=10)
    if r.status_code != 200:
        return 0
    quotes = r.json().get("data", {})
    for val in quotes.values():
        return val.get("last_price", 0)
    return 0


# ── Telegram ───────────────────────────────────────────────────────────
def send_telegram(message):
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": message, "parse_mode": "HTML"},
            timeout=10,
        )
    except Exception as e:
        print(f"[!] Telegram error: {e}")


# ── Market Hours ───────────────────────────────────────────────────────
def is_market_open():
    now = datetime.now(IST)
    if now.weekday() >= 5:
        return False
    start = now.replace(hour=9, minute=15, second=0, microsecond=0)
    end = now.replace(hour=15, minute=30, second=0, microsecond=0)
    return start <= now <= end


# ── OI Alert Logic ─────────────────────────────────────────────────────
def check_oi_alerts():
    global last_date, notified

    today = datetime.now(IST).strftime("%Y-%m-%d")
    if today != last_date:
        notified.clear()
        expiry_cache.clear()
        last_date = today
        print(f"\n--- New day: {today} --- alerts reset ---")

    if not is_market_open():
        return

    for sym in SYMBOLS:
        name = sym["name"]
        key = sym["key"]

        expiry = get_nearest_expiry(key)
        if not expiry:
            print(f"[!] Could not get expiry for {name}")
            continue

        chain = fetch_option_chain(key, expiry)
        if not chain:
            continue

        spot = get_spot_price(key)
        alerts_sent = 0

        for item in chain:
            strike = item.get("strike_price", 0)

            for opt_type, opt_key in [("CE", "call_options"), ("PE", "put_options")]:
                market = item.get(opt_key, {}).get("market_data", {})
                if not market:
                    continue

                oi = market.get("oi", 0) or 0
                prev_oi = market.get("prev_oi", 0) or 0
                ltp = market.get("ltp", 0) or 0

                if prev_oi == 0:
                    continue

                oi_change = oi - prev_oi
                oi_pct = (oi_change / prev_oi) * 100

                alert_key = f"{name}:{strike}:{opt_type}:{int(abs(oi_pct) // OI_THRESHOLD)}"
                if abs(oi_pct) >= OI_THRESHOLD and alert_key not in notified:
                    notified.add(alert_key)
                    direction = chr(0x1F4C8) if oi_pct > 0 else chr(0x1F4C9)
                    msg = (
                        f"{direction} <b>{name} {int(strike)} {opt_type}</b>\n"
                        f"OI% Change: <b>{oi_pct:.2f}%</b>\n"
                        f"OI: {int(oi):,} | Change: {int(oi_change):,}\n"
                        f"Prev OI: {int(prev_oi):,}\n"
                        f"LTP: {ltp}\n"
                        f"Spot: {spot:,.2f}\n"
                        f"Expiry: {expiry}"
                    )
                    send_telegram(msg)
                    print(f"  [ALERT] {name} {int(strike)} {opt_type} | OI%: {oi_pct:.2f}%")
                    alerts_sent += 1

        now_str = datetime.now(IST).strftime("%H:%M:%S")
        print(f"[{now_str}] {name}: {len(chain)} strikes checked, {alerts_sent} alerts sent (expiry: {expiry})")


# ── Main ───────────────────────────────────────────────────────────────
def main():
    print("=" * 55)
    print("  OI Monitor — Upstox + Telegram")
    print("=" * 55)
    print(f"  Symbols  : {', '.join(s['name'] for s in SYMBOLS)}")
    print(f"  Threshold: {OI_THRESHOLD}% OI change")
    print(f"  Interval : 60 seconds")
    print(f"  Hours    : 9:15 AM - 3:30 PM IST (Mon-Fri)")
    print("=" * 55)

    print("\nTesting Upstox connection...")
    r = requests.get(f"{UPSTOX_BASE}/user/profile", headers=headers(), timeout=10)
    if r.status_code == 200:
        d = r.json().get("data", {})
        print(f"Connected: {d.get('user_name')} ({d.get('user_id')})")
    else:
        print(f"[!] Connection failed: {r.text[:200]}")
        return

    send_telegram(
        f"OI Monitor started!\n"
        f"Watching: NIFTY, BANKNIFTY, SENSEX\n"
        f"Alert threshold: {OI_THRESHOLD}% OI change\n"
        f"Checking every 60 seconds during market hours."
    )
    print("Telegram test sent!\n")

    while True:
        try:
            check_oi_alerts()
        except Exception as e:
            print(f"[!] Error: {e}")
        time.sleep(60)


if __name__ == "__main__":
    main()
