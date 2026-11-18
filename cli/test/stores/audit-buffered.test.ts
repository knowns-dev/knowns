// KN-ZSGXK9: a daemon-hosted session must not wait on the file system per tool call, so the audit
// event is buffered and written in a batch; the bytes on disk equal the synchronous append's.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AuditStore, flushAudit } from "../../src/storage/stores/audit-store.ts";
import { tmp } from "./helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const ev = (i: number) => ({
  timestamp: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
  toolName: "tasks",
  action: "get",
  actionClass: "read" as const,
  result: "success" as const,
  durationMs: 5,
});

describe("AuditStore.appendBuffered", () => {
  test("writes the same lines as append, in order, after a flush or on the next read", async () => {
    const a = tmp();
    const b = tmp();
    roots.push(a, b);
    const sync = new AuditStore(a);
    const buf = new AuditStore(b);
    for (let i = 1; i <= 20; i++) {
      sync.append(ev(i));
      buf.appendBuffered(ev(i));
    }
    // A read sees buffered events (read-after-write inside the process).
    expect(buf.recent(5).map((e) => e.timestamp)).toEqual(sync.recent(5).map((e) => e.timestamp));
    for (let i = 21; i <= 40; i++) {
      sync.append(ev(i));
      buf.appendBuffered(ev(i));
    }
    await flushAudit();
    expect(readFileSync(join(b, "audit.jsonl"), "utf8")).toBe(
      readFileSync(join(a, "audit.jsonl"), "utf8"),
    );
  });

  test("a background flush writes without any explicit flush", async () => {
    const r = tmp();
    roots.push(r);
    const buf = new AuditStore(r);
    buf.appendBuffered(ev(1));
    await Bun.sleep(300);
    expect(readFileSync(join(r, "audit.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });
});
