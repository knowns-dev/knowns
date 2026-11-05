// Go differential tests for `knowns store link|unlink|status|resolve`: the same arguments run with
// the Go 0.34.1 binary and the TypeScript CLI, each on its own machine (HOME, code repo and bare
// remote), and stdout, stderr, exit code and file trees must match. Paths, ISO clocks and the
// generated registry id differ between two machines by construction and are masked in maskFor.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hasGoBin,
  makeRemote,
  makeSide,
  maskFor,
  maskTree,
  runGoSide,
  runTsSide,
  type Side,
  tempRoot,
  tree,
} from "./helpers.ts";

const suite = hasGoBin ? describe : describe.skip;

interface Pair {
  go: Side;
  ts: Side;
  remote: { go: string; ts: string };
}

function makePair(): Pair {
  const root = tempRoot();
  const go = makeSide(root, "go");
  const ts = makeSide(root, "ts");
  return {
    go,
    ts,
    remote: { go: makeRemote(go.root, "remote"), ts: makeRemote(ts.root, "remote") },
  };
}

/** Runs the same command on both sides; `{remote}` in an argument is each side's own bare remote. */
async function both(pair: Pair, args: string[], extra: Record<string, string> = {}) {
  const fill = (side: "go" | "ts") => args.map((a) => a.replaceAll("{remote}", pair.remote[side]));
  const go = runGoSide(pair.go, fill("go"), extra);
  const ts = await runTsSide(pair.ts, fill("ts"), extra);
  return { go, ts };
}

function same(pair: Pair, r: Awaited<ReturnType<typeof both>>, label: string) {
  const n = (side: "go" | "ts") => ({
    code: r[side].code,
    stdout: maskFor(pair[side], r[side].stdout),
    stderr: maskFor(pair[side], r[side].stderr),
  });
  expect(n("ts"), label).toEqual(n("go"));
}

const homeTree = (s: Side) => maskTree(s, tree(join(s.home, ".knowns")));

function expectSameHome(pair: Pair, label: string) {
  expect(homeTree(pair.ts), label).toEqual(homeTree(pair.go));
}

suite("knowns store link/unlink/status/resolve equal Go", () => {
  test("link clones the store, creates the project folder and registers the link", async () => {
    const pair = makePair();
    const r = await both(pair, ["store", "link", "{remote}"]);
    expect(r.go.code, r.go.stderr).toBe(0);
    same(pair, r, "link");
    expectSameHome(pair, "home tree");
    for (const side of ["go", "ts"] as const) {
      expect(
        existsSync(join(pair[side].home, ".knowns", "stores", "remote", "proj", "config.json")),
      ).toBe(true);
    }
  });

  test("link --as/--store and a second link adopt the existing folder", async () => {
    const pair = makePair();
    const first = await both(pair, ["store", "link", "{remote}", "--as", "web", "--store", "kb"]);
    same(pair, first, "first link");
    const again = await both(pair, ["store", "link", "{remote}", "--as", "web", "--store", "kb"]);
    same(pair, again, "second link");
    expect(again.go.stdout).toContain("Adopted project folder");
    expectSameHome(pair, "home tree");
  });

  test("link warns when the repository still has a .knowns", async () => {
    const pair = makePair();
    for (const s of [pair.go, pair.ts]) mkdirSync(join(s.code, ".knowns"));
    const r = await both(pair, ["store", "link", "{remote}"]);
    same(pair, r, "link with in-repo .knowns");
    expect(r.go.stderr).toContain("is ignored from now on");
  });

  test("link errors: bad segment, bad remote, remote mismatch, migrate without .knowns, arg count", async () => {
    const pair = makePair();
    same(pair, await both(pair, ["store", "link", "{remote}", "--as", "a/b"]), "bad segment");
    same(
      pair,
      await both(pair, ["store", "link", "{remote}", "--migrate"]),
      "migrate without .knowns",
    );
    same(pair, await both(pair, ["store", "link"]), "no remote");
    same(pair, await both(pair, ["store", "link", "a", "b"]), "two remotes");
    const bad = await both(pair, [
      "store",
      "link",
      join(pair.go.root, "nope.git").replaceAll("\\", "/"),
    ]);
    expect(bad.go.code).toBe(1);
    expect(bad.ts.code).toBe(1);
    // Same store name, different remote.
    await both(pair, ["store", "link", "{remote}"]);
    for (const s of [pair.go, pair.ts]) makeRemote(s.root, "other");
    const otherArgs = (s: Side) => [
      "store",
      "link",
      join(s.root, "other.git"),
      "--store",
      "remote",
    ];
    const go = runGoSide(pair.go, otherArgs(pair.go));
    const ts = await runTsSide(pair.ts, otherArgs(pair.ts));
    same(pair, { go, ts }, "remote mismatch");
    expect(go.stderr).toContain("is already a clone of");
  });

  test("link --migrate copies the in-repo knowledge with its IDs and local-only paths", async () => {
    const pair = makePair();
    for (const s of [pair.go, pair.ts]) {
      const k = join(s.code, ".knowns");
      mkdirSync(join(k, "tasks"), { recursive: true });
      mkdirSync(join(k, "docs"), { recursive: true });
      mkdirSync(join(k, "history"), { recursive: true });
      writeFileSync(
        join(k, "config.json"),
        JSON.stringify({ name: "proj", id: "proj", settings: {} }, null, 2),
      );
      writeFileSync(
        join(k, "tasks", "task-abc - First.md"),
        "---\nid: abc\ntitle: First\n---\nbody\n",
      );
      writeFileSync(join(k, "docs", "readme.md"), "# readme\n");
      writeFileSync(join(k, "history", "x.json"), "{}");
      writeFileSync(join(k, "time.json"), "{}");
    }
    const r = await both(pair, ["store", "link", "{remote}", "--migrate"]);
    expect(r.go.code, r.go.stderr).toBe(0);
    same(pair, r, "migrate");
    expectSameHome(pair, "home tree");
    // Migrating again into a folder that now has content fails the same way.
    same(pair, await both(pair, ["store", "link", "{remote}", "--migrate"]), "migrate twice");
  });

  test("status: no links, not synced yet, --json", async () => {
    const pair = makePair();
    same(pair, await both(pair, ["store", "status"]), "status empty");
    same(pair, await both(pair, ["store", "status", "--json"]), "status empty json");
    await both(pair, ["store", "link", "{remote}"]);
    const r = await both(pair, ["store", "status"]);
    same(pair, r, "status linked");
    expect(r.go.stdout).toContain("not synced yet");
    same(pair, await both(pair, ["store", "status", "--json"]), "status linked json");
    same(pair, await both(pair, ["store", "status", "extra"]), "status extra arg");
  });

  test("unlink removes the registry link and leaves the clone", async () => {
    const pair = makePair();
    same(pair, await both(pair, ["store", "unlink"]), "unlink unlinked");
    await both(pair, ["store", "link", "{remote}"]);
    const r = await both(pair, ["store", "unlink"]);
    same(pair, r, "unlink");
    expect(r.go.code).toBe(0);
    expectSameHome(pair, "home tree");
    same(pair, await both(pair, ["store", "status"]), "status after unlink");
  });

  test("resolve: nothing paused, unknown project, bad --keep", async () => {
    const pair = makePair();
    await both(pair, ["store", "link", "{remote}"]);
    same(pair, await both(pair, ["store", "resolve"]), "resolve none");
    same(pair, await both(pair, ["store", "resolve", "proj"]), "resolve not paused");
    same(pair, await both(pair, ["store", "resolve", "proj", "--keep", "x"]), "resolve bad keep");
  });

  test("store --help and subcommand help match", async () => {
    const pair = makePair();
    for (const args of [
      ["store", "--help"],
      ["store", "link", "--help"],
      ["store", "unlink", "--help"],
      ["store", "status", "--help"],
      ["store", "resolve", "--help"],
      ["store"],
    ]) {
      same(pair, await both(pair, args), args.join(" "));
    }
  });
});
