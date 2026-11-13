// Beyond Go (review of TSR-A3N6KY): Go's permission registry misses the decision tool and several
// mutating actions (tasks/docs restore, memory cleanup/confirm/contradict/resolve) and falls back
// to read for them, so a read-only session could write. The TS registry lists every action each
// handler implements, and an unlisted action of a known tool counts as a write.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ACTION_REGISTRY, CapRead, classifyAction } from "../../src/mcp/permissions.ts";
import { McpSession, makeSandbox } from "./harness.ts";

const HANDLERS = join(import.meta.dir, "..", "..", "src", "mcp", "handlers");
// Handler file -> MCP tool name, for the handlers that dispatch on `action`.
const TOOL_OF: Record<string, string> = {
  code: "code",
  decision: "decision",
  doc: "docs",
  memory: "memory",
  project: "project",
  search: "search",
  task: "tasks",
  template: "templates",
  time: "time",
};

test("every action a handler implements is classified explicitly", () => {
  const missing: string[] = [];
  for (const file of readdirSync(HANDLERS).filter((f) => f.endsWith(".ts"))) {
    const tool = TOOL_OF[basename(file, ".ts")];
    if (!tool) continue;
    const src = readFileSync(join(HANDLERS, file), "utf8");
    for (const m of src.matchAll(/case "([a-z_]+)"/g)) {
      const key = `${tool}.${m[1]}`;
      if (!(key in ACTION_REGISTRY)) missing.push(key);
    }
  }
  expect(missing).toEqual([]);
});

test("an unlisted action of a known tool is never a read", () => {
  for (const tool of ["tasks", "docs", "time", "templates", "memory", "decision", "code"]) {
    expect(classifyAction(tool, "some_future_action").capability).not.toBe(CapRead);
  }
});

describe("a read-only session cannot write through the actions Go missed", () => {
  const box = makeSandbox("full");
  const cfgPath = join(box.dir, ".knowns", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.settings.permissions = { preset: "read-only" };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const session = new McpSession("ts", {
    cwd: box.dir,
    home: box.home,
    env: { KNOWNS_RUNTIME_INLINE: "1", NO_UPDATE_CHECK: "1", CI: "1" },
  });
  afterAll(async () => {
    await session.close();
  });

  test("decision create is denied and writes nothing", async () => {
    await session.initialize();
    const decisions = join(box.dir, ".knowns", "decisions");
    const before = existsSync(decisions) ? readdirSync(decisions).length : 0;
    const out = await session.tool("decision", {
      action: "create",
      title: "Read only bypass",
      decision: "should not be written",
    });
    expect(out.isError).toBe(true);
    expect(out.text.toLowerCase()).toContain("permission");
    const after = existsSync(decisions) ? readdirSync(decisions).length : 0;
    expect(after).toBe(before);
  }, 60_000);

  test("reads still work", async () => {
    const out = await session.tool("decision", { action: "list" });
    expect(out.isError).toBe(false);
  }, 60_000);
});
