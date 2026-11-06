// The write scenario the rollback test applies to a project. Either binary can run it, so the same
// writes made by the released Go 0.34.1 serve as the oracle for what `validate` may report.
// Every id it creates is returned by role (t1, m1, ...), so outputs can be compared across sides.
import { McpClient, must, run, type Side } from "./binaries.ts";

export type Ids = Record<string, string>;

export interface Ctx {
  side: Side;
  cwd: string;
  env: Record<string, string>;
}

const first = (text: string, re: RegExp, what: string): string => {
  const m = re.exec(text);
  if (!m?.[1]) throw new Error(`could not read ${what} from:\n${text}`);
  return m[1];
};

function cli(c: Ctx, args: string[]): string {
  return must(c.side, args, c.cwd, c.env);
}

function createTask(c: Ctx, args: string[]): string {
  return first(cli(c, ["task", "create", ...args]), /Created task (\S+?):/, "task id");
}

function createMemory(c: Ctx, args: string[]): string {
  return first(cli(c, ["memory", "create", ...args]), /Created memory: (\S+)/, "memory id");
}

function createDecision(c: Ctx, args: string[]): string {
  return createDecisionOrCandidate(c, args).id;
}

/** decision create, which answers with a review candidate when a similar decision exists. */
function createDecisionOrCandidate(c: Ctx, args: string[]): { id: string; review: boolean } {
  const out = cli(c, ["decision", "create", ...args, "--json"]);
  const j = JSON.parse(out) as { id?: string; status?: string; candidate?: { id?: string } };
  if (j.status === "review_required" && j.candidate?.id)
    return { id: j.candidate.id, review: true };
  if (!j.id) throw new Error(`${c.side.name} decision create returned no id:\n${out}`);
  return { id: j.id, review: false };
}

/** Writes through the CLI. Returns the created ids by role. */
export function cliScenario(c: Ctx): Ids {
  const ids: Ids = {};
  // Config first, so the index step below has a (mock) embedder.
  cli(c, ["config", "set", "settings.semanticSearch.enabled", "true"]);
  cli(c, ["config", "set", "settings.semanticSearch.model", "all-minilm"]);
  cli(c, ["config", "set", "defaultAssignee", "@rollback"]);

  // Tasks: create, every edit flag, a child, archive/unarchive.
  ids.t1 = createTask(c, [
    "Rollback task one",
    "-d",
    "Written by the build under test.\n\nSee @doc/rollback/rb-doc.",
    "--ac",
    "first criterion",
    "--ac",
    "second criterion",
    "--priority",
    "high",
    "-l",
    "rollback,d10",
  ]);
  const t1 = ids.t1;
  cli(c, ["task", "edit", t1, "--plan", "1. Write\n2. Read back with 0.34"]);
  cli(c, ["task", "edit", t1, "-s", "in-progress", "-a", "@rollback"]);
  cli(c, ["task", "edit", t1, "--ac", "third criterion"]);
  cli(c, ["task", "edit", t1, "--check-ac", "1", "--check-ac", "3"]);
  cli(c, ["task", "edit", t1, "--uncheck-ac", "3"]);
  cli(c, ["task", "edit", t1, "--remove-ac", "3"]);
  cli(c, ["task", "edit", t1, "--notes", "## Summary\nFirst notes."]);
  cli(c, ["task", "edit", t1, "--append-notes", "Second line of notes"]);
  cli(c, [
    "task",
    "edit",
    t1,
    "-t",
    "Rollback task one (edited)",
    "--labels",
    "rollback,d10,edited",
  ]);
  ids.t2 = createTask(c, ["Rollback child task", "--parent", t1, "-d", "child"]);
  cli(c, ["task", "edit", ids.t2, "-s", "done"]); // only done tasks can be archived
  cli(c, ["task", "archive", ids.t2, "--yes"]);
  cli(c, ["task", "unarchive", ids.t2]);

  // Time: a real start/stop (over one second, so timeSpent changes) and a manual entry.
  cli(c, ["time", "start", t1]);
  Bun.sleepSync(1_100);
  cli(c, ["time", "stop", t1]);
  cli(c, ["time", "add", t1, "1h30m", "-n", "manual entry", "-d", "2026-10-01"]);

  // Docs: create, replace, section edit, append, metadata, move, delete + restore.
  cli(c, ["doc", "create", "RB Doc", "-d", "rollback doc", "-t", "rollback,d10", "-f", "rollback"]);
  cli(c, [
    "doc",
    "edit",
    "rollback/rb-doc",
    "-c",
    `# RB Doc\n\nLinks @task-${t1}.\n\n## Section A\n\nalpha\n\n## Section B\n\nbeta\n`,
  ]);
  cli(c, ["doc", "edit", "rollback/rb-doc", "--section", "Section A", "-c", "alpha, rewritten"]);
  cli(c, ["doc", "edit", "rollback/rb-doc", "-a", "\nAppended paragraph."]);
  cli(c, [
    "doc",
    "edit",
    "rollback/rb-doc",
    "-t",
    "RB Doc (edited)",
    "--tags",
    "rollback,d10,moved",
  ]);
  cli(c, ["doc", "edit", "rollback/rb-doc", "--path", "rollback/rb-doc-moved"]);
  cli(c, ["doc", "create", "RB Gone", "-d", "deleted then restored", "-f", "rollback"]);
  cli(c, ["doc", "edit", "rollback/rb-gone", "-c", "# RB Gone\n\nBody that must survive.\n"]);
  cli(c, ["doc", "delete", "rollback/rb-gone", "--force"]);
  cli(c, ["reconcile", "restore", "doc", "rollback/rb-gone", "--execute"]);

  // Template.
  cli(c, ["template", "create", "rb-tpl", "-d", "rollback template"]);

  // Memory: create, edit, a second one promoted to global, a third deleted, cleanup.
  ids.m1 = createMemory(c, [
    "Rollback memory",
    "-c",
    "Memory written by the build under test.",
    "--category",
    "pattern",
    "-t",
    "rollback",
  ]);
  cli(c, ["memory", "edit", ids.m1, "-a", "\nAppended by edit.", "-t", "Rollback memory (edited)"]);
  ids.m2 = createMemory(c, [
    "Rollback global memory",
    "-c",
    "Promoted.",
    "--category",
    "convention",
  ]);
  cli(c, ["memory", "promote", ids.m2]);
  ids.m3 = createMemory(c, ["Rollback doomed memory", "-c", "Deleted.", "--category", "failure"]);
  cli(c, ["memory", "delete", ids.m3, "--force"]);
  cli(c, ["memory", "cleanup"]);

  // Decisions: create with evidence, link, accept, a successor that supersedes it.
  ids.d1 = createDecision(c, [
    "Rollback decision one",
    "--context",
    "Context for the rollback test.",
    "--decision",
    "Keep 0.34 able to read every file.",
    "--consequences",
    "Verified by the rollback test.",
    "--source",
    "@doc/rollback/rb-doc-moved",
    "--task",
    ids.t2, // accept requires every linked task to be done; t2 is

    "-t",
    "rollback",
  ]);
  cli(c, ["decision", "link", ids.d1, "--doc", "rollback/rb-gone"]);
  cli(c, ["decision", "accept", ids.d1]);
  const d2 = createDecisionOrCandidate(c, [
    "Rollback decision two",
    "--context",
    "Successor.",
    "--decision",
    "Replaces decision one.",
    "--consequences",
    "None.",
    "--source",
    "@doc/rollback/rb-doc-moved",
    "--task",
    ids.t2,
  ]);
  ids.d2 = d2.id;
  // A successor this close to d1 goes through the review inbox: resolve it as replacing d1.
  if (d2.review) {
    cli(c, ["decision", "resolve", "supersede_existing", d2.id, "--target", ids.d1]);
  } else {
    cli(c, ["decision", "accept", d2.id, "--supersede", ids.d1]);
  }

  // Semantic index with the deterministic mock embedder (KNOWNS_EMBED_MOCK=1 in env).
  const idx = run(c.side, ["search", "--reindex"], c.cwd, c.env);
  if (idx.code !== 0)
    throw new Error(`${c.side.name} search --reindex: ${idx.stdout}${idx.stderr}`);
  return ids;
}

const idIn = (text: string, what: string): string =>
  first(text, /"(?:id|taskId)"\s*:\s*"([^"]+)"/, `${what} id`);

/** Writes through MCP (the same tools both binaries serve). Returns the created ids by role. */
export async function mcpScenario(c: Ctx, ids: Ids): Promise<Ids> {
  const out: Ids = {};
  const mcp = new McpClient(c.side, c.cwd, c.env);
  try {
    await mcp.initialize();
    out.mt = idIn(
      await mcp.call("tasks", {
        action: "create",
        title: "MCP rollback task",
        description: "Written over MCP.",
        addAc: ["mcp criterion"],
        labels: ["rollback", "mcp"],
        priority: "low",
      }),
      "mcp task",
    );
    await mcp.call("tasks", {
      action: "update",
      taskId: out.mt,
      appendNotes: "MCP progress note",
      checkAc: [1],
      status: "in-progress",
      plan: "1. MCP plan",
    });
    await mcp.call("time", {
      action: "add",
      taskId: out.mt,
      duration: "45m",
      note: "mcp time",
      date: "2026-10-02",
    });
    await mcp.call("docs", {
      action: "create",
      title: "MCP RB Doc",
      description: "Written over MCP",
      folder: "rollback",
      tags: ["rollback", "mcp"],
      content: "# MCP RB Doc\n\n## Part\n\nmcp body\n",
    });
    await mcp.call("docs", {
      action: "update",
      path: "rollback/mcp-rb-doc",
      appendContent: "\nMCP appended.",
    });
    // MCP delete is denied by the default read-write-no-delete policy (the CLI part covers delete
    // and restore), so restore an earlier revision instead: a new version written over MCP.
    await mcp.call("docs", { action: "restore", path: "rollback/mcp-rb-doc", revision: "1" });
    out.mm = idIn(
      await mcp.call("memory", {
        action: "add",
        title: "MCP rollback memory",
        content: "Written over MCP.",
        category: "convention",
        tags: ["rollback", "mcp"],
      }),
      "mcp memory",
    );
    await mcp.call("memory", {
      action: "update",
      id: out.mm,
      content: "Written over MCP, updated.",
    });
    await mcp.call("memory", { action: "confirm", id: out.mm });
    out.mc = idIn(
      await mcp.call("memory", {
        action: "add",
        title: "MCP contradicted memory",
        content: "Will be contradicted.",
        category: "pattern",
      }),
      "mcp contradicted memory",
    );
    await mcp.call("memory", {
      action: "contradict",
      id: out.mc,
      note: "Contradicted by the rollback test.",
    });
    out.mr = idIn(
      await mcp.call("memory", {
        action: "resolve",
        resolution: "create_proposed",
        title: "MCP resolved memory",
        content: "Created through resolve.",
        category: "pattern",
        layer: "project",
      }),
      "mcp resolved memory",
    );
    out.md = idIn(
      await mcp.call("decision", {
        action: "create",
        title: "MCP rollback decision",
        context: "MCP context.",
        decision: "MCP decision.",
        consequences: "MCP consequences.",
        sources: [`@task-${ids.t1}`],
      }),
      "mcp decision",
    );
  } finally {
    await mcp.close();
  }
  return out;
}

/** Writes made by the OTHER binary on top, for the reverse direction of the round trip. */
export function overwriteScenario(c: Ctx, ids: Ids): Ids {
  const out: Ids = {};
  cli(c, ["task", "edit", ids.t1 as string, "--append-notes", `Note from ${c.side.name}`]);
  cli(c, ["task", "edit", ids.mt as string, "-s", "done"]);
  cli(c, [
    "time",
    "add",
    ids.t1 as string,
    "15m",
    "-n",
    `${c.side.name} entry`,
    "-d",
    "2026-10-03",
  ]);
  cli(c, ["doc", "edit", "rollback/rb-doc-moved", "-a", `\nAppended by ${c.side.name}.`]);
  cli(c, ["memory", "edit", ids.m1 as string, "-a", `\nEdited by ${c.side.name}.`]);
  out.t3 = createTask(c, [
    `Task created by ${c.side.name}`,
    "-d",
    "reverse direction",
    "--ac",
    "x",
  ]);
  out.d3 = createDecision(c, [
    `Decision created by ${c.side.name}`,
    "--context",
    "c",
    "--decision",
    "d",
    "--consequences",
    "q",
  ]);
  return out;
}
