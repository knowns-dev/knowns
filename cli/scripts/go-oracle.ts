// Builds the Go parity oracle from the last commit that still had the Go implementation.
//
// Go was removed from the tree after 0.35.0 (KN-NDD5YY). Differential tests keep comparing the
// TypeScript CLI with that frozen Go code: this script extracts the pinned commit with `git archive`
// (no worktree is registered), builds the CLI from it, and exports
//   KNOWNS_GO_SRC  the extracted tree; test helpers compile their Go tools inside it
//   KNOWNS_GO_BIN  the CLI built from it
// The pin never moves: the oracle is the behavior TS must keep, not code anyone edits.
//
// Usage: bun scripts/go-oracle.ts [--dir <path>] [--github-env]
//   prints `export KNOWNS_GO_SRC=... KNOWNS_GO_BIN=...` lines for `eval "$(...)"`, or with
//   --github-env appends them to $GITHUB_ENV. Needs git and a Go toolchain; reuses a finished build.
import { appendFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The last commit with cmd/, internal/ and go.mod (the 0.35.1 decision-review hotfix head). */
export const GO_ORACLE_SHA = "069954a58d637bbf925e3ad4bf27bebace89f430";

const REPO = resolve(import.meta.dir, "..", "..");

function run(cmd: string[], cwd: string): string {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

function hasCommit(sha: string): boolean {
  return (
    Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: REPO, stderr: "pipe" })
      .exitCode === 0
  );
}

export function buildGoOracle(dir: string): { src: string; bin: string } {
  const exe = process.platform === "win32" ? "knowns-go.exe" : "knowns-go";
  const bin = join(dir, "bin", exe);
  const done = join(dir, ".oracle-built");
  if (existsSync(done) && existsSync(bin)) return { src: dir, bin };

  if (!hasCommit(GO_ORACLE_SHA)) {
    run(["git", "fetch", "--no-tags", "--depth=1", "origin", GO_ORACLE_SHA], REPO);
  }
  mkdirSync(dir, { recursive: true });
  const tarName = `${GO_ORACLE_SHA.slice(0, 12)}.tar`;
  run(["git", "archive", "--format=tar", "-o", join(dir, "..", tarName), GO_ORACLE_SHA], REPO);
  // Relative archive path with cwd = dir: Git Bash's GNU tar reads "C:\..." as a remote host.
  run(["tar", "-xf", `../${tarName}`], dir);

  // ui/embed.go embeds ui/dist; the oracle never serves the UI in diff tests, but the embed needs
  // at least one file. Use the real build when there is one.
  const dist = join(dir, "ui", "dist");
  if (existsSync(join(REPO, "ui", "dist", "index.html"))) {
    cpSync(join(REPO, "ui", "dist"), dist, { recursive: true });
  } else {
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>knowns oracle</title>\n");
  }

  // No -ldflags: the oracle reports "dev", which test/cli/oracle.ts normalizes. This is how CI
  // built KNOWNS_GO_BIN before the removal.
  mkdirSync(join(dir, "bin"), { recursive: true });
  run(["go", "build", "-o", bin, "./cmd/knowns"], dir);
  writeFileSync(done, `${GO_ORACLE_SHA}\n`);
  return { src: dir, bin };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf("--dir");
  const dir = resolve(
    dirIdx >= 0 && args[dirIdx + 1]
      ? (args[dirIdx + 1] as string)
      : join(tmpdir(), "knowns-go-oracle", GO_ORACLE_SHA.slice(0, 12)),
  );
  const { src, bin } = buildGoOracle(dir);
  if (args.includes("--github-env")) {
    const file = process.env.GITHUB_ENV;
    if (!file) throw new Error("--github-env needs GITHUB_ENV");
    appendFileSync(file, `KNOWNS_GO_SRC=${src}\nKNOWNS_GO_BIN=${bin}\n`);
    console.error(`oracle ${GO_ORACLE_SHA.slice(0, 12)}: ${bin}`);
  } else {
    console.log(`export KNOWNS_GO_SRC='${src}'`);
    console.log(`export KNOWNS_GO_BIN='${bin}'`);
  }
}
