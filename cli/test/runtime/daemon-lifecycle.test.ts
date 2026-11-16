// Version-scoped runtime daemons (KN-9FGFP0, spec D3): two versions coexist, exactly one runs
// jobs and watchers (the runner: the newest alive), and each daemon exits after its own last
// session. The unit tests move the runtime root with process.env; the two-daemon tests run real
// `__runtime run` processes under different versions (`bun --define KNOWNS_VERSION`).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRunner,
  claimRunner,
  compareVersions,
  currentRunner,
  findDaemon,
  partitionLeases,
  registerDaemon,
  releaseRunner,
  unregisterDaemon,
} from "../../src/runtime/daemon-registry.ts";
import { readDescriptor } from "../../src/runtime/mcp-endpoint.ts";
import { type Lease, queuePath, scanQueues } from "../../src/runtime/queue.ts";
import { makeSandbox } from "../mcp/harness.ts";

const CLI_ROOT = join(import.meta.dir, "..", "..");

describe("compareVersions", () => {
  test("orders numeric parts, then pre-releases", () => {
    expect(compareVersions("0.35.1", "0.35.0")).toBe(1);
    expect(compareVersions("0.35.0", "0.35.0")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v2.0.0", "1.9.9")).toBe(1);
  });
});

describe("registry and runner election", () => {
  let root: string;
  let savedRoot: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "kn-reg-")));
    savedRoot = process.env.KNOWNS_RUNTIME_ROOT;
    process.env.KNOWNS_RUNTIME_ROOT = root;
  });
  afterEach(() => {
    if (savedRoot === undefined) delete process.env.KNOWNS_RUNTIME_ROOT;
    else process.env.KNOWNS_RUNTIME_ROOT = savedRoot;
  });
  // Two live pids that are not this test's job to kill: this process and its parent.
  const ME = process.pid;
  const OTHER = process.ppid;

  test("a daemon is found by version while its process lives, and unregistered cleanly", () => {
    registerDaemon("1.0.0");
    expect(findDaemon("1.0.0")?.pid).toBe(ME);
    expect(findDaemon("1.0.1")).toBeUndefined();
    registerDaemon("0.9.0", 2 ** 22 + 77); // a dead pid
    expect(findDaemon("0.9.0")).toBeUndefined();
    unregisterDaemon("1.0.0");
    expect(findDaemon("1.0.0")).toBeUndefined();
  });

  test("the first daemon becomes the runner; an older one does not displace a newer", () => {
    expect(claimRunner("1.0.0", ME)).toBe(true);
    expect(currentRunner()?.version).toBe("1.0.0");
    // A newer version alive (OTHER) takes over from the older runner.
    expect(claimRunner("1.1.0", OTHER)).toBe(true);
    expect(currentRunner()?.pid).toBe(OTHER);
    // The older one stands by and cannot take it back while the newer lives.
    expect(claimRunner("1.0.0", ME)).toBe(false);
    expect(checkRunner("1.0.0", ME)).toBe(false);
    expect(checkRunner("1.1.0", OTHER)).toBe(true);
  });

  test("an older daemon takes the role back when the newer runner is gone", () => {
    claimRunner("1.1.0", OTHER);
    releaseRunner(OTHER);
    expect(currentRunner()).toBeUndefined();
    expect(checkRunner("1.0.0", ME)).toBe(true);
    expect(currentRunner()?.pid).toBe(ME);
  });

  test("a crashed runner (dead pid in runner.json) is replaced by any version", () => {
    writeFileSync(
      join(root, "runner.json"),
      JSON.stringify({ pid: 2 ** 22 + 99, version: "9.9.9", claimedAt: "x" }),
    );
    expect(checkRunner("1.0.0", ME)).toBe(true);
    expect(currentRunner()?.version).toBe("1.0.0");
  });

  test("a lock left by a crashed holder never blocks the election", () => {
    // Dead pid.
    writeFileSync(join(root, "runner.lock"), JSON.stringify({ pid: 2 ** 22 + 5, at: Date.now() }));
    expect(claimRunner("1.0.0", ME)).toBe(true);
    releaseRunner(ME);
    // A live pid that is not a registered daemon (pid reuse, or a non-daemon): stale too.
    writeFileSync(join(root, "runner.lock"), JSON.stringify({ pid: OTHER, at: Date.now() }));
    expect(claimRunner("1.0.0", ME)).toBe(true);
    releaseRunner(ME);
    // Half-written, unreadable lock content.
    writeFileSync(join(root, "runner.lock"), "{");
    const t = Date.now();
    expect(claimRunner("1.0.0", ME)).toBe(true);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  test("a live registered holder is respected until it releases", async () => {
    registerDaemon("1.0.0", OTHER);
    writeFileSync(join(root, "runner.lock"), JSON.stringify({ pid: OTHER, at: Date.now() }));
    const t = Date.now();
    // Not stale: the claim waits for its 2 s budget, then gives up without taking the role.
    expect(claimRunner("1.0.0", ME)).toBe(false);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1800);
    unregisterDaemon("1.0.0", OTHER);
  }, 15_000);

  test("leases: a daemon owns its version, the runner also owns unversioned ones and watches all", () => {
    const lease = (id: string, version?: string): Lease => ({
      id,
      clientKind: "mcp",
      projectRoot: "/p",
      watch: true,
      ...(version ? { version } : {}),
      createdAt: "",
      updatedAt: "",
      expiresAt: "",
    });
    const all = [lease("a", "1.0.0"), lease("b", "1.1.0"), lease("c")];
    const old = partitionLeases(all, "1.0.0", false);
    expect(old.own.map((l) => l.id)).toEqual(["a"]);
    expect(old.watchFor).toEqual([]);
    const run = partitionLeases(all, "1.1.0", true);
    expect(run.own.map((l) => l.id)).toEqual(["b", "c"]);
    expect(run.watchFor.length).toBe(3);
  });

  test("a job of a kind this version does not know stays queued and is never picked", () => {
    const store = join(root, "proj", ".knowns");
    const path = queuePath(store);
    mkdirSync(join(root, "queues"), { recursive: true });
    const future = {
      id: "j1",
      key: "future-kind::x",
      kind: "future-kind",
      requestedAt: "2026-01-01T00:00:00Z",
      runAfter: "2026-01-01T00:00:00Z",
    };
    const known = { ...future, id: "j2", key: "index-task::t", kind: "index-task", target: "t" };
    writeFileSync(path, JSON.stringify({ jobs: [future] }));
    const before = readFileSync(path, "utf8");
    const only = scanQueues([store]);
    expect(only.next).toBeUndefined();
    expect(only.pending).toBe(0);
    writeFileSync(path, JSON.stringify({ jobs: [future, known] }));
    const both = scanQueues([store]);
    expect(both.next?.job.kind).toBe("index-task");
    expect(both.pending).toBe(1);
    writeFileSync(path, before);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

// --- two real daemons ----------------------------------------------------------------------------

const procs: Array<ReturnType<typeof Bun.spawn>> = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

async function until<T>(
  f: () => T | undefined | false,
  ms = 25_000,
  what = "condition",
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`${what} not met in time`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

class Env {
  readonly base = realpathSync(mkdtempSync(join(tmpdir(), "kn-lc-")));
  readonly home = join(this.base, "home");
  readonly runtime = join(this.base, "runtime");
  constructor() {
    mkdirSync(this.home);
    mkdirSync(this.runtime);
  }

  daemon(version: string, extra: Record<string, string> = {}) {
    const p = Bun.spawn(
      [
        process.execPath,
        "--define",
        `KNOWNS_VERSION="${version}"`,
        join(CLI_ROOT, "src", "main.ts"),
        "__runtime",
        "run",
      ],
      {
        cwd: this.base,
        env: {
          PATH: process.env.PATH ?? "",
          // Windows needs its system variables for sockets and temp files; user dirs stay sandboxed.
          ...(process.platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot ?? "",
                windir: process.env.windir ?? "",
                TEMP: this.home,
                TMP: this.home,
                APPDATA: this.home,
                LOCALAPPDATA: this.home,
              }
            : {}),
          HOME: this.home,
          USERPROFILE: this.home,
          KNOWNS_RUNTIME_ROOT: this.runtime,
          KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
          KNOWNS_LSP_DAEMON: "0",
          KNOWN_LSP_AUTO_INSTALL: "0",
          NO_UPDATE_CHECK: "1",
          CI: "1",
          ...extra,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    procs.push(p);
    return p;
  }

  descriptor(version: string) {
    return readDescriptor(version, this.runtime);
  }

  json<T>(name: string): T | undefined {
    try {
      return JSON.parse(readFileSync(join(this.runtime, name), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  pidFile(): number | undefined {
    try {
      return Number(readFileSync(join(this.runtime, "knowns-runtime.pid"), "utf8").trim());
    } catch {
      return undefined;
    }
  }
}

/** A bare proxy: hello, then JSON-RPC lines. */
async function session(env: Env, version: string, cwd: string) {
  const d = await until(() => env.descriptor(version), 25_000, `descriptor ${version}`);
  const sock = net.connect({ path: d.address });
  sock.on("error", () => undefined);
  const lines: string[] = [];
  let buf = "";
  sock.on("data", (c) => {
    buf += c.toString("utf8");
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const take = (match: (j: Record<string, unknown>) => boolean) =>
    until(() => {
      for (let i = 0; i < lines.length; i++) {
        const j = JSON.parse(lines[i] as string) as Record<string, unknown>;
        if (match(j)) {
          lines.splice(i, 1);
          return j;
        }
      }
      return undefined;
    });
  sock.write(
    `${JSON.stringify({ knowns_mcp: 1, type: "hello", version, token: d.token, cwd, pid: process.pid, client: { name: "t" } })}\n`,
  );
  await take((j) => j.type === "welcome");
  return {
    ping: async (id: number) => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "ping" })}\n`);
      return take((j) => j.id === id);
    },
    close: () => sock.end(),
  };
}

const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("two daemons of different versions", () => {
  test("old keeps serving, the newest runs jobs, the old one exits after its last session", async () => {
    const env = new Env();
    const noProject = env.base; // a session with no project holds no lease
    const a = env.daemon("1.0.0");
    const onA = await session(env, "1.0.0", noProject);
    expect(env.json<{ pid: number; version: string }>("runner.json")?.version).toBe("1.0.0");

    const b = env.daemon("1.1.0");
    await until(() => env.descriptor("1.1.0"), 25_000, "B endpoint");
    // The newest version is the runner and owns the pid and status files 0.34.x reads.
    await until(
      () => env.json<{ version: string }>("runner.json")?.version === "1.1.0",
      15_000,
      "B runner",
    );
    expect(env.pidFile()).toBe(b.pid);
    await until(
      () => env.json<{ version: string }>("status.json")?.version === "1.1.0",
      15_000,
      "status",
    );
    expect(env.json<{ pid: number }>("status.json")?.pid).toBe(b.pid);

    // AC1: A is untouched and still serves its session; B serves new ones.
    expect(dead(a.pid)).toBe(false);
    expect(await onA.ping(1)).toMatchObject({ id: 1, result: {} });
    const onB = await session(env, "1.1.0", noProject);
    expect(await onB.ping(2)).toMatchObject({ id: 2, result: {} });

    // A has a session without a project: it must outlive the 1.5 s idle timeout (keepAlive).
    await new Promise((r) => setTimeout(r, 4000));
    expect(dead(a.pid)).toBe(false);

    // AC3: after A's last session it exits and leaves no pid, socket, pipe or registry entry.
    const aSocket = env.descriptor("1.0.0")?.address as string;
    onA.close();
    await a.exited;
    expect(dead(a.pid)).toBe(true);
    expect(env.descriptor("1.0.0")).toBeUndefined();
    expect(findDaemonIn(env, "1.0.0")).toBe(false);
    if (process.platform !== "win32") expect(existsSync(aSocket)).toBe(false);
    // B is unaffected and still the runner.
    expect(dead(b.pid)).toBe(false);
    expect(env.json<{ pid: number }>("runner.json")?.pid).toBe(b.pid);
    expect(env.pidFile()).toBe(b.pid);
    expect(await onB.ping(3)).toMatchObject({ id: 3 });
    onB.close();
    await b.exited;
  }, 90_000);

  test("the older daemon takes the runner role back when the newer exits first", async () => {
    const env = new Env();
    const a = env.daemon("1.0.0");
    const onA = await session(env, "1.0.0", env.base);
    const b = env.daemon("1.1.0");
    await until(
      () => env.json<{ version: string }>("runner.json")?.version === "1.1.0",
      25_000,
      "B runner",
    );
    expect(env.pidFile()).toBe(b.pid);

    b.kill("SIGTERM");
    await b.exited;
    // B cleaned up after itself; A claims the role within a couple of seconds.
    await until(
      () => env.json<{ pid: number }>("runner.json")?.pid === a.pid,
      15_000,
      "A takes over",
    );
    await until(() => env.pidFile() === a.pid, 15_000, "pid file");
    await until(() => env.json<{ pid: number }>("status.json")?.pid === a.pid, 15_000, "A status");
    // Windows ends a killed process without running its cleanup, so its descriptor stays; readers
    // tell by the dead pid.
    if (process.platform !== "win32") expect(env.descriptor("1.1.0")).toBeUndefined();
    expect(await onA.ping(1)).toMatchObject({ id: 1 });
    onA.close();
    await a.exited;
    expect(env.json("runner.json")).toBeUndefined();
  }, 90_000);

  test("a session with a project keeps its own daemon alive through a lease", async () => {
    const env = new Env();
    const sb = makeSandbox("full");
    const a = env.daemon("1.0.0");
    const onA = await session(env, "1.0.0", sb.dir);
    await onA.ping(1);
    await new Promise((r) => setTimeout(r, 3000));
    expect(dead(a.pid)).toBe(false);
    onA.close();
    await a.exited;
  }, 60_000);
});

function findDaemonIn(env: Env, version: string): boolean {
  return existsSync(join(env.runtime, "daemons", `${version}.json`));
}
