// The runner's reconcile and indexing off the daemon's main thread (@task-KN-A2VZN1): the worker
// host's failure handling with scripted workers, and a real daemon editing a watched doc with the
// workers on and off, which must leave the same files behind.
import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { readDescriptor } from "../../src/runtime/mcp-endpoint.ts";
import type { Job } from "../../src/runtime/queue.ts";
import * as q from "../../src/runtime/queue.ts";
import { RunnerWorker } from "../../src/runtime/runner-worker.ts";
import { VERSION } from "../../src/version.ts";
import { makeSandbox } from "../mcp/harness.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const job = { id: "j1", kind: "index-doc", target: "x" } as unknown as Job;

function script(body: string): () => Worker {
  const file = join(mkdtempSync(join(tmpdir(), "kn-rw-")), "w.mjs");
  writeFileSync(file, body);
  return () => new Worker(file);
}
const ECHO = `import {parentPort} from 'node:worker_threads';
parentPort.on('message', m => {
  if (m.t === 'job') parentPort.postMessage({t:'done', id:m.id, ...(m.job.target === 'bad' ? {error:'boom'} : {})});
  if (m.t === 'watch') parentPort.on('message', u => { if (u.t === 'unwatch' && u.id === m.id) parentPort.postMessage({t:'ended', id:m.id}); });
});`;

describe("RunnerWorker idles out", () => {
  const counting = () => {
    const make = script(ECHO);
    const state = { spawned: 0 };
    return {
      state,
      spawn: () => {
        state.spawned++;
        return make();
      },
    };
  };

  test("a worker with nothing to do is ended, and the next job starts a fresh one", async () => {
    const { state, spawn } = counting();
    const rw = new RunnerWorker(spawn, 60_000, 100);
    await rw.runJob("/s", job);
    expect(rw.running).toBe(true);
    await sleep(350);
    expect(rw.running).toBe(false);
    await rw.runJob("/s", job);
    expect(state.spawned).toBe(2);
    await rw.stop();
  });

  test("a watcher keeps the worker alive for as long as it runs, and the worker idles out after it", async () => {
    const { spawn } = counting();
    const rw = new RunnerWorker(spawn, 60_000, 100);
    const ac = new AbortController();
    const watching = rw.watch(ac.signal, "/s");
    await sleep(400);
    expect(rw.running).toBe(true);
    ac.abort();
    await watching;
    await sleep(350);
    expect(rw.running).toBe(false);
    await rw.stop();
  });

  test("a job that arrives as the idle timer fires is run, never lost", async () => {
    const { spawn } = counting();
    const rw = new RunnerWorker(spawn, 60_000, 60);
    await rw.runJob("/s", job);
    for (let i = 0; i < 15; i++) {
      await sleep(52 + (i % 5) * 4); // straddles the 60 ms expiry
      await rw.runJob("/s", job);
    }
    await rw.stop();
  });

  test("stop ends an idle worker and cancels its timer", async () => {
    const { spawn } = counting();
    const rw = new RunnerWorker(spawn, 60_000, 100);
    await rw.runJob("/s", job);
    await rw.stop();
    expect(rw.running).toBe(false);
    await sleep(250); // no timer left to fire into a stopped host
  });
});

describe("RunnerWorker", () => {
  test("a job runs in the worker and its error comes back", async () => {
    const w = new RunnerWorker(script(ECHO), 5000);
    await w.runJob("/s", job);
    await expect(w.runJob("/s", { ...job, target: "bad" } as Job)).rejects.toThrow("boom");
    await w.stop();
  });

  test("a watcher runs until its signal aborts", async () => {
    const w = new RunnerWorker(script(ECHO), 5000);
    const ac = new AbortController();
    let ended = false;
    const p = w.watch(ac.signal, "/s").then(() => {
      ended = true;
    });
    await sleep(100);
    expect(ended).toBe(false);
    ac.abort();
    await p;
    expect(ended).toBe(true);
    await w.stop();
  });

  test("a crashed worker fails its call and the next call gets a fresh worker", async () => {
    let n = 0;
    const crash = script("throw new Error('crash')");
    const echo = script(ECHO);
    const w = new RunnerWorker(() => (n++ === 0 ? crash() : echo()), 5000);
    await expect(w.runJob("/s", job)).rejects.toThrow();
    await w.runJob("/s", job);
    expect(n).toBe(2);
    await w.stop();
  });

  test("a stuck job is cut at its deadline without blocking the event loop", async () => {
    let n = 0;
    const spin = script("for(;;){}");
    const echo = script(ECHO);
    const w = new RunnerWorker(() => (n++ === 0 ? spin() : echo()), 600);
    // The loop is "not blocked" if no gap between two timer ticks gets near the 600 ms deadline. A tick
    // count is not a measure of that: Windows timers fire about every 15.6 ms whatever the interval
    // (10 ticks in 150 ms with no worker at all) and a shared runner is slower still, so a count
    // failed there (5 ticks) while the loop kept turning (measured on a Windows PC: baseline 10
    // ticks, max gap 16 ms; with the stuck worker 9 to 11 ticks, max gap 16 ms).
    const stamps: number[] = [performance.now()];
    const t = setInterval(() => stamps.push(performance.now()), 5);
    await expect(w.runJob("/s", job)).rejects.toThrow(/timed out/);
    stamps.push(performance.now());
    clearInterval(t);
    const maxGap = Math.max(...stamps.slice(1).map((s, i) => s - (stamps[i] as number)));
    // A blocked loop shows a gap as long as the deadline; a loaded host adds up to a few hundred ms
    // (a cold worker start measured 200 ms on a busy Mac).
    expect(maxGap).toBeLessThan(400);
    await w.runJob("/s", job); // restarted
    await w.stop();
  });

  test("a stopped worker refuses new work and starts nothing", async () => {
    let n = 0;
    const w = new RunnerWorker(() => {
      n++;
      return script(ECHO)();
    }, 5000);
    await w.stop();
    await expect(w.runJob("/s", job)).rejects.toThrow(/stopped/);
    expect(n).toBe(0);
  });
});

// --- a real daemon -----------------------------------------------------------------------------

const CLI_ROOT = join(import.meta.dir, "..", "..");
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

/**
 * path:size, so an appended history file counts as a change, not only a new file. The daemon is
 * still writing while this walks: an atomic write leaves a temp file (.lifecycle-durable-*.tmp)
 * that is renamed away between readdir and stat. A file that vanished is not left behind, so it is
 * skipped; any other error still fails the walk.
 */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const gone = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";
  const walk = (d: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch (e) {
      if (gone(e)) return;
      throw e;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        out.push(`${relative(root, p).replaceAll("\\", "/")}:${statSync(p).size}`);
      } catch (err) {
        if (!gone(err)) throw err;
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** Edits a doc in a project served by a daemon and returns the files the reconcile added. */
async function editThroughDaemon(workers: "0" | "1"): Promise<string[]> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "kn-rw-d-")));
  const home = join(base, "home");
  const runtime = join(base, "runtime");
  mkdirSync(home);
  mkdirSync(runtime);
  const sb = makeSandbox("full");
  const daemon = Bun.spawn(
    [process.execPath, join(CLI_ROOT, "src", "main.ts"), "__runtime", "run"],
    {
      cwd: base,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32"
          ? {
              SystemRoot: process.env.SystemRoot ?? "",
              windir: process.env.windir ?? "",
              TEMP: home,
              TMP: home,
              APPDATA: home,
              LOCALAPPDATA: home,
            }
          : {}),
        HOME: home,
        USERPROFILE: home,
        KNOWNS_RUNTIME_ROOT: runtime,
        KNOWNS_RUNNER_WORKER: workers,
        KNOWNS_LSP_DAEMON: "0",
        KNOWN_LSP_AUTO_INSTALL: "0",
        NO_UPDATE_CHECK: "1",
        CI: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  procs.push(daemon);
  const until = async <T>(
    f: () => T | undefined | false,
    label: string,
    ms = 30_000,
  ): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      const v = f();
      if (v) return v;
      if (Date.now() > end) throw new Error(`${label} not met in time`);
      await sleep(50);
    }
  };
  try {
    const d = await until(() => readDescriptor(VERSION, runtime), "descriptor");
    const sock = net.connect({ path: d.address });
    sock.on("error", () => undefined);
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("utf8");
    });
    sock.write(
      `${JSON.stringify({ knowns_mcp: 1, type: "hello", version: VERSION, token: d.token, cwd: sb.dir, project: "", pid: process.pid, client: { name: "t" } })}\n`,
    );
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } } })}\n`,
    );
    sock.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "project", arguments: { action: "current" } } })}\n`,
    );
    await until(() => buf.includes('"id":2'), "project reply");
    // The runner starts a watcher for the lease; wait for its startup reconcile to settle.
    await until(
      () => {
        try {
          return JSON.parse(readFileSyncSafe(join(runtime, "status.json"))).projects?.length > 0;
        } catch {
          return false;
        }
      },
      `status projects: ${readFileSyncSafe(join(runtime, "status.json")).slice(0, 300)}`,
    );
    const store = join(sb.dir, ".knowns");
    // The startup reconcile (watcher start, index jobs) runs at its own pace, slower on a loaded
    // machine: a fixed sleep let the edit land in the middle of it, so the history of the two
    // runs differed in length. Wait until the store has been quiet for 2 s instead.
    const settle = async (): Promise<void> => {
      let last = JSON.stringify(listFiles(store));
      let since = Date.now();
      const stop = Date.now() + 40_000;
      while (Date.now() - since < 2000 && Date.now() < stop) {
        await sleep(200);
        const now = JSON.stringify(listFiles(store));
        if (now !== last) {
          last = now;
          since = Date.now();
        }
      }
    };
    await settle();
    const before = new Set(listFiles(store));
    appendFileSync(
      join(store, "docs", "architecture.md"),
      "\n\nAn edit made while a daemon watches.\n",
    );
    // The reconcile appends history for the doc: wait for a new file, then for it to settle.
    await until(
      () => listFiles(store).some((f) => !before.has(f) && !f.startsWith("docs/architecture.md:")),
      "changes after the edit",
    );
    // Settled: the file set has not changed for 2 s (index jobs finish at their own pace).
    let last = JSON.stringify(listFiles(store));
    let since = Date.now();
    const deadline = Date.now() + 40_000;
    while (Date.now() - since < 2000 && Date.now() < deadline) {
      await sleep(200);
      const now = JSON.stringify(listFiles(store));
      if (now !== last) {
        last = now;
        since = Date.now();
      }
    }
    return listFiles(store)
      .filter((f) => !before.has(f) && !f.startsWith("docs/architecture.md:"))
      .map((f) => f.replace(/\d{6,}/g, "N").replace(/[0-9a-f]{16,}/g, "H"));
  } finally {
    daemon.kill();
    await daemon.exited;
  }
}

function readFileSyncSafe(p: string): string {
  try {
    return require("node:fs").readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

describe("a daemon reconciling an edited doc", () => {
  test("worker threads and the main thread leave the same files behind", async () => {
    const on = await editThroughDaemon("1");
    const off = await editThroughDaemon("0");
    expect(on.length).toBeGreaterThan(0);
    // Same files, and sizes that agree to within the timestamps: a time written with its
    // sub-second part trimmed of trailing zeros is a byte or so shorter on some runs (a flaky
    // 1-byte difference on Windows and macOS), while a missing history record is hundreds of bytes.
    const split = (l: string): [string, number] => {
      const i = l.lastIndexOf(":");
      return [l.slice(0, i), Number(l.slice(i + 1))];
    };
    expect(on.map((l) => split(l)[0])).toEqual(off.map((l) => split(l)[0]));
    on.forEach((l, i) => {
      const [name, a] = split(l);
      const [, b] = split(off[i] as string);
      expect({ name, drift: Math.abs(a - b) <= 32 }).toEqual({ name, drift: true });
    });
  }, 120_000);
});

describe("worker failures never throw into the daemon (KN-69EHXE P2-4, P3-3, P3-4)", () => {
  const broken = (): Worker => {
    throw new Error("spawn failed: EMFILE");
  };

  test("P2-4: a worker that cannot start rejects watch and runJob instead of throwing", async () => {
    const rw = new RunnerWorker(broken);
    const w = rw.watch(new AbortController().signal, "/p");
    await expect(w).rejects.toThrow("EMFILE");
    await expect(rw.runJob("/p", job)).rejects.toThrow("EMFILE");
    expect(rw.running).toBe(false);
  });

  test("P2-4: a factory that throws leaves no ghost watcher, and P3-4 backs the retry off", async () => {
    let now = 1_000_000;
    let calls = 0;
    const life = new q.WatchLifecycle(
      () => now,
      () => 0,
    );
    const lease = {
      id: "l",
      projectRoot: "/p",
      watch: true,
      expiresAt: new Date(now + 60_000).toISOString(),
    } as unknown as q.Lease;
    const factory = () => {
      calls++;
      throw new Error("no worker");
    };
    expect(() => life.reconcile([lease], factory)).not.toThrow();
    await sleep(20);
    life.reconcile([lease], factory); // inside the 1 s backoff: not restarted
    expect(calls).toBe(1);
    now += 1500;
    life.reconcile([lease], factory);
    expect(calls).toBe(2);
    await sleep(20);
    now += 1500; // the second failure waits 2 s
    life.reconcile([lease], factory);
    expect(calls).toBe(2);
    now += 1000;
    life.reconcile([lease], factory);
    expect(calls).toBe(3);
  });

  test("P3-3: the next request waits for the terminated thread before starting a new one", async () => {
    let live = 0;
    let peak = 0;
    const mk = (): Worker => {
      const w = script(ECHO)();
      live++;
      peak = Math.max(peak, live);
      w.on("exit", () => live--);
      return w;
    };
    // The follow-up job gets a realistic budget: its timeout covers starting a real worker thread
    // and one round trip, which takes longer than 30 ms on a loaded or Windows runner. Only the
    // hanging runner needs the short timeout that terminates it.
    const rw = new RunnerWorker(mk, 10_000);
    const hang = new RunnerWorker(() => {
      const w = script("setInterval(() => {}, 1000)")();
      live++;
      peak = Math.max(peak, live);
      w.on("exit", () => live--);
      return w;
    }, 30);
    await expect(hang.runJob("/p", job)).rejects.toThrow("timed out");
    // Report the rejection reason instead of a bare "rejected", so a failure here says why.
    const followUp = await rw.runJob("/p", job).then(
      () => "resolved",
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    );
    expect(followUp).toBe("resolved");
    await Promise.all([rw.stop(), hang.stop()]);
    expect(peak).toBeLessThanOrEqual(2);
    // After a timeout the same host starts its next worker only once the old thread is gone.
    live = 0;
    peak = 0;
    const both = new RunnerWorker(() => {
      const w = script("setInterval(() => {}, 1000)")();
      live++;
      peak = Math.max(peak, live);
      w.on("exit", () => live--);
      return w;
    }, 30);
    await expect(both.runJob("/p", job)).rejects.toThrow("timed out");
    const second = both.runJob("/p", job).catch(() => undefined);
    await sleep(100);
    expect(peak).toBe(1);
    await both.stop();
    await second;
  });
});
