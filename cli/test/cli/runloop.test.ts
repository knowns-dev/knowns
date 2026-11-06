// Run-loop behaviour: warnings, update notice, exit codes, handler errors, flag validation,
// lazy command loading and the output-mode helpers. Parity cases use the Go binary when present.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactArgs } from "../../src/cli/core/args.ts";
import { defineCommand } from "../../src/cli/core/define.ts";
import { exitCode, exitError, SilentExit } from "../../src/cli/core/exit.ts";
import { renderSuccess } from "../../src/cli/core/plainoutput.ts";
import { shouldCheckForUpdate, shouldSkipCLIWarnings } from "../../src/cli/core/root.ts";
import { hasGoBin, runGo, runTs, sandbox } from "./oracle.ts";

const t = test.skipIf(!hasGoBin);

function project(schemaVersion: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knowns-cli-proj-")));
  cpSync(join(import.meta.dir, "..", "fixtures", "empty"), dir, { recursive: true });
  const cfgPath = join(dir, ".knowns", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  cfg.schemaVersion = schemaVersion;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return dir;
}

describe("unmigrated config warning", () => {
  t("matches Go on stderr and exit code", async () => {
    const dir = project(0);
    for (const args of [["--version"], ["--help"], ["bogus"]]) {
      const go = runGo(args, {}, dir);
      const ts = await runTs(args, { cwd: dir, configWarning: true });
      expect(go.stderr).toContain("needs migrating");
      expect(ts).toEqual(go);
    }
  });
  t("is skipped for migrate/doctor like Go", async () => {
    const dir = project(0);
    const go = runGo(["migrate", "--help"], {}, dir);
    const ts = await runTs(["migrate", "--help"], { cwd: dir, configWarning: true });
    expect(go.stderr).not.toContain("needs migrating");
    expect(ts.stderr).not.toContain("needs migrating");
  });
  test("a current project and no project print nothing", async () => {
    const ts = await runTs(["--version"], { cwd: sandbox, configWarning: true });
    expect(ts.stderr).toBe("");
  });
  test("skip list is Go's", () => {
    expect(shouldSkipCLIWarnings(["x", "doctor"])).toBe(true);
    expect(shouldSkipCLIWarnings(["task", "list"])).toBe(false);
  });
});

describe("update notice", () => {
  const ran = (
    notice: string,
    args: string[],
    timeoutMs = 3000,
    env: Record<string, string> = {},
  ) =>
    runTs(args, {
      checkForUpdate: async () => notice,
      updateTimeoutMs: timeoutMs,
      env: { CI: "", NO_UPDATE_CHECK: "", ...env },
    });

  test("printed to stderr after a successful command", async () => {
    const r = await ran("\n UPDATE  v9 available\n", ["--version"]);
    expect(r.stdout).toBe("knowns version 0.34.1\n");
    expect(r.stderr).toBe("\n UPDATE  v9 available\n");
  });
  test("not printed when the command fails", async () => {
    const r = await ran("NOTICE", ["bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("NOTICE");
  });
  test("not printed with --plain, --json, update, CI or NO_UPDATE_CHECK", async () => {
    for (const args of [
      ["--plain", "--version"],
      ["--json", "--version"],
    ]) {
      expect((await ran("NOTICE", args)).stderr).toBe("");
    }
    expect((await ran("NOTICE", ["--version"], 3000, { CI: "1" })).stderr).toBe("");
    expect((await ran("NOTICE", ["--version"], 3000, { NO_UPDATE_CHECK: "1" })).stderr).toBe("");
  });
  test("a slow check is abandoned after the timeout", async () => {
    const r = await runTs(["--version"], {
      checkForUpdate: () => new Promise((res) => setTimeout(() => res("LATE"), 500)),
      updateTimeoutMs: 20,
      env: { CI: "", NO_UPDATE_CHECK: "" },
    });
    expect(r.stderr).toBe("");
  });
  test("shouldCheckForUpdate mirrors Go's table", () => {
    const env = {};
    expect(shouldCheckForUpdate(["task", "list"], env)).toBe(true);
    expect(shouldCheckForUpdate(["task", "list", "--plain"], env)).toBe(false);
    expect(shouldCheckForUpdate(["update", "--check"], env)).toBe(false);
    expect(shouldCheckForUpdate([], { CI: "true" })).toBe(false);
    expect(shouldCheckForUpdate([], { NO_UPDATE_CHECK: "1" })).toBe(false);
  });
});

describe("handler errors and exit codes", () => {
  const failing = defineCommand({
    use: "boom",
    short: "Fails",
    run: () => {
      throw new Error("kaput");
    },
  });
  const custom = defineCommand({
    use: "gate",
    short: "Exits with a custom code",
    silenceUsage: true,
    run: () => {
      throw exitError(3, new Error("gate failed"));
    },
  });
  const silent = defineCommand({
    use: "quiet",
    short: "Already reported",
    run: (ctx) => {
      ctx.printErr("my own diagnostic\n");
      throw new SilentExit(7);
    },
  });
  const extra = [failing, custom, silent];

  test("a plain Error exits 1 with Error: and usage, like cobra", async () => {
    const r = await runTs(["boom"], { extra });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.startsWith("Error: kaput\nUsage:\n  knowns boom [flags]\n")).toBe(true);
    expect(r.stderr.endsWith("\n\n")).toBe(true);
  });
  test("exitError carries its code; silenceUsage drops the usage", async () => {
    const r = await runTs(["gate"], { extra });
    expect(r).toEqual({ code: 3, stdout: "", stderr: "Error: gate failed\n" });
  });
  test("SilentExit prints nothing of its own", async () => {
    const r = await runTs(["quiet"], { extra });
    expect(r).toEqual({ code: 7, stdout: "", stderr: "my own diagnostic\n" });
  });
  test("exitCode unwraps causes", () => {
    expect(exitCode(undefined)).toBe(0);
    expect(exitCode(new Error("x"))).toBe(1);
    expect(exitCode(exitError(4))).toBe(4);
    expect(exitCode(new Error("outer", { cause: exitError(5) }))).toBe(5);
    expect(exitError(2).message).toBe("command completed with a non-zero status");
  });

  const task = defineCommand({
    use: "task",
    short: "Manage tasks",
    silenceUsage: false,
    run: async (ctx) => {
      await ctx.getStore();
    },
  });
  t("getStore failure text and exit code match Go (no project)", async () => {
    const go = runGo(["task", "bogus"]);
    const ts = await runTs(["task", "bogus"], { extra: [task] });
    expect(go.code).toBe(1);
    expect(ts).toEqual(go);
  });
});

describe("flags", () => {
  const spec = defineCommand({
    use: "probe",
    short: "Probe",
    flags: [
      { type: "string", name: "name", usage: "A `name`", required: true },
      { type: "stringArray", name: "tag", usage: "Repeatable", shorthand: "t" },
      { type: "stringSlice", name: "csv", usage: "Comma list" },
      { type: "intSlice", name: "nums", usage: "Ints" },
      { type: "int", name: "n", usage: "Count", default: 5 },
      { type: "duration", name: "wait", usage: "Wait", default: 90e9 },
      { type: "float64", name: "ratio", usage: "Ratio" },
      { type: "bool", name: "a", usage: "A" },
      { type: "bool", name: "b", usage: "B" },
      { type: "string", name: "color", usage: "Colour", noOptDefVal: "auto" },
      { type: "bool", name: "hush", usage: "Hidden", hidden: true },
    ],
    flagGroups: { requiredTogether: [["a", "b"]] },
    run: (ctx) => {
      const f = ctx.flags;
      ctx.print(
        `${JSON.stringify({
          name: f.string("name"),
          tag: f.strings("tag"),
          csv: f.strings("csv"),
          nums: f.ints("nums"),
          n: f.int("n"),
          wait: f.int === undefined ? 0 : ctx.cmd.getString("name"),
          ratio: f.float("ratio"),
          color: f.string("color"),
          changed: f.changed("n"),
          args: ctx.args,
        })}\n`,
      );
    },
  });
  const run = (...args: string[]) => runTs(["probe", ...args], { extra: [spec] });

  test("typed values, repeated and CSV flags, shorthand, noOptDefVal, positional args", async () => {
    const r = await run(
      "--name=x",
      "-t",
      "a",
      "-tb",
      "--tag",
      "c",
      "--csv",
      "p,q",
      "--csv",
      "r",
      "--nums",
      "1,2",
      "-- ",
      "pos",
    );
    expect(r.code).toBe(1); // "-- " (with a space) is not "--", so it is a bad flag
    const ok = await run(
      "--name=x",
      "-t",
      "a",
      "-tb",
      "--tag",
      "c",
      "--csv",
      "p,q",
      "--csv",
      "r",
      "--nums",
      "1,2",
      "--n",
      "0x10",
      "--color",
      "--",
      "pos",
      "--name",
    );
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      name: "x",
      tag: ["a", "b", "c"],
      csv: ["p", "q", "r"],
      nums: [1, 2],
      n: 16,
      color: "auto",
      changed: true,
      args: ["pos", "--name"],
    });
  });
  test("required flag", async () => {
    const r = await run();
    expect(r.stderr.startsWith('Error: required flag(s) "name" not set\nUsage:')).toBe(true);
  });
  test("flag groups", async () => {
    const r = await run("--name=x", "-a".replace("-a", "--a"));
    expect(r.stderr.split("\n")[0]).toBe(
      "Error: if any flags in the group [a b] are set they must all be set; missing [b]",
    );
  });
  test("value errors use Go's strconv text", async () => {
    const msgs = await Promise.all(
      [
        "--n=abc",
        "--n=1.5",
        "--n=99999999999999999999",
        "--wait=5",
        "--wait=1x",
        "--wait=",
        "--ratio=z",
        "--nums=1,x",
        "--a=maybe",
      ].map(async (a) => (await run("--name=x", a)).stderr.split("\n")[0]),
    );
    expect(msgs).toEqual([
      'Error: invalid argument "abc" for "--n" flag: strconv.ParseInt: parsing "abc": invalid syntax',
      'Error: invalid argument "1.5" for "--n" flag: strconv.ParseInt: parsing "1.5": invalid syntax',
      'Error: invalid argument "99999999999999999999" for "--n" flag: strconv.ParseInt: parsing "99999999999999999999": value out of range',
      'Error: invalid argument "5" for "--wait" flag: time: missing unit in duration "5"',
      'Error: invalid argument "1x" for "--wait" flag: time: unknown unit "x" in duration "1x"',
      'Error: invalid argument "" for "--wait" flag: time: invalid duration ""',
      'Error: invalid argument "z" for "--ratio" flag: strconv.ParseFloat: parsing "z": invalid syntax',
      'Error: invalid argument "1,x" for "--nums" flag: strconv.Atoi: parsing "x": invalid syntax',
      'Error: invalid argument "maybe" for "--a" flag: strconv.ParseBool: parsing "maybe": invalid syntax',
    ]);
  });
  test("help renders defaults, value names and hides hidden flags", async () => {
    const r = await runTs(["probe", "--plain", "--help"], { extra: [spec] });
    expect(r.stdout).toContain('--color string[="auto"]');
    expect(r.stdout).toContain("--name name");
    expect(r.stdout).toContain("--n int");
    expect(r.stdout).toContain("(default 5)");
    expect(r.stdout).toContain("(default 1m30s)");
    expect(r.stdout).toContain("-t, --tag stringArray");
    expect(r.stdout).toContain("--csv strings");
    expect(r.stdout).not.toContain("hush");
  });
});

describe("output modes and paging", () => {
  const spec = defineCommand<{ rows: string[] }>({
    use: "rows",
    short: "Rows",
    run: () => ({ rows: Array.from({ length: 5 }, (_, i) => `row${i + 1}`) }),
    render: {
      styled: (r) => `${r.rows.map((x) => `* ${x}`).join("\n")}\n`,
      plain: (r) => `${r.rows.join("\n")}\n`,
    },
  });
  const run = (...args: string[]) => runTs(["rows", ...args], { extra: [spec] });

  test("styled, plain, json", async () => {
    expect((await run()).stdout).toBe("* row1\n* row2\n* row3\n* row4\n* row5\n");
    expect((await run("--plain")).stdout).toBe("row1\nrow2\nrow3\nrow4\nrow5\n");
    expect((await run("--json")).stdout).toBe(
      '{\n  "rows": [\n    "row1",\n    "row2",\n    "row3",\n    "row4",\n    "row5"\n  ]\n}\n',
    );
  });
  test("--json wins over --plain; JSON escapes like Go", async () => {
    expect((await run("--plain", "--json")).stdout.startsWith("{")).toBe(true);
    const esc = defineCommand({
      use: "esc",
      short: "Escapes",
      run: () => ({ s: "<a & b>" }),
      render: {},
    });
    expect((await runTs(["esc", "--json"], { extra: [esc] })).stdout).toBe(
      '{\n  "s": "\\u003ca \\u0026 b\\u003e"\n}\n',
    );
  });
  test("--page pages plain output with Go's footer", async () => {
    const r = await run("--plain", "--page", "2", "--page-size", "2");
    expect(r.stdout).toBe("row3\nrow4\n\nPAGE: 2/3 (lines 3-4 of 5, page-size 2)\n");
    expect((await run("--plain", "--page", "9", "--page-size", "2")).stdout).toBe(
      "PAGE: 9/3 (no more content)\n",
    );
  });
});

describe("lazy loading", () => {
  test("a loader runs only when its command is selected", async () => {
    let loads = 0;
    const loaders = {
      task: {
        load: async () => {
          loads++;
          return {
            default: defineCommand({
              use: "task",
              short: "Manage tasks",
              run: (c) => c.print("ran\n"),
            }),
          };
        },
      },
    };
    const help = await runTs(["--help"], { extra: [] });
    expect(help.code).toBe(0);
    const { execute } = await import("../../src/cli/core/root.ts");
    const { memoryIO } = await import("../../src/cli/core/io.ts");
    const a = memoryIO();
    expect(await execute(["--help"], { io: a.io, loaders, skipConfigWarning: true })).toBe(0);
    expect(loads).toBe(0);
    const b = memoryIO();
    expect(await execute(["--plain", "task"], { io: b.io, loaders, skipConfigWarning: true })).toBe(
      0,
    );
    expect(b.out.text).toBe("ran\n");
    expect(loads).toBe(1);
    const c = memoryIO();
    expect(await execute(["help", "task"], { io: c.io, loaders, skipConfigWarning: true })).toBe(0);
    expect(c.out.text).toContain("Manage tasks");
    expect(loads).toBe(2);
  });
  test("an unported command fails honestly, never pretends", async () => {
    // Every 0.34.1 command is ported now, so the placeholder is exercised with a registry that
    // leaves one manifest command out.
    const { commandLoaders } = await import("../../src/cli/commands/index.ts");
    const { memoryIO } = await import("../../src/cli/core/io.ts");
    const { execute } = await import("../../src/cli/core/root.ts");
    const { provider: _omitted, ...loaders } = commandLoaders;
    const { io, out, err } = memoryIO();
    const code = await execute(["provider", "list"], {
      io,
      loaders,
      env: { HOME: sandbox, NO_UPDATE_CHECK: "1", CI: "1" },
      cwd: sandbox,
      skipConfigWarning: true,
    });
    const r = { code, stdout: out.text, stderr: err.text };
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      'Error: "knowns provider" is not available in the TypeScript build yet (the command has not been ported)\n',
    );
  });
  test("exactArgs messages match cobra", () => {
    expect(exactArgs(1)({} as never, [])).toBe("accepts 1 arg(s), received 0");
  });
});

describe("global flags on a write command", () => {
  const write = defineCommand({
    use: "create <title>",
    short: "Create a thing",
    args: exactArgs(1),
    flags: [{ type: "string", name: "priority", usage: "Priority", default: "medium" }],
    run: (ctx) => ctx.print(`${renderSuccess(`Created ${ctx.args[0]}`)}\n`),
  });
  const run = (args: string[], env: Record<string, string> = {}) =>
    runTs(["create", ...args], { extra: [write], env });

  test("styled by default; --plain, --json and NO_COLOR strip ANSI; flags in any position", async () => {
    expect((await run(["x"])).stdout).toBe("\x1b[32m✓ Created x\x1b[m\n");
    expect((await run(["x", "--plain"])).stdout).toBe("✓ Created x\n");
    expect((await run(["--json", "x"])).stdout).toBe("✓ Created x\n");
    expect((await run(["--priority", "high", "--plain", "x"])).stdout).toBe("✓ Created x\n");
    expect((await run(["x"], { NO_COLOR: "1" })).stdout).toBe("✓ Created x\n");
  });
  test("a --plain run does not leak into the next run", async () => {
    await run(["x", "--plain"]);
    expect((await run(["y"])).stdout).toBe("\x1b[32m✓ Created y\x1b[m\n");
  });
  test("--no-pager, --page and --page-size are accepted and inert without paging output", async () => {
    const r = await run(["x", "--no-pager", "--page", "1", "--page-size", "5", "--plain"]);
    expect(r).toEqual({ code: 0, stdout: "✓ Created x\n", stderr: "" });
  });
});
