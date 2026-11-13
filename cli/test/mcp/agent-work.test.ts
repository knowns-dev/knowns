// KN-4FQN0P (spec D15): which MCP agent is working on a task. An ephemeral claim in .knowns/agent-work.json,
// a derived Task.workedBy, actor "mcp:<client>" in history, never anything in the task file.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { agentSlug, mcpActor } from "../../src/mcp/agent-client.ts";
import { auditEventFor } from "../../src/mcp/audit.ts";
import { handle as taskHandle } from "../../src/mcp/handlers/task.ts";
import { handle as timeHandle } from "../../src/mcp/handlers/time.ts";
import { McpLogger } from "../../src/mcp/log.ts";
import { McpState } from "../../src/mcp/state.ts";
import { CLAIM_TTL_MS, deriveWorkedBy } from "../../src/storage/stores/agent-work-store.ts";
import { copyFixture, storeAt } from "../stores/helpers.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

interface TaskJson {
  id: string;
  assignee?: string;
  workedBy?: { client: string; version?: string; since: string; active: boolean };
}

async function session(client: { name: string; version?: string } | undefined) {
  const { project, root } = copyFixture("full");
  roots.push(root);
  const state = new McpState(new McpLogger(process.pid, () => {}));
  await state.setProject(storeAt(project), project);
  state.clientInfo = client;
  const call = async (tool: typeof taskHandle, args: Record<string, unknown>) => {
    const res = await tool(state, {}, { name: "x", args, id: 1 });
    expect(res.isError).toBe(false);
    return JSON.parse(res.text) as TaskJson;
  };
  const created = await call(taskHandle, { action: "create", title: "Plain task", return: "full" });
  const id = created.id as string;
  return {
    state,
    project,
    id,
    tasks: (a: Record<string, unknown>) => call(taskHandle, a),
    time: (a: Record<string, unknown>) => call(timeHandle, a),
  };
}

describe("agentSlug / mcpActor", () => {
  test("known clients get a slug, everything else is not an agent", () => {
    expect(agentSlug({ name: "claude-code", version: "2.0" })).toBe("claude-code");
    expect(agentSlug({ name: "Claude Code" })).toBe("claude-code");
    expect(agentSlug({ name: "codex-mcp-client" })).toBe("codex");
    expect(agentSlug({ name: "cursor-vscode" })).toBe("cursor");
    expect(agentSlug({ name: "pi-mcp-adapter" })).toBe("pi");
    expect(agentSlug({ name: "e2e-test" })).toBeUndefined();
    expect(agentSlug({ name: "mcp-test" })).toBeUndefined();
    expect(agentSlug({ name: "example" })).toBeUndefined();
    expect(agentSlug(undefined)).toBeUndefined();
  });
  test("the actor stays plain mcp for clients that are not known agents", () => {
    expect(mcpActor({ name: "e2e-test" })).toBe("mcp");
    expect(mcpActor(undefined)).toBe("mcp");
    expect(mcpActor({ name: "claude-code" })).toBe("mcp:claude-code");
  });
});

describe("deriveWorkedBy", () => {
  const task = { id: "T-1", status: "in-progress", archived: false };
  const claim = {
    taskId: "T-1",
    client: "claude-code",
    since: new Date().toISOString(),
    pid: process.pid,
  };
  test("a live claim on an in-progress task shows, active only while the timer runs", () => {
    expect(deriveWorkedBy(task, claim, { active: [] })?.active).toBe(false);
    const running = { taskId: "T-1", startedAt: claim.since, pausedAt: null, totalPausedMs: 0 };
    expect(deriveWorkedBy(task, claim, { active: [running] })?.active).toBe(true);
    expect(
      deriveWorkedBy(task, claim, { active: [{ ...running, pausedAt: claim.since }] })?.active,
    ).toBe(false);
  });
  test("no claim, another status, or an archived task shows nothing", () => {
    expect(deriveWorkedBy(task, undefined, { active: [] })).toBeUndefined();
    expect(deriveWorkedBy({ ...task, status: "done" }, claim, { active: [] })).toBeUndefined();
    expect(deriveWorkedBy({ ...task, archived: true }, claim, { active: [] })).toBeUndefined();
  });
  test("a dead pid or an old claim without a timer is ignored; a running timer keeps it", () => {
    const dead = { ...claim, pid: 2147483646 };
    expect(deriveWorkedBy(task, dead, { active: [] })).toBeUndefined();
    const old = { ...claim, since: new Date(Date.now() - CLAIM_TTL_MS - 1000).toISOString() };
    expect(deriveWorkedBy(task, old, { active: [] })).toBeUndefined();
    const timer = { taskId: "T-1", startedAt: old.since, pausedAt: null, totalPausedMs: 0 };
    expect(deriveWorkedBy(task, old, { active: [timer] })?.active).toBe(true);
  });
});

describe("MCP tools record the agent", () => {
  test("a known agent moving a task to in-progress claims it without touching the assignee", async () => {
    const s = await session({ name: "claude-code", version: "2.1" });
    const updated = await s.tasks({
      action: "update",
      taskId: s.id,
      status: "in-progress",
      return: "full",
    });
    expect(updated.assignee).toBeUndefined();
    expect(updated.workedBy).toMatchObject({
      client: "claude-code",
      version: "2.1",
      active: false,
    });
    const got = await s.tasks({ action: "get", taskId: s.id });
    expect(got.workedBy?.client).toBe("claude-code");
    const list = (await s.tasks({ action: "list" })) as unknown as TaskJson[];
    expect(list.find((t) => t.id === s.id)?.workedBy?.client).toBe("claude-code");
  });

  test("the claim and the task file stay separate: nothing agent-related is in the task markdown", async () => {
    const s = await session({ name: "claude-code" });
    await s.tasks({ action: "update", taskId: s.id, status: "in-progress" });
    const dir = join(s.project, ".knowns", "tasks");
    const file = readdirSync(dir).find((f) => f.includes(s.id));
    expect(file).toBeDefined();
    expect(readFileSync(join(dir, file as string), "utf8")).not.toMatch(
      /claude|workedBy|agent-work/i,
    );
    const claims = JSON.parse(readFileSync(join(s.project, ".knowns", "agent-work.json"), "utf8"));
    expect(claims.claims[0]).toMatchObject({
      taskId: s.id,
      client: "claude-code",
      pid: process.pid,
    });
  });

  test("starting the timer shows the agent as active and stopping it ends the claim", async () => {
    const s = await session({ name: "codex" });
    await s.time({ action: "start", taskId: s.id });
    await s.tasks({ action: "update", taskId: s.id, status: "in-progress" });
    const running = await s.tasks({ action: "get", taskId: s.id });
    expect(running.workedBy).toMatchObject({ client: "codex", active: true });
    await s.time({ action: "stop", taskId: s.id });
    const stopped = await s.tasks({ action: "get", taskId: s.id });
    expect(stopped.workedBy).toBeUndefined();
    expect(existsSync(join(s.project, ".knowns", "agent-work.json"))).toBe(true);
  });

  test("moving to done, or to any other status, ends the claim", async () => {
    const s = await session({ name: "claude-code" });
    await s.tasks({ action: "update", taskId: s.id, status: "in-progress" });
    await s.tasks({ action: "update", taskId: s.id, status: "done" });
    expect((await s.tasks({ action: "get", taskId: s.id })).workedBy).toBeUndefined();
    await s.tasks({ action: "update", taskId: s.id, status: "in-progress" });
    expect((await s.tasks({ action: "get", taskId: s.id })).workedBy).toBeDefined();
    await s.tasks({ action: "update", taskId: s.id, status: "blocked" });
    expect((await s.tasks({ action: "get", taskId: s.id })).workedBy).toBeUndefined();
  });

  test("another client taking the task over replaces the claim; an unknown client ends it", async () => {
    const a = await session({ name: "claude-code" });
    await a.tasks({ action: "update", taskId: a.id, status: "in-progress" });
    a.state.clientInfo = { name: "cursor" };
    await a.tasks({ action: "update", taskId: a.id, status: "in-progress" });
    expect((await a.tasks({ action: "get", taskId: a.id })).workedBy?.client).toBe("cursor");
    a.state.clientInfo = { name: "e2e-test" };
    await a.tasks({ action: "update", taskId: a.id, status: "in-progress" });
    expect((await a.tasks({ action: "get", taskId: a.id })).workedBy).toBeUndefined();
  });

  test("a client that is not a known agent leaves no trace (Go e2e byte parity)", async () => {
    const s = await session({ name: "e2e-test", version: "1.0.0" });
    const updated = await s.tasks({
      action: "update",
      taskId: s.id,
      status: "in-progress",
      return: "full",
    });
    expect(updated.workedBy).toBeUndefined();
    expect(existsSync(join(s.project, ".knowns", "agent-work.json"))).toBe(false);
    const hist = await s.tasks({ action: "history", taskId: s.id });
    expect(JSON.stringify(hist)).not.toContain("mcp:");
  });

  test("history records the agent as the actor of its changes", async () => {
    const s = await session({ name: "claude-code" });
    await s.tasks({ action: "update", taskId: s.id, status: "in-progress" });
    const hist = JSON.stringify(await s.tasks({ action: "history", taskId: s.id }));
    expect(hist).toContain("mcp:claude-code");
  });
});

describe("audit event", () => {
  const pc = { startedAt: new Date(), toolName: "tasks", action: "update" };
  const req = { name: "tasks", args: { action: "update" }, id: 1 };
  test("carries the client only when one is given", () => {
    const withClient = auditEventFor(
      pc,
      req,
      { text: "{}", isError: false },
      "/p",
      new Date(),
      "claude-code",
    );
    expect(withClient.client).toBe("claude-code");
    const without = auditEventFor(pc, req, { text: "{}", isError: false }, "/p");
    expect(without.client).toBeUndefined();
  });
});
