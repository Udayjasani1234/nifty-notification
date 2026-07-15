import { getManager } from "@/lib/oi-ws-manager";

export const dynamic = "force-dynamic";

export async function GET() {
  const manager = getManager();
  manager.init();

  const encoder = new TextEncoder();
  let writerFn: ((data: string) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial snapshot immediately
      const snapshot = manager.getSnapshot();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));

      // Register for live updates
      writerFn = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          if (writerFn) manager.removeClient(writerFn);
        }
      };
      manager.addClient(writerFn);
    },
    cancel() {
      if (writerFn) manager.removeClient(writerFn);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
