import { getManager } from "@/lib/oi-ws-manager";

export async function GET() {
  const manager = getManager();
  manager.init();
  const snapshot = manager.getSnapshot();
  return Response.json({ ok: true, data: snapshot.data });
}
