// `reconcile restore`, the automatic reactivation of a briefly missing file, and Go/TS interop of
// tombstones and restores (decision a-briefly-missing-file-is-not-a-deletion).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FilesystemReconciler } from "../../src/domain/reconcile/reconciler.ts";
import {
  dispose,
  disposePair,
  hasGoBin,
  makePair,
  makeProject,
  type Pair,
  type Project,
  runBothCli,
  runGoIn,
  runTsIn,
  tree,
  treeDiff,
} from "./harness.ts";

const cases = hasGoBin ? describe : describe.skip;
const pairs: Pair[] = [];
const projects: Project[] = [];
afterEach(() => {
  for (const p of pairs.splice(0)) disposePair(p);
  for (const p of projects.splice(0)) dispose(p);
});

const ARCH = "architecture";

cases("reconcile restore parity with Go", () => {
  test("a doc deleted through the API is previewed and restored identically", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const del = await runBothCli(pair, ["doc", "delete", ARCH, "--force"]);
    expect(del.ts).toEqual(del.go);
    for (const args of [
      ["reconcile", "restore", "doc", ARCH],
      ["reconcile", "restore", "doc", ARCH, "--execute"],
      ["reconcile", "restore", "doc", ARCH],
      ["reconcile", "restore", "doc", ARCH, "--execute"],
    ]) {
      const r = await runBothCli(pair, args);
      expect(r.ts).toEqual(r.go);
    }
    expect(existsSync(join(pair.ts.dir, ".knowns/docs/architecture.md"))).toBe(true);
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("argument errors and unknown types match", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    for (const args of [
      ["reconcile", "restore"],
      ["reconcile", "restore", "memory", "x"],
      ["reconcile", "restore", "task", "NOPE-1"],
      ["reconcile", "restore", "doc", "missing/doc"],
      ["reconcile", "restore", "doc", ARCH],
      ["reconcile", "restore", "doc", ARCH, "--execute"],
      ["reconcile", "restore", "TASK", "FX-19XJKQ"],
    ]) {
      const r = await runBothCli(pair, args);
      expect({ args, ...r.ts }).toEqual({ args, ...r.go });
    }
  });

  test("a deleted task restores identically", async () => {
    const pair = makePair("full");
    pairs.push(pair);
    const del = await runBothCli(pair, ["task", "delete", "FX-19XJKQ", "--force"]);
    expect(del.ts.code).toBe(del.go.code);
    for (const args of [
      ["reconcile", "restore", "task", "FX-19XJKQ"],
      ["reconcile", "restore", "task", "FX-19XJKQ", "--execute"],
    ]) {
      const r = await runBothCli(pair, args);
      expect({ args, ...r.ts }).toEqual({ args, ...r.go });
    }
    expect(treeDiff(tree(pair.go), tree(pair.ts))).toEqual([]);
  });

  test("Go restores a doc that TS deleted, and TS restores one that Go deleted", async () => {
    const a = makeProject("full");
    const b = makeProject("full");
    projects.push(a, b);
    expect((await runTsIn(a, ["doc", "delete", ARCH, "--force"])).code).toBe(0);
    const goRestore = runGoIn(a, ["reconcile", "restore", "doc", ARCH, "--execute"]);
    expect(goRestore.stdout).toContain("restored type=doc");
    expect(runGoIn(a, ["doc", "edit", ARCH, "-c", "after go restore"]).code).toBe(0);

    expect(runGoIn(b, ["doc", "delete", ARCH, "--force"]).code).toBe(0);
    const tsRestore = await runTsIn(b, ["reconcile", "restore", "doc", ARCH, "--execute"]);
    expect(tsRestore.stdout).toContain("restored type=doc");
    expect(runGoIn(b, ["doc", "edit", ARCH, "-c", "after ts restore"]).code).toBe(0);
    expect((await runTsIn(b, ["doc", "edit", ARCH, "-c", "again"])).code).toBe(0);
  });
});

describe("reconcile preview and apply are removed (D7)", () => {
  test("every spelling prints the removal message and exits non-zero", async () => {
    const p = makeProject("full");
    projects.push(p);
    for (const args of [
      ["reconcile"],
      ["reconcile", "preview"],
      ["reconcile", "apply"],
      ["reconcile", "--execute"],
      ["reconcile", "apply", "--execute", "--wait"],
    ]) {
      const r = await runTsIn(p, args);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("preview and apply were removed");
      expect(r.stderr).toContain("reconcile restore");
    }
  });
});

describe("git stash -u of byte-identical docs", () => {
  test("records a restore and later writes succeed", async () => {
    const p = makeProject("full");
    projects.push(p);
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", ...a], {
        cwd: p.dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    };
    const root = join(p.dir, ".knowns");
    const rec = new FilesystemReconciler(root);
    let now = new Date("2026-11-05T10:00:00Z");
    rec.setLifecycleClock(() => now);
    // Establish ownership, as the runtime's startup pass does, before committing the state files
    // (manifest, history) so the stash removes only the untracked docs.
    await rec.reconcileLifecycle(true);
    git("init", "-q");
    git("add", "-A", ":!.knowns/docs");
    git("commit", "-q", "-m", "base", "--allow-empty");

    git("stash", "-u", "-q");
    expect(existsSync(join(root, "docs/architecture.md"))).toBe(false);
    // First pass records the absence; the quiet window must pass before a tombstone is written.
    const first = await rec.reconcileLifecycle(true);
    expect(first.some((r) => r.pending)).toBe(true);
    now = new Date(now.getTime() + 4000);
    const second = await rec.reconcileLifecycle(true);
    expect(second.filter((r) => r.operation === "delete").length).toBeGreaterThan(0);

    git("stash", "pop", "-q");
    expect(existsSync(join(root, "docs/architecture.md"))).toBe(true);
    const third = await rec.reconcileLifecycle(true);
    const restores = third.filter((r) => r.operation === "restore" && r.diagnostic === "");
    expect(restores.length).toBeGreaterThan(0);

    const edit = await runTsIn(p, ["doc", "edit", ARCH, "-c", "written after the stash"]);
    expect(edit.stderr).toBe("");
    expect(edit.code).toBe(0);
    // Go accepts the TS-written tombstone and restore chain too.
    const goEdit = runGoIn(p, ["doc", "edit", ARCH, "-c", "go also writes"]);
    expect(goEdit.code).toBe(0);
    const hist = runGoIn(p, ["doc", "history", ARCH, "--plain"]);
    expect(hist.code).toBe(0);
  });
});
