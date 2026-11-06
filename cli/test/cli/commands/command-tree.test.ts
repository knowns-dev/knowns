// Every 0.34.1 command and subcommand is ported (FR-1): walk the Go command tree through the
// oracle's own `__completeNoDesc` protocol, add the hidden root commands the root-help manifest
// knows about (completion lists only available commands), and fail on any path where the
// TypeScript build still reaches the not-ported placeholder. `<path> --help` is safe to run: a
// ported command prints its help, while the placeholder disables flag parsing and so runs and
// prints its "not available in the TypeScript build yet" error.
import { describe, expect, test } from "bun:test";
import { ROOT_MANIFEST } from "../../../src/cli/core/help-manifest.generated.ts";
import { hasGoBin, runGo, runTs } from "../oracle.ts";

const PLACEHOLDER = "is not available in the TypeScript build yet";

/** Go's subcommands of `path`, via the completion protocol (names only). */
function goChildren(path: string[]): string[] {
  const r = runGo(["__completeNoDesc", ...path, ""]);
  const names: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line === "" || line.startsWith(":")) break;
    names.push(line);
  }
  return names;
}

function walk(): string[][] {
  const out: string[][] = [];
  const visit = (path: string[], depth: number) => {
    out.push(path);
    if (depth > 6) return;
    for (const name of goChildren(path)) {
      // `help` completes every command again; `completion` is covered by its own test file.
      if (name === "help" && path.length === 0) continue;
      visit([...path, name], depth + 1);
    }
  };
  for (const name of goChildren([])) {
    if (name === "help") continue;
    visit([name], 1);
  }
  for (const entry of ROOT_MANIFEST) {
    if (entry.hidden && !out.some((p) => p.length === 1 && p[0] === entry.name)) {
      visit([entry.name], 1);
    }
  }
  return out;
}

describe.skipIf(!hasGoBin)("the Go command tree is fully ported", () => {
  const paths = hasGoBin ? walk() : [];

  test("the walk found the tree", () => {
    // 0.34.1 has well over a hundred command paths; a tiny count means the walk broke.
    expect(paths.length).toBeGreaterThan(100);
    const flat = paths.map((p) => p.join(" "));
    for (const known of [
      "runtime memory hook",
      "runtime-memory hook",
      "provider add",
      "eval retrieval",
    ]) {
      expect(flat).toContain(known);
    }
  });

  for (const path of paths) {
    test(`knowns ${path.join(" ")}`, async () => {
      const ts = await runTs([...path, "--help"]);
      expect(ts.stderr).not.toContain(PLACEHOLDER);
      expect(ts.stdout).not.toContain(PLACEHOLDER);
    });
  }
});
