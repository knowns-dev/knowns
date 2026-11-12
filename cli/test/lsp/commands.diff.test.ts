// `knowns code` and `knowns lsp` against the Go 0.34.1 oracle. Servers on PATH (gopls,
// typescript-language-server) are real; managed installs are hidden by an empty HOME and
// KNOWN_LSP_AUTO_INSTALL=0. The daemon is disabled for both so no background process is involved.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasGoBin, makePair, normalized, runBoth } from "../cli/commands/harness.ts";

const env = { KNOWNS_LSP_DAEMON: "0", KNOWN_LSP_AUTO_INSTALL: "0", KNOWNS_RUNTIME_INLINE: "1" };
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  Object.assign(process.env, env);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const cases = hasGoBin ? describe : describe.skip;
const hasBin = (n: string): boolean => Bun.which(n) !== null;

function scrub(pair: ReturnType<typeof makePair>, side: "go" | "ts", text: string): string {
  // macOS: Go reports the symlink-resolved cwd (/private/var/...) for the same directory.
  // Windows: JSON output escapes the backslashes, which the raw path misses.
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  return text
    .replaceAll(`/private${pair[side].dir}`, "<DIR>")
    .replaceAll(pair[side].dir, "<DIR>")
    .replaceAll(esc(pair[side].dir), "<DIR>")
    .replaceAll(pair[side].home, "<HOME>")
    .replaceAll(esc(pair[side].home), "<HOME>");
}

async function both(pair: ReturnType<typeof makePair>, args: string[]) {
  const run = await runBoth(pair, args, { env });
  const n = normalized(pair, run);
  return {
    go: { ...n.go, stdout: scrub(pair, "go", n.go.stdout), stderr: scrub(pair, "go", n.go.stderr) },
    ts: { ...n.ts, stdout: scrub(pair, "ts", n.ts.stdout), stderr: scrub(pair, "ts", n.ts.stderr) },
  };
}

cases("lsp commands", () => {
  const pair = makePair("empty");
  // The in-process TS CLI reads HOME from process.env (the Go child gets it from the harness).
  beforeAll(() => {
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    process.env.HOME = pair.ts.home;
    process.env.USERPROFILE = pair.ts.home;
  });
  for (const side of [pair.go, pair.ts]) {
    mkdirSync(join(side.dir, "src"), { recursive: true });
    writeFileSync(
      join(side.dir, "src", "a.go"),
      'package a\n\n// Hello greets.\nfunc Hello() string { return "hi" }\n\ntype Thing struct{}\n',
    );
    writeFileSync(
      join(side.dir, "src", "b.ts"),
      '// Widget renders.\nexport class Widget {\n  render(): string { return "w"; }\n}\n',
    );
  }

  for (const args of [
    ["lsp", "list", "--json"],
    ["lsp", "list", "--plain"],
    ["lsp", "list", "--verbose", "--plain"],
    ["lsp", "cleanup", "--json"],
    ["lsp", "cleanup", "--plain"],
    ["lsp", "install", "nonesuch"],
    ["lsp", "install", "ruby"],
    ["lsp", "install", "go", "--latest", "--version", "1"],
    ["code", "symbols", "--json"],
    ["code", "deps", "--plain"],
  ]) {
    // `lsp install ruby` checks the no-gem error path; with gem on PATH (GitHub's ubuntu image)
    // both sides start a real ruby-lsp install instead.
    const skip = args[2] === "ruby" && hasBin("gem");
    test.skipIf(skip)(args.join(" "), async () => {
      const { go, ts } = await both(pair, args);
      expect(ts).toEqual(go);
    }, 60_000);
  }

  test.skipIf(!hasBin("gopls"))(
    "code search (gopls)",
    async () => {
      const { go, ts } = await both(pair, [
        "code",
        "search",
        "hello",
        "--path",
        "src/a.go",
        "--json",
      ]);
      expect(ts).toEqual(go);
      expect(go.stdout).toContain("Hello");
    },
    120_000,
  );

  test.skipIf(!hasBin("typescript-language-server"))(
    "code search (typescript)",
    async () => {
      const { go, ts } = await both(pair, [
        "code",
        "search",
        "widget render",
        "--path",
        "src/b.ts",
        "--plain",
      ]);
      expect(ts).toEqual(go);
      expect(go.stdout).toContain("Widget");
    },
    120_000,
  );
});
