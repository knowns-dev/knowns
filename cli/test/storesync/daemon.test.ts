// The real TypeScript runtime daemon keeps a linked store in sync in the background, and Go and
// TypeScript can alternate on the same linked store (AC2, AC3). Each daemon is a real child process
// started by the test; only PIDs the test started are killed.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Daemon,
  git,
  hasGoBin,
  makeRemote,
  makeSide,
  runGoSide,
  runTsSide,
  type Side,
  spawnDaemon,
  tempRoot,
  waitFor,
} from "./helpers.ts";

const KNOBS = {
  KNOWNS_STORE_DEBOUNCE_MS: "200",
  KNOWNS_STORE_FETCH_INTERVAL_MS: "300",
  KNOWNS_RUNTIME_IDLE_TIMEOUT_MS: "1500",
};

const started: Daemon[] = [];
afterAll(() => {
  for (const d of started) d.kill();
});

function daemon(s: Side, which: "go" | "ts"): Daemon {
  const d = spawnDaemon(s, which, KNOBS);
  started.push(d);
  return d;
}

const clone = (s: Side) => join(s.home, ".knowns", "stores", "kb");
const statePath = (s: Side) => join(s.home, ".knowns", "runtime", "stores", "kb.json");
const readState = (s: Side) => JSON.parse(readFileSync(statePath(s), "utf8"));
const remoteHas = (remote: string, s: Side, path: string, text: string) => {
  try {
    return git(remote, s.home, "show", `main:${path}`).includes(text);
  } catch {
    return false;
  }
};

async function link(s: Side, which: "go" | "ts", remote: string, project: string) {
  const args = ["store", "link", remote, "--as", project, "--store", "kb"];
  const r = which === "go" ? runGoSide(s, args) : await runTsSide(s, args);
  expect(r.code, r.stderr).toBe(0);
}

function write(s: Side, rel: string, text: string) {
  const p = join(clone(s), "shared", ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

/** Both clones are clean and at the same commit. */
const synced = (a: Side, b: Side) => {
  const head = (s: Side) => git(clone(s), s.home, "rev-parse", "HEAD").trim();
  const clean = (s: Side) => git(clone(s), s.home, "status", "--porcelain").trim() === "";
  return clean(a) && clean(b) && head(a) === head(b);
};

describe("TypeScript runtime daemon store sync", () => {
  test("the daemon commits, pushes and stays alive while a store is linked", async () => {
    const root = tempRoot();
    const remote = makeRemote(root, "remote");
    const a = makeSide(root, "a");
    await link(a, "ts", remote, "shared");
    const d = daemon(a, "ts");
    write(a, "docs/one.md", "---\ntitle: One\n---\nfirst\n");
    expect(await waitFor(() => remoteHas(remote, a, "shared/docs/one.md", "first"), 30_000)).toBe(
      true,
    );
    expect(
      await waitFor(
        () => existsSync(statePath(a)) && readState(a).lastPush !== "0001-01-01T00:00:00Z",
        15_000,
      ),
    ).toBe(true);
    const st = readState(a);
    expect(st.store).toBe("kb");
    expect(st.paused).toBe(false);
    expect(st.lastPush).not.toBe("0001-01-01T00:00:00Z");
    // Past the 1.5s idle timeout with no client: keepAlive holds it up because a store is linked.
    await new Promise((r) => setTimeout(r, 4000));
    expect(() => process.kill(d.pid, 0)).not.toThrow();
    d.kill();
    await d.exited;
  }, 90_000);

  const goSuite = hasGoBin ? describe : describe.skip;
  goSuite("alternating with Go", () => {
    test("a TS daemon and a Go daemon on two machines converge on edits in both directions", async () => {
      const root = tempRoot();
      const remote = makeRemote(root, "remote");
      const a = makeSide(root, "a");
      const b = makeSide(root, "b");
      await link(a, "ts", remote, "shared");
      const da = daemon(a, "ts");
      write(a, "docs/from-ts.md", "ts one\n");
      expect(
        await waitFor(() => remoteHas(remote, a, "shared/docs/from-ts.md", "ts one"), 30_000),
      ).toBe(true);
      await link(b, "go", remote, "shared"); // adopts the folder TS pushed
      const db = daemon(b, "go");
      expect(
        await waitFor(() => existsSync(join(clone(b), "shared", "docs", "from-ts.md")), 30_000),
      ).toBe(true);
      for (let i = 1; i <= 3; i++) {
        write(b, `docs/from-go-${i}.md`, `go ${i}\n`);
        expect(
          await waitFor(
            () => existsSync(join(clone(a), "shared", "docs", `from-go-${i}.md`)),
            30_000,
          ),
        ).toBe(true);
        write(a, `docs/from-ts-${i}.md`, `ts ${i}\n`);
        expect(
          await waitFor(
            () => existsSync(join(clone(b), "shared", "docs", `from-ts-${i}.md`)),
            30_000,
          ),
        ).toBe(true);
      }
      expect(await waitFor(() => synced(a, b), 30_000)).toBe(true);
      da.kill();
      db.kill();
      await Promise.all([da.exited, db.exited]);
      // The shared history is intact.
      git(root, a.home, "-C", remote, "fsck", "--strict");
      expect(readState(a).paused).toBe(false);
      expect(readState(b).paused).toBe(false);
    }, 180_000);

    test("daemons of either language hand one machine over, conflicts included", async () => {
      const root = tempRoot();
      const remote = makeRemote(root, "remote");
      const a = makeSide(root, "a");
      const b = makeSide(root, "b");
      await link(a, "ts", remote, "shared");
      write(a, "docs/c.md", "base\n");
      let da = daemon(a, "ts");
      expect(await waitFor(() => remoteHas(remote, a, "shared/docs/c.md", "base"), 30_000)).toBe(
        true,
      );
      await link(b, "ts", remote, "shared");
      da.kill();
      await da.exited;

      // Go takes machine A over from the state TS left behind, and pushes a change.
      da = daemon(a, "go");
      write(a, "docs/c.md", "from a (go)\n");
      expect(
        await waitFor(() => remoteHas(remote, a, "shared/docs/c.md", "from a (go)"), 30_000),
      ).toBe(true);
      da.kill();
      await da.exited;

      // B edits the same file locally. Its TS daemon rebases, hits the conflict and pauses.
      write(b, "docs/c.md", "from b (local)\n");
      let db = daemon(b, "ts");
      expect(
        await waitFor(
          () => existsSync(statePath(b)) && readState(b).conflicts?.length === 1,
          30_000,
        ),
      ).toBe(true);
      db.kill();
      await db.exited;
      expect(readFileSync(join(clone(b), "shared", "docs", "c.md"), "utf8")).toBe(
        "from b (local)\n",
      );

      // Go takes B over: the conflict survives the hand-over and Go reports and resolves it.
      const status = runGoSide(b, ["store", "status"]);
      expect(status.stdout).toContain("paused: conflict");
      const tsStatus = await runTsSide(b, ["store", "status"]);
      expect(tsStatus.stdout).toBe(status.stdout);
      db = daemon(b, "go");
      await new Promise((r) => setTimeout(r, 2500));
      expect(readState(b).conflicts).toHaveLength(1);
      expect(remoteHas(remote, b, "shared/docs/c.md", "from a (go)")).toBe(true);
      const res = runGoSide(b, ["store", "resolve", "shared", "--keep", "local"]);
      expect(res.code, res.stderr).toBe(0);
      expect(
        await waitFor(() => remoteHas(remote, b, "shared/docs/c.md", "from b (local)"), 30_000),
      ).toBe(true);
      db.kill();
      await db.exited;
      expect(readState(b).conflicts ?? []).toHaveLength(0);
    }, 240_000);
  });
});
