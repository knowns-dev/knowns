// Permissions guard and audit trail: the same calls under a read-only preset against Go and TS,
// then the audit file and the `knowns audit` command output compared.
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstDiff, GO_BIN, hasGoBin, maskPath, runDiff, type Step, TS_BIN } from "./harness.ts";

const steps: Step[] = [
  {
    tool: "tasks",
    args: { action: "list" },
    normalize: (t) =>
      JSON.stringify(
        JSON.parse(t).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)),
      ),
  },
  { tool: "tasks", args: { action: "create", title: "blocked" } },
  {
    tool: "tasks",
    args: { action: "update", taskId: "FX-19XJKQ", status: "done", description: "secret text" },
  },
  { tool: "tasks", args: { action: "archive", taskId: "FX-3VT2SR" } },
  { tool: "tasks", args: { action: "archive", taskId: "FX-3VT2SR", execute: true } },
  { tool: "tasks", args: { action: "delete", taskId: "FX-19XJKQ" } },
  { tool: "docs", args: { action: "create", title: "x" } },
  { tool: "docs", args: { action: "get", path: "specs/login" } },
  { tool: "memory", args: { action: "get", id: "kunv9q" } },
  { tool: "templates", args: { action: "run", name: "component" } },
  { tool: "templates", args: { action: "run", name: "component", dryRun: true } },
  { tool: "validate", args: { fix: true } },
  { tool: "code", args: { action: "replace", path: "a", needle: "a", repl: "b" } },
  { tool: "project", args: { action: "set", projectRoot: "/nonexistent" } },
  { tool: "project", args: { action: "current", extra: 1 } },
  { tool: "nope", args: {} },
  {
    tool: "search",
    args: {
      action: "search",
      query: "login",
      limit: 3,
      includeHistorical: false,
      tag: "a-very-long-value-".repeat(8),
    },
  },
];

const readAudit = (home: string): unknown[] =>
  readFileSync(join(home, ".knowns", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => {
      const e = JSON.parse(l);
      e.timestamp = "<TS>";
      e.durationMs = 0;
      return e;
    });

function runCli(bin: string[], args: string[], home: string): string {
  const r = Bun.spawnSync([...bin, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      NO_UPDATE_CHECK: "1",
      CI: "1",
    },
  });
  return r.stdout
    .toString()
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, "<TS>")
    .replace(/\d+ms/g, "Nms");
}

describe.skipIf(!hasGoBin)("permissions and audit match Go", () => {
  let session: Awaited<ReturnType<typeof runDiff>> | undefined;
  afterAll(async () => {
    await session?.close();
  });
  test("read-only preset", async () => {
    session = await runDiff("full", steps, {
      setup: (dir) => {
        const p = join(dir, ".knowns", "config.json");
        const cfg = JSON.parse(readFileSync(p, "utf8"));
        cfg.settings.permissions = { preset: "read-only" };
        writeFileSync(p, JSON.stringify(cfg, null, 2));
      },
    });
    const diffs = session.results.filter((r) => r.goMasked !== r.tsMasked);
    if (diffs.length > 0) {
      console.log(
        diffs.map((d) => `--- ${d.label}\n${firstDiff(d.goMasked, d.tsMasked)}`).join("\n\n"),
      );
    }
    expect(diffs.length).toBe(0);
    // Sessions must be closed before the audit file is complete.
    await session.close();
    const go = readAudit(session.go.home);
    const ts = readAudit(session.ts.home);
    const norm = (v: unknown[], dir: string) =>
      JSON.parse(maskPath(JSON.stringify(v), dir, "<DIR>"));
    expect(norm(ts, session.ts.dir)).toEqual(norm(go, session.go.dir));
    expect(go.length).toBeGreaterThan(10);
    const tsBin = TS_BIN
      ? [TS_BIN]
      : [process.execPath, join(import.meta.dir, "..", "..", "src", "main.ts")];
    for (const args of [
      ["audit", "recent", "--plain"],
      ["audit", "recent", "--json"],
      ["audit", "stats", "--json"],
    ]) {
      const g = maskPath(
        runCli([GO_BIN as string], args, session.go.home),
        session.go.dir,
        "<DIR>",
      );
      const t = maskPath(runCli(tsBin, args, session.ts.home), session.ts.dir, "<DIR>");
      if (args[1] === "stats") expect(JSON.parse(t)).toEqual(JSON.parse(g));
      else if (args[2] === "--plain") {
        expect(t.split("\n").sort().join("\n")).toBe(g.split("\n").sort().join("\n"));
      } else expect(JSON.parse(t).length).toBe(JSON.parse(g).length);
    }
  }, 300_000);
});
