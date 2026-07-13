// Server-side background tasks
// OI alerts are handled by: python scripts/oi-monitor.py (Upstox API)

export function register() {
  console.log("🔔 Nifty Notifications server started");
  console.log("📊 Run OI monitor: python scripts/oi-monitor.py");
}
