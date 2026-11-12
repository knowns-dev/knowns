// `knowns setup [target]` and `setup --global` against the Go 0.34.1 oracle: stdout, stderr, exit
// code, the project tree and the HOME tree must match.
//
// Normalised on top of init-harness: the path of the running executable (the Go binary on one
// side, bun on the other) is recorded in runtime hooks and in the MCP command, so it becomes
// <EXE>. Runtime hooks are only written for CLIs found on PATH; a directory of fake CLIs
// (claude, codex, kiro, opencode, knowns) is put first on PATH for the cases that exercise them.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { GO_BIN } from "../oracle.ts";
import {
  compareInit,
  disposeInit,
  hasGoBin,
  type InitProject,
  type InitStep,
  treeDiff,
} from "./init-harness.ts";

const cases = hasGoBin ? describe : describe.skip;

const fakeBin = mkdtempSync(join(tmpdir(), "knowns-setup-bin-"));
for (const name of ["claude", "codex", "kiro", "opencode", "knowns"]) {
  const file = join(fakeBin, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
}
afterAll(() => rmSync(fakeBin, { recursive: true, force: true }));
const withFakeClis = { PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}` };

const exeForms = (): string[] => {
  // A binary reports its own path normalized (D:\a\_temp\knowns-go.exe on Windows), which can
  // differ in separators from the KNOWNS_GO_BIN value the runner set (D:\a\_temp/knowns-go.exe).
  const raw = [
    ...new Set([GO_BIN ?? "", process.execPath].flatMap((p) => (p === "" ? [] : [p, resolve(p)]))),
  ];
  return raw.flatMap((p) => [p, JSON.stringify(p).slice(1, -1)]);
};
const exeNorm = (m: Map<string, string>): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of m) {
    let s = v;
    for (const f of exeForms()) s = s.replaceAll(f, "<EXE>");
    out.set(k, s);
  }
  return out;
};
const exeText = (s: string): string => exeForms().reduce((a, f) => a.replaceAll(f, "<EXE>"), s);

async function expectSetupParity(
  steps: Array<InitStep | string[]>,
  setup?: (p: InitProject) => void,
): Promise<void> {
  const c = await compareInit(steps, setup ? { setup } : {});
  try {
    for (let i = 0; i < steps.length; i++) {
      const raw = steps[i] as InitStep | string[];
      const label = (Array.isArray(raw) ? raw : raw.args).join(" ");
      const go = c.go[i] as { code: number; stdout: string; stderr: string };
      const ts = c.ts[i] as { code: number; stdout: string; stderr: string };
      expect({
        step: label,
        ...ts,
        stdout: exeText(ts.stdout),
        stderr: exeText(ts.stderr),
      }).toEqual({ step: label, ...go, stdout: exeText(go.stdout), stderr: exeText(go.stderr) });
    }
    expect(treeDiff(exeNorm(c.goTree), exeNorm(c.tsTree))).toEqual([]);
    expect(treeDiff(exeNorm(c.goHome), exeNorm(c.tsHome))).toEqual([]);
  } finally {
    disposeInit(c.goP);
    disposeInit(c.tsP);
  }
}

const INIT: string[] = ["init", "--no-wizard"];
const TARGETS = [
  "claude",
  "opencode",
  "hermes",
  "codex",
  "copilot",
  "kiro",
  "cursor",
  "gemini",
  "antigravity",
  "agents",
  "all",
];
const SLOW = 120_000;

cases("setup matches Go", () => {
  for (const target of TARGETS) {
    test(
      `setup ${target}`,
      async () => {
        await expectSetupParity([INIT, ["setup", target]]);
      },
      SLOW,
    );
  }

  test(
    "every target with the runtime CLIs installed",
    async () => {
      for (const target of ["claude", "codex", "kiro", "opencode", "all"]) {
        await expectSetupParity([
          INIT,
          { args: ["setup", target], env: withFakeClis },
          { args: ["setup", target, "--force"], env: withFakeClis },
        ]);
      }
    },
    SLOW * 3,
  );

  test(
    "--force rewrites generated files, a second run keeps them",
    async () => {
      await expectSetupParity([
        INIT,
        ["setup", "claude"],
        ["setup", "claude"],
        ["setup", "claude", "-f"],
      ]);
      await expectSetupParity([INIT, ["setup", "kiro"], ["setup", "kiro", "--force"]]);
      await expectSetupParity([
        INIT,
        ["setup", "antigravity"],
        ["setup", "antigravity", "--force"],
      ]);
    },
    SLOW * 3,
  );

  test(
    "merges into existing MCP configs",
    async () => {
      await expectSetupParity([INIT, ["setup", "all"]], (p) => {
        for (const [dir, rel, text] of [
          [p.dir, "opencode.json", '{"theme":"dark","mcp":{"other":{"type":"local"}}}'],
          [p.dir, ".cursor/mcp.json", '{"mcpServers":{"other":{"command":"x"}}}'],
          [p.dir, ".codex/config.toml", 'model = "o3"\n'],
          [p.dir, ".mcp.json", '{"mcpServers":{"mine":{"command":"y"}}}'],
        ] as const) {
          mkdirSync(join(dir, rel, ".."), { recursive: true });
          writeFileSync(join(dir, rel), text);
        }
      });
    },
    SLOW,
  );

  test(
    "errors: unknown target, no project, extra argument",
    async () => {
      await expectSetupParity([INIT, ["setup", "bogus"]]);
      await expectSetupParity([["setup", "claude"]]);
      await expectSetupParity([INIT, ["setup", "claude", "extra"]]);
      await expectSetupParity([
        ["setup", "--help"],
        ["help", "setup"],
      ]);
    },
    SLOW,
  );

  test(
    "no target and no terminal fails like huh",
    async () => {
      if (process.platform === "win32") return; // Go's wizard opens the console and waits there.
      await expectSetupParity([INIT, { args: ["setup"], detached: true }]);
    },
    SLOW,
  );
});

cases("setup --global matches Go", () => {
  for (const target of TARGETS) {
    test(
      `setup ${target} --global`,
      async () => {
        await expectSetupParity([["setup", target, "--global"]]);
      },
      SLOW,
    );
  }

  test(
    "global with the runtime CLIs installed, run twice",
    async () => {
      await expectSetupParity([
        { args: ["setup", "all", "--global"], env: withFakeClis },
        { args: ["setup", "all", "--global"], env: withFakeClis },
      ]);
    },
    SLOW,
  );

  test(
    "merges into existing global configs and keeps other settings",
    async () => {
      await expectSetupParity([["setup", "all", "--global"]], (p) => {
        mkdirSync(join(p.home, ".knowns"), { recursive: true });
        writeFileSync(
          join(p.home, ".knowns", "settings.json"),
          JSON.stringify({
            projectDefaults: { projectName: "mine", settings: { defaultPriority: "high" } },
          }),
        );
        mkdirSync(join(p.home, ".gemini"), { recursive: true });
        writeFileSync(
          join(p.home, ".gemini", "settings.json"),
          '{"theme":"x","mcpServers":{"a":{"command":"b"}}}',
        );
        writeFileSync(join(p.home, ".claude.json"), "not json");
      });
    },
    SLOW,
  );

  test(
    "errors",
    async () => {
      await expectSetupParity([["setup", "bogus", "--global"]]);
      if (process.platform !== "win32")
        await expectSetupParity([{ args: ["setup", "--global"], detached: true }]);
    },
    SLOW,
  );
});
