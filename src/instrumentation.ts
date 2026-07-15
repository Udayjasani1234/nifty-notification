export async function register() {
  // Only run in Node.js runtime, not Edge
  if (typeof (globalThis as Record<string, unknown>).EdgeRuntime === "string") return;

  const { getManager } = await import("@/lib/oi-ws-manager");

  console.log("\u{1F514} Nifty Notifications server started");

  const manager = getManager();
  manager.init();
}
