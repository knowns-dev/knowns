// AC-4: locks are cross-process and interoperate with locks held by the Go binary on the same
// project. The Go side is cli/test/helpers/go-helper.go, which takes the REAL Go locks
// (Store.WithTaskLifecycleTransaction, WithSyncLocks, WithDecisionMemoryMigrationLock).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireFileLock,
  historyEntityLockPath,
  memoryMutationLockPath,
  safeHistoryId,
  tryAcquireFileLock,
  withDecisionLifecycleLock,
  withDecisionMemoryMigrationLock,
  withDocMutationLocks,
  withFileLock,
  withMemoryMutationLocks,
  withSyncLocks,
  withTaskLifecycleLock,
} from "../src/storage/core/index.ts";
import { hasGoHelper, runHelper, startHelper, tempDir } from "./helpers/go-helper.ts";

const work = mkdtempSync(join(tmpdir(), "knowns-locks-"));
let n = 0;
/** A fresh knowledge root per test so locks never leak between tests. */
const freshRoot = () => {
  const root = join(work, `proj${n++}`, ".knowns");
  mkdirSync(root, { recursive: true });
  return root;
};
const home = tempDir("knowns-locks-home-");
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const goTest = (name: string, fn: () => Promise<void> | void, timeout = 30_000) =>
  test.skipIf(!hasGoHelper())(name, fn, timeout);

beforeAll(() => {
  hasGoHelper(); // build once, outside any timed assertion
}, 120_000);

describe("in-process semantics", () => {
  test("callers queue FIFO and never overlap", async () => {
    const path = join(freshRoot(), ".search/locks/tasks.lock");
    const events: string[] = [];
    const run = (label: string, ms: number) =>
      withFileLock(path, async () => {
        events.push(`start ${label}`);
        await sleep(ms);
        events.push(`end ${label}`);
      });
    await Promise.all([run("a", 40), run("b", 10), run("c", 10)]);
    expect(events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("returns fn's value and releases the lock when fn throws", async () => {
    const path = join(freshRoot(), "x.lock");
    expect(await withFileLock(path, () => 42)).toBe(42);
    await expect(
      withFileLock(path, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const again = tryAcquireFileLock(path);
    expect(again).not.toBeNull();
    again?.release();
  });

  test("an aborted waiter leaves the queue and the next caller still runs", async () => {
    const path = join(freshRoot(), "x.lock");
    const ac = new AbortController();
    const first = withFileLock(path, () => sleep(80));
    const aborted = withFileLock(path, () => "never", { signal: ac.signal });
    const third = withFileLock(path, () => "third");
    ac.abort(new Error("cancelled"));
    await expect(aborted).rejects.toThrow("cancelled");
    expect(await third).toBe("third");
    await first;
  });

  test("timeoutMs rejects while another holder keeps the lock", async () => {
    const path = join(freshRoot(), "x.lock");
    const held = await acquireFileLock(path);
    // A second descriptor in the same process conflicts exactly as a second process would.
    await expect(acquireFileLock(path, { timeoutMs: 100 })).rejects.toThrow();
    held.release();
    const after = await acquireFileLock(path, { timeoutMs: 100 });
    after.release();
  });

  test("an already aborted signal never takes the lock", async () => {
    const path = join(freshRoot(), "x.lock");
    await expect(
      withFileLock(path, () => 1, { signal: AbortSignal.abort(new Error("no")) }),
    ).rejects.toThrow("no");
    expect(existsSync(path)).toBe(false);
  });

  test("lock files are created empty with mode 0600 and parent directories 0755", async () => {
    const root = freshRoot();
    await withTaskLifecycleLock(root, () => {});
    const file = join(root, ".search", "locks", "tasks.lock");
    expect(statSync(file).size).toBe(0);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, ".search", "locks")).mode & 0o777).toBe(0o755);
    }
  });

  test("memory locks are taken in sorted, de-duplicated order", async () => {
    const lockRoot = freshRoot();
    const order: string[] = [];
    await withMemoryMutationLocks(["b", "a", "b", ""], () => void order.push("body"), { lockRoot });
    expect(order).toEqual(["body"]);
    expect(existsSync(memoryMutationLockPath(lockRoot, "a"))).toBe(true);
    expect(existsSync(memoryMutationLockPath(lockRoot, "b"))).toBe(true);
    expect(existsSync(memoryMutationLockPath(lockRoot, ""))).toBe(false);
  });
});

describe("lock file names (Go: internal/storage/*_lock*.go)", () => {
  test("safeHistoryId keeps safe ids and hashes the rest", () => {
    expect(safeHistoryId("KN-ABC123")).toBe("KN-ABC123");
    expect(safeHistoryId(" abc ")).toBe("abc");
    expect(safeHistoryId("")).toBe("empty");
    expect(safeHistoryId("mutation:guides/setup")).toMatch(/^[0-9a-f]{64}$/);
    expect(safeHistoryId("ünï")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("history, memory and doc-mutation lock paths", () => {
    const root = "/r";
    expect(historyEntityLockPath(root, "task", "KN-ABC123")).toBe(
      join(root, "history/locks/task-KN-ABC123.lock"),
    );
    expect(memoryMutationLockPath("/g", "abc123")).toBe(
      join("/g", ".search/locks/memories/abc123.lock"),
    );
  });

  goTest("the doc mutation lock name is exactly the file the Go binary creates", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold", root, "300", "docs/guides/setup.md"], home);
    await hold.waitFor("HELD");
    const created = join(
      root,
      "history",
      "locks",
      `doc-${safeHistoryId("mutation:guides/setup")}.lock`,
    );
    expect(existsSync(created)).toBe(true);
    await hold.exited;
  });

  goTest(
    "the lifecycle, decision and migration lock names are exactly the files Go creates",
    async () => {
      const root = freshRoot();
      for (const [args, file] of [
        [["hold", root, "100"], "tasks.lock"],
        [["hold", root, "100", "decisions/x.md"], "decisions.lock"],
        [["hold-migration", root, "100"], "decision-memory-migration.lock"],
      ] as const) {
        const hold = startHelper([...args], home);
        await hold.waitFor("HELD");
        expect(existsSync(join(root, ".search", "locks", file)), file).toBe(true);
        await hold.exited;
      }
    },
  );
});

describe("TypeScript <-> TypeScript across processes", () => {
  test("a second process waits for the first and runs after it releases", async () => {
    const path = join(freshRoot(), ".search/locks/tasks.lock");
    const script = join(import.meta.dir, "helpers", "hold-lock.ts");
    const child = spawn(process.execPath, [script, path, "400"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exited = new Promise<void>((res) => child.on("exit", () => res()));
    while (!out.includes("HELD")) await sleep(10);

    const t0 = Date.now();
    await withFileLock(path, () => {});
    const waited = Date.now() - t0;
    await exited;
    expect(out).toContain("RELEASED");
    expect(waited).toBeGreaterThanOrEqual(300);
  });

  test("tryAcquireFileLock fails while another process holds the lock", async () => {
    const path = join(freshRoot(), "try.lock");
    const script = join(import.meta.dir, "helpers", "hold-lock.ts");
    const child = spawn(process.execPath, [script, path, "300"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    const exited = new Promise<void>((res) => child.on("exit", () => res()));
    while (!out.includes("HELD")) await sleep(10);
    expect(tryAcquireFileLock(path)).toBeNull();
    await exited;
    const got = tryAcquireFileLock(path);
    expect(got).not.toBeNull();
    got?.release();
  });

  test("a killed holder releases the lock (no stale lock files to clean up)", async () => {
    const path = join(freshRoot(), "kill.lock");
    const script = join(import.meta.dir, "helpers", "hold-lock.ts");
    const child = spawn(process.execPath, [script, path, "60000"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    while (!out.includes("HELD")) await sleep(10);
    expect(tryAcquireFileLock(path)).toBeNull();
    child.kill("SIGKILL");
    await new Promise<void>((res) => child.on("exit", () => res()));
    const got = await acquireFileLock(path, { timeoutMs: 2000 });
    got.release();
  });
});

describe("Go holds, TypeScript waits", () => {
  goTest("the task lifecycle lock: TS runs only after Go releases", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold", root, "600"], home);
    await hold.waitFor("HELD");
    const heldAt = Date.now();

    let ranAt = 0;
    await withTaskLifecycleLock(root, () => {
      ranAt = Date.now();
    });
    await hold.exited;
    expect(hold.lines).toEqual(["HELD", "RELEASED"]);
    expect(ranAt - heldAt).toBeGreaterThanOrEqual(450);
  });

  goTest("TS gives up the way Go does when its deadline passes first", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold", root, "900"], home);
    await hold.waitFor("HELD");
    const t0 = Date.now();
    await expect(withTaskLifecycleLock(root, () => {}, { timeoutMs: 150 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(600);
    await hold.exited;
  });

  goTest("the decision lifecycle lock", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold", root, "500", "decisions/20261103-0905-x.md"], home);
    await hold.waitFor("HELD");
    const t0 = Date.now();
    await withDecisionLifecycleLock(root, () => {});
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    await hold.exited;
  });

  goTest("the decision/memory migration lock", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold-migration", root, "500"], home);
    await hold.waitFor("HELD");
    const t0 = Date.now();
    await withDecisionMemoryMigrationLock(root, () => {});
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    await hold.exited;
  });

  goTest(
    "the per-doc mutation lock (path normalized like Go: leading slash and .md dropped)",
    async () => {
      const root = freshRoot();
      const hold = startHelper(["hold", root, "500", "docs/guides/setup.md"], home);
      await hold.waitFor("HELD");
      const t0 = Date.now();
      await withDocMutationLocks(root, ["/guides/setup.md"], () => {});
      expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
      await hold.exited;
    },
  );

  goTest("WithSyncLocks in TS and Go hold the same set of locks", async () => {
    const root = freshRoot();
    const rels = ["tasks/a.md", "decisions/b.md", "docs/x/y.md", "config.json"];
    const hold = startHelper(["hold", root, "500", ...rels], home);
    await hold.waitFor("HELD");
    const t0 = Date.now();
    const waits = await Promise.all(
      [
        withTaskLifecycleLock(root, () => Date.now() - t0),
        withDecisionLifecycleLock(root, () => Date.now() - t0),
        withDocMutationLocks(root, ["x/y"], () => Date.now() - t0),
      ].map((p) => p),
    );
    for (const waited of waits) expect(waited).toBeGreaterThanOrEqual(350);
    await hold.exited;
  });

  goTest("unrelated locks do not block each other", async () => {
    const root = freshRoot();
    const hold = startHelper(["hold", root, "500"], home); // tasks.lock only
    await hold.waitFor("HELD");
    const t0 = Date.now();
    await withDecisionLifecycleLock(root, () => {});
    await withDecisionMemoryMigrationLock(root, () => {});
    await withDocMutationLocks(root, ["other"], () => {});
    expect(Date.now() - t0).toBeLessThan(200);
    await hold.exited;
  });
});

describe("TypeScript holds, Go waits", () => {
  goTest("Go times out while TS holds the task lock, then acquires once TS releases", async () => {
    const root = freshRoot();
    await withTaskLifecycleLock(root, async () => {
      const lines = runHelper(["try", root, "300"], home);
      expect(lines[0]).toStartWith("TIMEOUT");
    });
    const lines = runHelper(["try", root, "2000"], home);
    expect(lines[0]).toStartWith("ACQUIRED");
  });

  goTest("Go waits for TS to finish, then proceeds (blocking, not failing)", async () => {
    const root = freshRoot();
    let goLine = "";
    await withTaskLifecycleLock(root, async () => {
      const go = startHelper(["try", root, "10000"], home);
      await sleep(400);
      expect(go.lines).toEqual([]); // still waiting
      void go.exited.then(() => {
        goLine = go.lines[0] ?? "";
      });
    });
    // lock released: Go's 20 ms poll picks it up
    for (let i = 0; i < 100 && goLine === ""; i++) await sleep(20);
    expect(goLine).toMatch(/^ACQUIRED (\d+)$/);
    expect(Number(goLine.split(" ")[1])).toBeGreaterThanOrEqual(350);
  });

  goTest("decision lock, migration lock and doc mutation lock held by TS block Go", async () => {
    const root = freshRoot();
    await withDecisionLifecycleLock(root, () => {
      expect(runHelper(["try", root, "200", "decisions/x.md"], home)[0]).toStartWith("TIMEOUT");
      expect(runHelper(["try", root, "200", "tasks/x.md"], home)[0]).toStartWith("ACQUIRED");
    });
    await withDecisionMemoryMigrationLock(root, () => {
      expect(runHelper(["try-migration", root, "200"], home)[0]).toStartWith("TIMEOUT");
    });
    await withDocMutationLocks(root, ["guides/setup"], () => {
      expect(runHelper(["try", root, "200", "docs/guides/setup.md"], home)[0]).toStartWith(
        "TIMEOUT",
      );
      expect(runHelper(["try", root, "200", "docs/guides/other.md"], home)[0]).toStartWith(
        "ACQUIRED",
      );
    });
    expect(
      runHelper(["try", root, "500", "decisions/x.md", "docs/guides/setup.md"], home)[0],
    ).toStartWith("ACQUIRED");
  });

  goTest("withSyncLocks in TS blocks Go's WithSyncLocks over the same paths", async () => {
    const root = freshRoot();
    await withSyncLocks(root, ["tasks/a.md", "decisions/b.md", "docs/p/q.md"], () => {
      for (const rel of ["tasks/z.md", "decisions/z.md", "docs/p/q.md"]) {
        expect(runHelper(["try", root, "200", rel], home)[0], rel).toStartWith("TIMEOUT");
      }
      expect(runHelper(["try", root, "200", "docs/p/other.md"], home)[0]).toStartWith("ACQUIRED");
    });
  });
});

describe("the real binary", () => {
  const bin = process.env.KNOWNS_GO_BIN;
  test.skipIf(!bin)(
    "knowns task create blocks while TS holds the task lifecycle lock",
    async () => {
      const project = mkdtempSync(join(work, "cli-"));
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: "1",
        NO_UPDATE_CHECK: "1",
        CI: "1",
        KNOWN_LSP_AUTO_INSTALL: "0",
        KNOWNS_RUNTIME_INLINE: "1",
        KNOWNS_SEMANTIC_RUNTIME_DISABLED: "1",
      };
      const run = (args: string[]) =>
        Bun.spawnSync([bin as string, ...args], { cwd: project, env });
      Bun.spawnSync(["git", "init", "-q", "."], { cwd: project });
      expect(
        run(["init", "locks", "--no-wizard", "--no-open", "--task-prefix", "LK"]).exitCode,
      ).toBe(0);

      const root = join(project, ".knowns");
      let finished = 0;
      let started = 0;
      await withTaskLifecycleLock(root, async () => {
        started = Date.now();
        const child = spawn(
          bin as string,
          ["task", "create", "blocked until released", "--plain"],
          {
            cwd: project,
            env,
            stdio: "ignore",
          },
        );
        child.on("exit", () => {
          finished = Date.now();
        });
        await sleep(1200);
        expect(finished).toBe(0); // the CLI is waiting on our lock
      });
      for (let i = 0; i < 300 && finished === 0; i++) await sleep(20);
      expect(finished).toBeGreaterThan(started + 1000);
      const listing = run(["task", "list", "--plain"]).stdout.toString();
      expect(listing).toContain("blocked until released");
    },
    60_000,
  );
});
