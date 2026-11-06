// Memory ids that YAML reads as numbers (TSR-5K4DQR). Base36 ids are written unquoted, by Go too,
// so `000681`, `1e5678` and `0x1f2a` are plain scalars that resolve to 681, Infinity and 7978.
// Go's yaml.v3 keeps the literal text in a string field; the TS server once answered with id
// "681" and then failed every action on it with `memory "681" not found` (seen as a flaky REST
// parity failure: a randomly generated id was all digits with a leading zero).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GO_BIN,
  hasGoBin,
  mask,
  type Side,
  seedTemplate,
  send,
  startSide,
  stopSide,
  testEnv,
} from "./harness.ts";

setDefaultTimeout(120_000);

const IDS = ["000681", "1e5678", "0x1f2a"];
const J = { "Content-Type": "application/json" };
let go: Side;
let ts: Side;

/** Creates one memory per id through Go, then gives each its numeric-looking id. */
function seedNumericMemories(dir: string): void {
  const home = join(dir, "..", "home");
  const memDir = join(dir, ".knowns", "memory");
  for (const id of IDS) {
    const before = new Set(readdirSync(memDir));
    const r = Bun.spawnSync(
      [
        GO_BIN as string,
        "memory",
        "create",
        `Memory ${id}`,
        "--category",
        "pattern",
        "--status",
        "active",
        "-c",
        `body of ${id}`,
      ],
      { cwd: dir, env: testEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error(`go memory create: ${r.stderr.toString()}`);
    const file = readdirSync(memDir).find((f) => !before.has(f)) as string;
    const oldId = file.replace(/^memory-/, "").replace(/\.md$/, "");
    const text = readFileSync(join(memDir, file), "utf8").replace(`id: ${oldId}\n`, `id: ${id}\n`);
    writeFileSync(join(memDir, file), text);
    renameSync(join(memDir, file), join(memDir, `memory-${id}.md`));
  }
}

beforeAll(async () => {
  if (!hasGoBin) return;
  const tpl = seedTemplate();
  seedNumericMemories(tpl);
  go = await startSide("go", tpl);
  ts = await startSide("ts", tpl);
});
afterAll(() => {
  if (go) stopSide(go);
  if (ts) stopSide(ts);
});

async function both(method: string, path: string, body?: unknown): Promise<void> {
  const opts = body === undefined ? {} : { body: JSON.stringify(body), headers: J };
  const a = await send(go, method, path, opts);
  const b = await send(ts, method, path, opts);
  // updatedAt is stamped by each server's clock.
  const clean = (t: string, s: Side) =>
    mask(t, s).replace(/"updatedAt":"[^"]*"/g, '"updatedAt":"<t>"');
  expect({ status: b.status, body: clean(b.text, ts) }).toEqual({
    status: a.status,
    body: clean(a.text, go),
  });
}

describe.skipIf(!hasGoBin)("numeric-looking memory ids over REST match Go", () => {
  test("list", () => both("GET", "/api/memories"));
  for (const id of IDS) {
    test(`${id}: get, action, update, get`, async () => {
      await both("GET", `/api/memories/${id}`);
      await both("POST", `/api/memories/${id}/action`, { action: "archive" });
      await both("PUT", `/api/memories/${id}`, { title: `Changed ${id}` });
      await both("GET", `/api/memories/${id}`);
    });
  }
  test("the TS server answers with the literal id", async () => {
    const r = await send(ts, "GET", "/api/memories/000681");
    expect(r.status).toBe(200);
    expect(r.text).toContain('"id":"000681"');
  });
});
