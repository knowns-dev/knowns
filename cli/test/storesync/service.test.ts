// The store sync service against real git repositories: a bare remote and two machines (HOME,
// registry, clone) driven tick by tick. Covers commit, push, fast-forward, arrivals and the
// onSynced hook, the rebase conflict pause, resolve, push contention and unreachable remotes.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  classifyFailure,
  loadState,
  Service,
} from "../../src/domain/storesync/index.ts";
import { git, makeRemote, makeSide, runTsSide, type Side, tempRoot } from "./helpers.ts";

interface Machine {
  side: Side;
  svc: Service;
  stateDir: string;
  clone: string;
  synced: { root: string; paths: string[] }[];
}

/** Run fn with process.env pointing at the machine (git and the registry read it). */
async function on<T>(m: Machine, fn: () => Promise<T> | T): Promise<T> {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  process.env.GIT_CONFIG_NOSYSTEM = "1"; // no system autocrlf: the sync must see byte-exact files
  process.env.HOME = m.side.home;
  process.env.USERPROFILE = m.side.home;
  try {
    return await fn();
  } finally {
    for (const k of ["HOME", "USERPROFILE"] as const) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (saved.GIT_CONFIG_NOSYSTEM === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = saved.GIT_CONFIG_NOSYSTEM;
  }
}

async function machine(
  root: string,
  name: string,
  remote: string,
  project: string,
): Promise<Machine> {
  const side = makeSide(root, name);
  const r = await runTsSide(side, ["store", "link", remote, "--as", project, "--store", "kb"]);
  expect(r.code, r.stderr).toBe(0);
  const synced: Machine["synced"] = [];
  const stateDir = join(side.home, ".knowns", "runtime", "stores"); // where the commands read it
  const cfg: Config = {
    registryPath: join(side.home, ".knowns", "registry.json"),
    stateDir,
    debounceMs: 1,
    fetchIntervalMs: 1,
    tickMs: 10,
    gitTimeoutMs: 30_000,
    now: () => new Date(),
    onSynced: (_s, root, paths) => {
      synced.push({ root, paths });
    },
  };
  return {
    side,
    svc: new Service(cfg),
    stateDir,
    clone: join(side.home, ".knowns", "stores", "kb"),
    synced,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ticks(m: Machine, n = 4): Promise<void> {
  for (let i = 0; i < n; i++) {
    await on(m, () => m.svc.tick(new AbortController().signal));
    await sleep(10);
  }
}

const state = (m: Machine) => loadState(m.stateDir, "kb");
const remoteFile = (remote: string, home: string, path: string) =>
  git(remote, home, "show", `main:${path}`);

describe("store sync service", () => {
  test("commits a quiet change, pushes it, and the other machine fast-forwards it in", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = await machine(root, "a", remote, "shared");
    await ticks(a);
    const aState = state(a);
    expect(aState.queuedCommits).toBe(0);
    expect(aState.paused).toBe(false);
    expect(aState.projects).toEqual(["shared"]);
    expect(remoteFile(remote, a.side.home, "shared/config.json")).toContain('"name"');

    const b = await machine(root, "b", remote, "shared"); // adopts the folder A pushed
    mkdirSync(join(a.clone, "shared", "docs"), { recursive: true });
    writeFileSync(join(a.clone, "shared", "docs", "note.md"), "---\ntitle: Note\n---\nhello\n");
    await ticks(a);
    expect(git(remote, a.side.home, "log", "-1", "--format=%s", "main").trim()).toBe(
      "knowns: sync shared",
    );

    await ticks(b);
    expect(readFileSync(join(b.clone, "shared", "docs", "note.md"), "utf8")).toContain("hello");
    expect(b.synced.flatMap((s) => s.paths)).toContain("docs/note.md");
    const arrivals = JSON.parse(
      readFileSync(join(b.clone, "shared", "history", "state", "sync-arrivals.json"), "utf8"),
    );
    expect(arrivals["docs/note.md"].author).toContain("author@example.test");
    expect(state(b).lastFetch).not.toBe("0001-01-01T00:00:00Z");
  }, 60_000);

  test("a rebase conflict pauses only that project, keeps local content, and resolve --keep local resumes", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = await machine(root, "a", remote, "shared");
    await ticks(a);
    const b = await machine(root, "b", remote, "shared");
    writeFileSync(join(a.clone, "shared", "docs-t.md"), "base\n");
    await ticks(a);
    await ticks(b);

    // Both edit the same file; A pushes first, B has a local commit and diverges.
    writeFileSync(join(a.clone, "shared", "docs-t.md"), "from a\n");
    await ticks(a);
    writeFileSync(join(b.clone, "shared", "docs-t.md"), "from b\n");
    // B commits locally without fetching: stop the fetch by pointing the tick at a fresh service.
    await ticks(b);

    const s = state(b);
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0]?.project).toBe("shared");
    expect(s.conflicts[0]?.paths).toEqual(["shared/docs-t.md"]);
    expect(readFileSync(join(b.clone, "shared", "docs-t.md"), "utf8")).toBe("from b\n");
    expect(remoteFile(remote, b.side.home, "shared/docs-t.md")).toBe("from a\n");
    const copies = git(b.clone, b.side.home, "status", "--porcelain");
    expect(copies).toContain("docs-t.md");
    expect(existsSync(join(b.stateDir, "kb-conflicts"))).toBe(true);

    const status = await runTsSide(b.side, ["store", "status"]);
    expect(status.stdout).toContain("paused: conflict");
    const list = await runTsSide(b.side, ["store", "resolve"]);
    expect(list.stdout).toContain("kb/shared paused");
    const shown = await runTsSide(b.side, ["store", "resolve", "shared"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("== shared/docs-t.md");
    const kept = await runTsSide(b.side, ["store", "resolve", "shared", "--keep", "local"]);
    expect(kept.code, kept.stderr).toBe(0);
    expect(kept.stdout).toContain("Kept the local version of 1 entity in kb/shared.");
    await ticks(b, 6);
    expect(state(b).conflicts).toHaveLength(0);
    expect(remoteFile(remote, b.side.home, "shared/docs-t.md")).toBe("from b\n");
  }, 90_000);

  test("three rejected pushes pause the store for push contention without forcing", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = await machine(root, "a", remote, "shared");
    await ticks(a);
    const rival = join(root, "rival");
    git(root, a.side.home, "clone", remote, rival);
    let n = 0;
    a.svc.beforePush = () => {
      n++;
      writeFileSync(join(rival, `rival-${n}.txt`), "x");
      git(rival, a.side.home, "add", "-A");
      git(rival, a.side.home, "commit", "-m", `rival ${n}`);
      git(rival, a.side.home, "push", "origin", "main");
    };
    writeFileSync(join(a.clone, "shared", "mine.txt"), "mine");
    await ticks(a, 3);
    const s = state(a);
    expect(s.paused).toBe(true);
    expect(s.pauseCause).toBe("push-contention");
    expect(s.pauseMessage).toContain("rejected 3 times in a row");
  }, 90_000);

  test("an unreachable remote keeps commits queued and does not pause", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = await machine(root, "a", remote, "shared");
    await ticks(a);
    git(a.clone, a.side.home, "remote", "set-url", "origin", join(root, "gone.git"));
    writeFileSync(join(a.clone, "shared", "q.txt"), "q");
    await ticks(a, 3);
    const s = state(a);
    expect(s.paused).toBe(false);
    expect(s.queuedCommits).toBeGreaterThan(0);
    expect(s.lastError).toContain("failed, will retry");
  }, 60_000);

  // Not in Go (a panic there kills the runtime loudly): the TS daemon stays up while stores are
  // linked, so an unexpected throw must be recorded and the next pass must sync again.
  test("an unexpected throw is recorded and the next pass syncs again", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = await machine(root, "a", remote, "shared");
    await ticks(a);
    writeFileSync(join(a.clone, "shared", "later.md"), "later\n");
    a.svc.beforePush = () => {
      throw new Error("boom before push");
    };
    await ticks(a); // must not reject
    expect(state(a).lastError).toContain("boom before push");
    a.svc.beforePush = undefined;
    await ticks(a);
    expect(remoteFile(remote, a.side.home, "shared/later.md")).toBe("later\n");
    expect(state(a).lastError).toBe("");
  }, 60_000);

  // Approved divergence (D12, TSR-YZY173): in 0.34.1 one store's failure ended the pass, so the
  // stores after it never synced.
  test("a store that keeps failing does not stop the other stores", async () => {
    const root = tempRoot();
    const remoteA = makeRemote(root, "remote-a");
    const remoteB = makeRemote(root, "remote-b");
    const a = await machine(root, "a", remoteA, "first");
    // A second code repository on the same machine, linked to a second store.
    const code2 = join(a.side.root, "proj2");
    mkdirSync(code2, { recursive: true });
    const second = await runTsSide(
      a.side,
      ["store", "link", remoteB, "--as", "second", "--store", "kb2"],
      {},
      code2,
    );
    expect(second.code, second.stderr).toBe(0);
    await ticks(a);
    writeFileSync(join(a.clone, "first", "a.md"), "a\n");
    writeFileSync(join(a.side.home, ".knowns", "stores", "kb2", "second", "b.md"), "b\n");
    // Whichever store the pass reaches first, "kb" always throws before its push.
    a.svc.beforePush = (store) => {
      if (store === "kb") throw new Error("boom in kb");
    };
    await ticks(a, 6);
    expect(state(a).lastError).toContain("boom in kb");
    expect(remoteFile(remoteB, a.side.home, "second/b.md")).toBe("b\n");
    expect(loadState(a.stateDir, "kb2").lastError).toBe("");
  }, 60_000);

  // Approved divergence (D12, TSR-YZY173): a throw that escapes a whole pass is logged and the
  // loop goes on. The runtime stays up while stores are linked, so without this sync would stop
  // for good while the daemon looks healthy.
  test("the service keeps running after a pass throws", async () => {
    const root = tempRoot();
    const a = await machine(root, "a", makeRemote(root, "remote"), "shared");
    let calls = 0;
    const realTick = a.svc.tick.bind(a.svc);
    a.svc.tick = async (signal: AbortSignal) => {
      calls++;
      if (calls === 1) throw new Error("registry unreadable");
      return realTick(signal);
    };
    const ac = new AbortController();
    const running = on(a, () => a.svc.run(ac.signal));
    await sleep(200);
    ac.abort();
    await running;
    expect(calls).toBeGreaterThan(1);
  }, 60_000);

  test("failure classification matches Go", () => {
    expect(classifyFailure("! [rejected] main -> main (fetch first)")).toBe("rejected");
    expect(classifyFailure("fatal: Authentication failed for 'https://x'")).toBe("credential");
    expect(classifyFailure("Permission denied (publickey).")).toBe("credential");
    expect(classifyFailure("Could not resolve host")).toBe("unreachable");
  });
});
