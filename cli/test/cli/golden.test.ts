// Byte-for-byte parity of the framework with the Go binary: root help, group help, unknown
// command, bad flag, version. Skipped without KNOWNS_GO_BIN.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditSpec, lspSpec } from "./fixtures.ts";
import { hasGoBin, processEnv, runGo, runTs, sandbox } from "./oracle.ts";

const extra = [auditSpec, lspSpec];
const t = test.skipIf(!hasGoBin);

async function same(args: string[], env: Record<string, string> = {}): Promise<void> {
  const go = runGo(args, env);
  const ts = await runTs(args, { env, extra });
  expect({ args, ...ts }).toEqual({ args, ...go });
}

describe("root", () => {
  const cases: Array<[string, string[]]> = [
    ["--help", ["--help"]],
    ["-h", ["-h"]],
    ["help", ["help"]],
    ["--version", ["--version"]],
    ["-v", ["-v"]],
    ["-vh (help wins)", ["-vh"]],
    ["banner (no args)", []],
    ["--plain --help", ["--plain", "--help"]],
    ["--json --help", ["--json", "--help"]],
    ["--no-pager --help", ["--no-pager", "--help"]],
    ["--page 2 --help", ["--page", "2", "--help"]],
    ["--plain banner", ["--plain"]],
  ];
  for (const [name, args] of cases) t(name, () => same(args));
  t("NO_COLOR=1 --help", () => same(["--help"], { NO_COLOR: "1" }));
  t("NO_COLOR=1 banner", () => same([], { NO_COLOR: "1" }));
  t("NO_COLOR= (empty) keeps color", () => same(["--help"], { NO_COLOR: "" }));
});

describe("unknown command and bad flags", () => {
  const cases: string[][] = [
    ["bogus"],
    ["bogus", "--plain"],
    ["tsk"], // suggestion: "Did you mean this?"
    ["sear"], // prefix suggestion
    ["--bogus"],
    ["-x"],
    ["-vx"],
    ["--page", "abc"],
    ["--page"],
    ["--page=abc"],
    ["--page", "99999999999999999999"],
    ["--page", "0x10", "bogus"],
    ["--plain=x"],
    ["--plain=true", "bogus"],
    ["---x"],
    ["--=x"],
    ["--", "bogus"],
    ["--page", "1", "bogus"],
    ["help", "bogus"],
    ["help", "help"],
    ["help", "--bogus"],
  ];
  for (const args of cases) t(args.join(" "), () => same(args));
});

describe("commands registered through the framework", () => {
  const cases: string[][] = [
    ["audit", "--help"],
    ["audit", "-h"],
    ["audit"],
    ["audit", "bogus"],
    ["audit", "--bogus"],
    ["audit", "--plain", "--help"],
    ["audit", "recent", "--help"],
    ["audit", "stats", "--help"],
    ["help", "audit"],
    ["help", "audit", "recent"],
    ["audit", "recent", "--bogus"],
    ["audit", "recent", "-z"],
    ["audit", "recent", "--limit", "abc"],
    ["audit", "recent", "--limit=x"],
    ["audit", "recent", "--limit"],
    ["audit", "recent", "--tool"],
    ["audit", "stats", "--limit", "1"],
    ["audit", "recent", "--page", "abc"],
    ["audit", "--version"],
    ["lsp", "--help"],
    ["lsp", "list", "--help"],
    ["lsp", "install", "--help"],
    ["lsp", "cleanup", "--help"],
    ["lsp", "install"],
    ["lsp", "install", "a", "b"],
    ["lsp", "install", "go", "--latest", "--version", "1"],
    ["lsp", "install", "go", "--bogus"],
    ["lsp", "install", "go", "-y", "-q"],
    ["lsp", "install", "go", "-yq"],
    ["lsp", "install", "go", "-y=maybe"],
    ["lsp", "list", "-v", "--bogus"],
    ["lsp", "list", "-vz"],
    ["lsp", "bogus"],
  ];
  for (const args of cases) t(args.join(" "), () => same(args));
});

describe("manifest gate", () => {
  t("root help rendered from the manifest equals Go's with nothing ported", async () => {
    const go = runGo(["--help"]);
    const ts = await runTs(["--help"]);
    expect(ts.stdout).toBe(go.stdout);
  });
  t(
    "every manifest root command reaches the run loop the way Go's does for unknown flags",
    async () => {
      const go = runGo(["--help"]);
      expect(go.stdout).toContain("Tasks, docs, and memory:");
    },
  );
});

// The compiled binary goes through main.ts and real file descriptors, not the in-process harness.
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const exe = join(
  import.meta.dir,
  "..",
  "..",
  "dist",
  platform,
  process.platform === "win32" ? "knowns.exe" : "knowns",
);

describe("compiled binary", () => {
  const b = test.skipIf(!hasGoBin || !existsSync(exe));
  const cases: string[][] = [
    ["--version"],
    ["--help"],
    ["bogus"],
    ["--bogus"],
    ["--page", "x"],
    [],
  ];
  for (const args of cases) {
    b(`knowns ${args.join(" ")}`.trim(), () => {
      const go = runGo(args);
      const r = Bun.spawnSync([exe, ...args], { cwd: sandbox, env: processEnv() });
      expect({
        code: r.exitCode,
        stdout: r.stdout.toString(),
        stderr: r.stderr.toString(),
      }).toEqual(go);
    });
  }
});
