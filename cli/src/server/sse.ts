// internal/server/sse.go: a broker that fans named SSE events out to every subscriber. A full
// client queue (64 events) drops the event instead of blocking the sender.
import { goEncode } from "./gojson.ts";

export interface SSEEvent {
  type: string;
  data: unknown;
}

export interface Broadcaster {
  broadcast(event: SSEEvent): void;
}

const QUEUE = 64;

interface Client {
  push(chunk: string): boolean;
  pending: number;
  close(): void;
}

export class SSEBroker implements Broadcaster {
  private clients = new Set<Client>();

  get size(): number {
    return this.clients.size;
  }

  /** GET /api/events */
  subscribe(signal?: AbortSignal): Response {
    const enc = new TextEncoder();
    let client: Client | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const c: Client = {
          pending: 0,
          push: (chunk) => {
            // desiredSize drops below zero once the consumer stops reading: Go's full channel.
            if ((controller.desiredSize ?? 1) <= -QUEUE) return false;
            try {
              controller.enqueue(enc.encode(chunk));
              return true;
            } catch {
              return false;
            }
          },
          close: () => {
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
        };
        client = c;
        this.clients.add(c);
        c.push(`event: connected\ndata: {"timestamp":${Date.now()}}\n\n`);
        signal?.addEventListener("abort", () => this.clients.delete(c));
      },
      cancel: () => {
        if (client) this.clients.delete(client);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  broadcast(event: SSEEvent): void {
    let payload: string;
    try {
      payload = goEncode(event.data).slice(0, -1);
    } catch {
      return;
    }
    const chunk = `event: ${event.type}\ndata: ${payload}\n\n`;
    for (const c of [...this.clients]) {
      if (!c.push(chunk)) {
        // Go drops the event for a stuck client and keeps it subscribed.
      }
    }
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
    this.clients.clear();
  }
}
