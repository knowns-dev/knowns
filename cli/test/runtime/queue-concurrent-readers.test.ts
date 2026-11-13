// TSR-5EEY7V (from contributor PR #157): loadQueue reads without the queue lock, and on Windows a
// rename over a file another process holds open can fail with "Access is denied". Readers in
// other processes (a CLI polling for its job while the daemon updates the queue) must not fail
// an update, or be failed by one. Readers run as separate processes: inside one process a
// synchronous read never overlaps a write.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isWindowsFileBusy, loadQueue, updateQueue } from "../../src/runtime/queue.ts";

const QUEUE = resolve(import.meta.dir, "..", "..", "src", "runtime", "queue.ts");
const root = mkdtempSync(join(tmpdir(), "knowns-queue-readers-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("queue updates and cross-process reads never fail each other", async () => {
  const runtimeRoot = join(root, "runtime");
  const storeRoot = join(root, "store");
  const stop = join(root, "stop");
  const prev = process.env.KNOWNS_RUNTIME_ROOT;
  process.env.KNOWNS_RUNTIME_ROOT = runtimeRoot;
  try {
    updateQueue(storeRoot, () => {});

    const reader = `
      const { loadQueue } = await import(${JSON.stringify(QUEUE)});
      const { existsSync, writeFileSync } = await import("node:fs");
      const { READER_STORE: storeRoot, READER_STOP: stop, READER_READY: ready } = process.env;
      let reads = 0;
      const errors = [];
      writeFileSync(ready, "1");
      // Real readers poll (waitForJob every 200 ms). A reader with no pause at all keeps the file
      // open almost continuously, so on a 2-core runner four of them starve the writer's rename
      // past its 2 s retry budget: a load no Knowns process produces. A 1 ms pause still overlaps
      // every update while leaving the writer the gaps a real poller leaves.
      while (!existsSync(stop)) {
        try { loadQueue(storeRoot); reads++; } catch (e) { errors.push(String(e?.code ?? e)); }
        Bun.sleepSync(1);
      }
      console.log(JSON.stringify({ reads, errors: errors.slice(0, 5), errorCount: errors.length }));
    `;
    const readers = [0, 1, 2, 3].map((i) => {
      const ready = join(root, `ready-${i}`);
      const proc = Bun.spawn([process.execPath, "-e", reader], {
        env: {
          ...process.env,
          KNOWNS_RUNTIME_ROOT: runtimeRoot,
          READER_STORE: storeRoot,
          READER_STOP: stop,
          READER_READY: ready,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { proc, ready };
    });
    const deadline = Date.now() + 30_000;
    while (!readers.every((r) => existsSync(r.ready)) && Date.now() < deadline) await Bun.sleep(20);
    expect(readers.every((r) => existsSync(r.ready))).toBe(true);

    const updateErrors: string[] = [];
    for (let i = 0; i < 300; i++) {
      try {
        updateQueue(storeRoot, (s) => {
          s.recent = [];
        });
      } catch (e) {
        updateErrors.push(String((e as NodeJS.ErrnoException).code ?? e));
      }
      if (i % 20 === 0) await Bun.sleep(1);
    }
    writeFileSync(stop, "1");

    const results = await Promise.all(
      readers.map(async ({ proc }) => {
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        if (err.trim() !== "") throw new Error(`reader stderr: ${err}`);
        return JSON.parse(out) as { reads: number; errors: string[]; errorCount: number };
      }),
    );
    expect(updateErrors.slice(0, 5)).toEqual([]);
    expect(results.map((r) => r.errors)).toEqual([[], [], [], []]);
    // Not vacuous: the readers actually overlapped the updates.
    expect(results.reduce((n, r) => n + r.reads, 0)).toBeGreaterThan(300);
    expect(loadQueue(storeRoot).updatedAt).toBeDefined();
  } finally {
    if (prev === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
    else process.env.KNOWNS_RUNTIME_ROOT = prev;
  }
}, 120_000);

test("only Windows access-denied, sharing and lock violations count as a busy file", () => {
  const e = (code: string) => Object.assign(new Error(code), { code });
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    expect(isWindowsFileBusy(e(code), "win32")).toBe(true);
    expect(isWindowsFileBusy(e(code), "linux")).toBe(false);
    expect(isWindowsFileBusy(e(code), "darwin")).toBe(false);
  }
  expect(isWindowsFileBusy(e("ENOENT"), "win32")).toBe(false);
  expect(isWindowsFileBusy(undefined, "win32")).toBe(false);
});
