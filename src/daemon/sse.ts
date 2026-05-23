type Client = { id: number; controller: ReadableStreamDefaultController<Uint8Array> };

const enc = new TextEncoder();
const clients = new Map<number, Client>();
let nextId = 1;

export function attachSse(): Response {
  const id = nextId++;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      clients.set(id, { id, controller });
      controller.enqueue(enc.encode(": connected\n\n"));
    },
    cancel() { clients.delete(id); },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

export function broadcast(event: string, data: unknown): void {
  const payload = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of clients.values()) {
    try { c.controller.enqueue(payload); } catch { clients.delete(c.id); }
  }
}
