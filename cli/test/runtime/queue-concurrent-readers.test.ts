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

// A test that times out is not cancelled: bun reports it and moves on while its body keeps
// running, and its finally block then restores the environment during the NEXT files (that is how
// one slow Windows run once pointed queue.test.ts at this test's deleted runtime root). So the
// environment is also restored, and the readers killed, in afterAll, and the body gives up on its
// own well before bun's timeout and says how far it got.
const spawned: { kill: () => void }[] = [];
const prevRuntimeRoot = process.env.KNOWNS_RUNTIME_ROOT;
const restoreRuntimeRoot = (): void => {
  if (prevRuntimeRoot === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
  else process.env.KNOWNS_RUNTIME_ROOT = prevRuntimeRoot;
};
// The default run is sized for a shared CI runner (a Windows runner with real-time scanning is
// several times slower than a dev box): two readers and 100 updates, the same assertions. The
// stress version, four tight readers and 300 updates, is what the loaded Windows gate runs:
// KNOWNS_QUEUE_STRESS=1.
const STRESS = process.env.KNOWNS_QUEUE_STRESS === "1";
const READERS = STRESS ? 4 : 2;
const UPDATES = STRESS ? 300 : 100;
/** The writer stops after this long; bun's own limit for the test is twice that. */
const WRITER_BUDGET_MS = STRESS ? 60_000 : 30_000;

afterAll(() => {
  for (const proc of spawned) proc.kill();
  restoreRuntimeRoot();
  rmSync(root, { recursive: true, force: true });
});

test(
  "queue updates and cross-process reads never fail each other",
  async () => {
    const runtimeRoot = join(root, "runtime");
    const storeRoot = join(root, "store");
    const stop = join(root, "stop");
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
      while (!existsSync(stop)) {
        try { loadQueue(storeRoot); reads++; } catch (e) { errors.push(String(e?.code ?? e)); }
      }
      console.log(JSON.stringify({ reads, errors: errors.slice(0, 5), errorCount: errors.length }));
    `;
      const readers = Array.from({ length: READERS }, (_, i) => i).map((i) => {
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
        spawned.push(proc);
        return { proc, ready };
      });
      const deadline = Date.now() + 30_000;
      while (!readers.every((r) => existsSync(r.ready)) && Date.now() < deadline)
        await Bun.sleep(20);
      expect(readers.every((r) => existsSync(r.ready))).toBe(true);

      const updateErrors: string[] = [];
      const started = Date.now();
      let updates = 0;
      for (let i = 0; i < UPDATES && Date.now() - started < WRITER_BUDGET_MS; i++) {
        updates++;
        try {
          updateQueue(storeRoot, (s) => {
            s.recent = [];
          });
        } catch (e) {
          updateErrors.push(String((e as NodeJS.ErrnoException).code ?? e));
        }
        if (i % 10 === 0) await Bun.sleep(1);
      }
      const elapsedMs = Date.now() - started;
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
      const reads = results.reduce((n, r) => n + r.reads, 0);
      // Says how far a slow run got instead of a bare timeout.
      const progress = `progress: ${updates}/${UPDATES} updates in ${elapsedMs} ms (${updateErrors.length} failed), ${reads} reads`;
      console.log(progress);
      expect(updates, progress).toBe(UPDATES);
      expect(updateErrors.slice(0, 5), progress).toEqual([]);
      expect(results.map((r) => r.errors)).toEqual(Array.from({ length: READERS }, () => []));
      // Not vacuous: the readers actually overlapped the updates.
      expect(reads).toBeGreaterThan(UPDATES);
      expect(loadQueue(storeRoot).updatedAt).toBeDefined();
    } finally {
      // A failure or timeout must not leave readers spinning: they would starve later runtime tests.
      writeFileSync(stop, "1");
      for (const proc of spawned) proc.kill();
      restoreRuntimeRoot();
    }
  },
  WRITER_BUDGET_MS * 2,
);

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
