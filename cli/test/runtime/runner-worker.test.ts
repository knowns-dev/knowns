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
    const w = new RunnerWorker(() => (n++ === 0 ? spin() : echo()), 150);
    let ticks = 0;
    const t = setInterval(() => ticks++, 5);
    await expect(w.runJob("/s", job)).rejects.toThrow(/timed out/);
    clearInterval(t);
    expect(ticks).toBeGreaterThan(5);
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

/** path:size, so an appended history file counts as a change, not only a new file. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${relative(root, p).replaceAll("\\", "/")}:${statSync(p).size}`);
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
    await sleep(3000);
    const store = join(sb.dir, ".knowns");
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
    expect(on).toEqual(off);
  }, 120_000);
});
