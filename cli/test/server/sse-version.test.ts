// KN-ZV8WGG: the first SSE event names the server version, so a tab left open across an upgrade
// can tell on reconnect that the server it talks to is no longer the one that served its UI.
import { expect, test } from "bun:test";
import { SSEBroker } from "../../src/server/sse.ts";
import { VERSION } from "../../src/version.ts";

test("the connected event carries the server version", async () => {
  const ac = new AbortController();
  const res = new SSEBroker().subscribe(ac.signal);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const m = /^event: connected\ndata: (.*)\n\n$/.exec(text);
  expect(m).not.toBeNull();
  const data = JSON.parse(m?.[1] ?? "{}") as { timestamp: number; version: string };
  expect(data.version).toBe(VERSION);
  expect(typeof data.timestamp).toBe("number");
  await reader.cancel();
});
