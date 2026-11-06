// The in-memory help registry: every RegisterHelp / registerHelp entry in internal/mcp.
export interface HelpEntry {
  when: string;
  /** nil map marshals as null, an empty map as {}. */
  params?: Record<string, string>;
  why?: string;
  examples?: string[];
  flow?: string;
}

/** taskActionParams: the parameters each tasks action accepts (help text and validation). */
export const TASK_ACTION_PARAMS: Record<string, Record<string, string>> = {
  create: {
    title: "required - task title",
    description: "task context and goal",
    status: "todo | in-progress | in-review | done | blocked | on-hold | urgent",
    priority: "low | medium | high",
    assignee: "person responsible for task",
    labels: "task labels",
    parent: "parent task ID for subtasks",
    spec: "spec doc path this task implements",
    fulfills: "spec AC IDs this task satisfies",
    order: "display order",
    prefix: "custom 2-8 character task ID prefix; overrides the project default for this task only",
    addAc: "acceptance criteria to create the task with",
    plan: "implementation plan",
    notes: "implementation notes",
    return: "summary (default) | full legacy task payload",
  },
  get: { taskId: "required - task ID" },
  update: {
    taskId: "required - task ID",
    title: "new task title",
    description: "new task description",
    status: "new task status",
    priority: "low | medium | high",
    assignee: "new assignee",
    labels: "replacement label list",
    spec: "spec doc path",
    fulfills: "spec AC IDs this task satisfies",
    order: "display order",
    addAc: "new acceptance criteria",
    checkAc: "1-based AC indexes to mark complete",
    uncheckAc: "1-based AC indexes to mark incomplete",
    removeAc: "1-based AC indexes to remove",
    plan: "implementation plan",
    notes: "replace all implementation notes",
    appendNotes: "append to existing implementation notes",
    clear: "string fields to clear",
    expectedHash: "expected canonical hash for optimistic concurrency",
    return: "summary (default) | full legacy task payload",
  },
  delete: { taskId: "required - task ID", dryRun: "preview only without deleting; default true" },
  list: {
    status: "filter by task status",
    priority: "filter by low | medium | high",
    assignee: "filter by assignee",
    label: "filter by one label",
    spec: "filter by linked spec doc path",
    includeHistorical: "include archived Tasks in the result",
  },
  history: {
    taskId: "required - task ID",
    metadata: "payload-free paginated history metadata",
    limit: "history metadata page size",
    offset: "history metadata offset, newest first",
    revision: "explicit revision detail (vN or numeric)",
  },
  board: {},
  archive: {
    taskId: "required",
    execute: "false previews; true mutates",
    actor: "optional audit actor",
    expectedHash: "expected canonical hash",
  },
  unarchive: {
    taskId: "required",
    execute: "false previews; true mutates",
    actor: "optional audit actor",
    expectedHash: "expected canonical hash",
  },
  batch_archive: {
    ids: "optional; omitted evaluates all Tasks",
    execute: "false previews; true mutates",
    actor: "optional audit actor",
    expectedHashes: "per-Task expected canonical hashes",
  },
  batch_unarchive: {
    ids: "required Task IDs",
    execute: "false previews; true mutates",
    actor: "optional audit actor",
    expectedHashes: "per-Task expected canonical hashes",
  },
  hard_delete: {
    taskId: "required",
    confirmed: "must be true",
    reason: "required non-empty reason",
  },
  restore: { taskId: "required", execute: "false previews; true mutates" },
};

export function buildHelpRegistry(): Map<string, HelpEntry> {
  const r = new Map<string, HelpEntry>();
  const add = (key: string, entry: HelpEntry): void => {
    r.set(key, entry);
  };

  add("help.query", {
    when: "Use when you need detailed guidance for a tool action, a tool prefix, or a keyword.",
    params: {
      queries: "Array of exact keys (code.find), prefix wildcards (code.*), or keywords (insert).",
    },
    examples: ['{"queries":["code.find","code.*","insert"]}'],
  });

  // project
  add("project.detect", {
    when: "Find Knowns projects in common locations or additional directories before switching context.",
    params: { additionalPaths: "extra directory paths to scan" },
  });
  add("project.current", {
    when: "Show active project root, name, and store state.",
    params: {},
  });
  add("project.set", {
    when: "Switch active Knowns project for subsequent MCP operations.",
    params: { projectRoot: "required — absolute project root path" },
    flow: "Detect projects first when unsure of path, then set target project.",
  });
  add("project.status", {
    when: "Inspect active project readiness, knowledge counts, permissions, capabilities, and search/index health.",
    params: {},
    flow: "Use at session start or when diagnosing project/index readiness.",
  });

  // tasks
  const tp = TASK_ACTION_PARAMS;
  add("tasks.create", {
    when: "Create a new task or subtask with title, context, ownership, labels, and optional spec links. Successful calls return a compact summary by default.",
    params: tp.create,
    examples: [
      'tasks({ action: "create", title: "Add auth", description: "...", priority: "high", prefix: "FR" })',
    ],
    flow: "Create task, then update to in-progress and start time before implementation. Use return=full only when the complete created task is required.",
  });
  add("tasks.get", {
    when: "Read full task details before planning, implementation, review, or status updates.",
    params: tp.get,
    flow: "Use before update/history when you need current ACs, plan, notes, or spec links.",
  });
  add("tasks.update", {
    when: "Modify task metadata, status, acceptance criteria, plan, or implementation notes. Successful calls return a compact summary by default.",
    params: tp.update,
    why: "Use appendNotes for progress. notes replaces existing notes and can wipe history.",
    examples: [
      'tasks({ action: "update", taskId: "abc123", appendNotes: "Done: added tests" })',
      'tasks({ action: "update", taskId: "abc123", checkAc: [1, 2] })',
    ],
    flow: "Only check AC after work is complete; stop time and set status done at finish. Use return=full only when the complete updated task is required.",
  });
  add("tasks.delete", {
    when: "Preview or remove a task when it is obsolete or was created by mistake.",
    params: tp.delete,
    why: "Default dryRun protects against accidental deletion.",
  });
  add("tasks.list", {
    when: "Find tasks by status, owner, priority, label, or spec before choosing work or checking remaining scope.",
    params: tp.list,
  });
  add("tasks.history", {
    when: "Inspect chronological changes for audit, debugging, or understanding how a task evolved.",
    params: tp.history,
  });
  add("tasks.board", {
    when: "Show task board grouped by status for planning or handoff overview.",
    params: tp.board,
  });
  add("tasks.archive", {
    when: "Preview or archive one completed Task through the canonical lifecycle policy.",
    params: tp.archive,
  });
  add("tasks.unarchive", {
    when: "Preview or restore one done/archived Task.",
    params: tp.unarchive,
  });
  add("tasks.restore", {
    when: "Preview or reactivate one Task whose history head is a delete tombstone, such as after its file vanished briefly and came back.",
    params: tp.restore,
    flow: "Unlike unarchive, this undoes a recorded deletion. It refuses when the file on disk holds content the tombstone did not record.",
  });
  add("tasks.batch_archive", {
    when: "Preview or archive eligible Tasks with machine retry progress.",
    params: tp.batch_archive,
  });
  add("tasks.batch_unarchive", {
    when: "Preview or restore multiple Tasks.",
    params: tp.batch_unarchive,
  });
  add("tasks.hard_delete", {
    when: "Permanently delete a Task only under a trusted project delete permission.",
    params: tp.hard_delete,
    why: "Hard-delete is distinct from archive and leaves a content-free tombstone.",
  });

  // docs
  add("docs.create", {
    when: "Create a documentation page. Successful calls return a compact summary by default.",
    params: {
      title: "required — document title",
      description: "document description",
      content: "markdown content",
      tags: "document tags",
      folder: "folder path",
      return: "summary (default) | full legacy document payload",
    },
    flow: "Use the returned path for later reads or updates. Use return=full only when the complete created document is required.",
  });
  add("docs.update", {
    when: "Update document metadata or content, append content, replace a section, clear fields, or rename the path. Successful calls return a compact summary by default.",
    params: {
      path: "required — current document path",
      title: "new document title",
      description: "new document description",
      content: "replacement markdown content, or section content when section is set",
      appendContent: "markdown content to append",
      section: "heading title or section number to replace",
      newPath: "new document path",
      tags: "replacement tag list",
      clear: "string fields to clear",
      return: "summary (default) | full legacy document payload",
    },
    flow: "Use the returned path after a rename; previousPath is included only for renames. Use return=full only when the complete updated document is required.",
  });
  add("docs.restore", {
    when: "Restore an earlier revision of a document, or reactivate a document whose history records a deletion while its content is still recoverable.",
    params: {
      path: "required — document path",
      revision: "revision to restore; omit to reactivate a tombstoned document",
      mode: "document (default) or section, with a revision",
      section: "heading title or section number, with mode=section",
      expectedHash: "expected canonical hash, with a revision",
    },
    flow: "Reactivation refuses when the file on disk holds content the tombstone did not record, so it never adopts bytes the document did not own.",
  });
  add("docs.get", {
    when: "Read documentation without loading more content than needed.",
    params: {
      path: "Required doc path.",
      smart: "Optional boolean. Returns full content for small docs, otherwise stats/TOC.",
      toc: "Optional boolean. Return only table of contents.",
      section: "Optional heading title or section number to read one section.",
      info: "Optional boolean. Return stats without content.",
      line: "Optional line or range such as 42 or 10-20.",
    },
    why: "Use smart/toc/section to keep context small and avoid reading a full long doc.",
    examples: [
      '{"action":"get","path":"guides/cli-guide","smart":true}',
      '{"action":"get","path":"guides/cli-guide","toc":true}',
      '{"action":"get","path":"guides/cli-guide","section":"Installation"}',
    ],
  });
  add("workflow.doc-read", {
    when: "Use before reading large or unfamiliar docs.",
    params: {
      step1: "docs.get with smart=true.",
      step2: "If output is a TOC/stats or the doc is large, use toc=true.",
      step3: "Read only the relevant section with section=<number-or-heading>.",
      step4: "Use line=<range> only for narrow citations/debugging.",
    },
    flow: "Prefer section retrieval over full-doc reads. Search first, then smart get, then TOC/section.",
  });

  // time
  add("time.start", {
    when: "Start mandatory task time tracking when beginning task work.",
    params: { taskId: "required — task ID to track time for" },
    why: "Task workflow requires active time tracking for implementation work.",
    flow: "Set task in-progress, start timer, implement, then stop timer before marking done.",
  });
  add("time.stop", {
    when: "Stop active task timer after finishing or pausing tracked work.",
    params: {
      taskId: "required — task ID for active timer",
      expectedHash: "optional — expected canonical task hash; stale bases are rejected",
    },
    why: "Stopping timer records elapsed time on task; required before completion.",
    flow: "Stop timer before setting task status to done.",
  });
  add("time.add", {
    when: "Add manual time for past work or to repair forgotten timer usage.",
    params: {
      taskId: "required — task ID",
      duration: "required — duration like 2h, 30m, 1h30m",
      note: "optional entry note",
      date: "YYYY-MM-DD; defaults to today",
      expectedHash: "optional — expected canonical task hash; stale bases are rejected",
    },
    examples: ['time({ action: "add", taskId: "abc123", duration: "30m", note: "Forgot timer" })'],
  });
  add("time.report", {
    when: "Summarize tracked time over a date range for planning, review, or reporting.",
    params: {
      from: "start date YYYY-MM-DD",
      to: "end date YYYY-MM-DD",
      groupBy: "task | label | status",
    },
  });

  // search
  add("search.search", {
    when: "Discover relevant docs, tasks, memories, or decisions by query before reading detailed context.",
    params: {
      query: "required — search terms",
      type: "all | task | doc | memory | decision",
      mode: "hybrid | semantic | keyword",
      limit: "maximum result count",
      status: "filter tasks, memories, or decisions by status",
      priority: "filter tasks by priority",
      assignee: "filter tasks by assignee",
      label: "filter tasks by label",
      tag: "filter docs, memories, or decisions by tag",
      includeHistorical: "include historical entities, including archived Tasks",
    },
    why: "Use search for discovery. Use retrieve when you need assembled context with citations.",
    examples: ['search({ action: "search", query: "auth patterns", type: "doc", limit: 5 })'],
  });
  add("search.retrieve", {
    when: "Build an assembled context pack from relevant docs, tasks, memories, and decisions for planning or synthesis.",
    params: {
      query: "required — retrieval query",
      sourceTypes: "optional list: doc, task, memory, decision",
      mode: "hybrid | semantic | keyword",
      limit: "maximum item count",
      expandReferences: "include linked docs/tasks/memories/decisions",
      status: "filter tasks, memories, or decisions by status",
      priority: "filter tasks by priority",
      assignee: "filter tasks by assignee",
      label: "filter tasks by label",
      tag: "filter docs, memories, or decisions by tag",
      includeHistorical: "include historical entities; Task retrieval adds done and archived Tasks",
    },
    why: "Use retrieve after search when you need cited, expanded context rather than a ranked result list.",
  });
  add("search.resolve", {
    when: "Traverse semantic refs and graph relationships from a @doc, @task, or @template reference.",
    params: {
      ref: "required — semantic reference expression",
      direction: "outbound | inbound | both",
      depth: "max hops 1-3",
      relationTypes: "comma-separated relation kinds",
      entityTypes: "comma-separated entity kinds",
      limit: "maximum result count",
    },
    examples: ['search({ action: "resolve", ref: "@doc/specs/auth{implements}", depth: 2 })'],
  });

  // code
  add("code.find", {
    when: "Search symbols by name pattern using LSP documentSymbol.",
    params: {
      query: "Required symbol name or partial pattern.",
      path: "Optional file or directory path to limit search.",
      include_body: "Optional boolean; include source for matched symbols.",
      depth: "Optional number; include children to this depth.",
      limit: "Optional number; maximum results, default 20.",
    },
    why: "Use before reading code bodies or editing symbols.",
    examples: ['{"action":"find","query":"NewMCPServer","include_body":true}'],
  });
  add("code.insert", {
    when: "Insert source before or after a symbol anchor using LSP documentSymbol.",
    params: {
      path: "Required file path.",
      anchor: "Required symbol name; nested names use dots like Type.Method.",
      position: "Required insertion position: before or after.",
      body: "Required source code to insert.",
    },
    examples: [
      '{"action":"insert","path":"internal/mcp/server.go","anchor":"NewMCPServer","position":"after","body":"func helper() {}"}',
    ],
  });
  add("code.delete", {
    when: "Safely delete a symbol after checking LSP references.",
    params: {
      path: "Required file path.",
      symbol: "Required symbol name; nested names use dots like Type.Method.",
      force: "Optional boolean; skip reference checks.",
    },
    why: "Prevents deleting symbols still used elsewhere.",
    examples: ['{"action":"delete","path":"internal/mcp/server.go","symbol":"NewMCPServer"}'],
  });
  add("code.replace", {
    when: "Replace exact text in a target code file after code tools locate the edit site.",
    params: {
      path: "Required target file path.",
      needle: "Required exact text or regex pattern to replace.",
      repl: "Required replacement text.",
      mode: "Optional literal or regex. Defaults to literal.",
      allow_multiple_occurrences:
        "Optional boolean. Defaults to false to avoid broad accidental edits.",
    },
    why: "Use for small, precise code edits where a symbol-body replacement is too broad.",
    examples: ['{"action":"replace","path":"internal/mcp/server.go","needle":"old","repl":"new"}'],
  });
  add("code.replace_body", {
    when: "Replace an entire symbol body by name using LSP documentSymbol range.",
    params: {
      path: "Required file path.",
      symbol: "Required symbol name; nested names use dots like Type.Method.",
      body: "Required replacement source code.",
    },
    why: "Use for functions, methods, classes, or structs when the whole symbol implementation should change.",
    examples: [
      '{"action":"replace_body","path":"internal/mcp/server.go","symbol":"NewMCPServer","body":"func NewMCPServer(projectHint string) *MCPServer { ... }"}',
    ],
  });
  add("workflow.code-edit", {
    when: "Use before changing source code when the model has only partial MCP context.",
    params: {
      step1: "code.find or code.symbols to locate the target.",
      step2: "code.references/definition/diagnostics when impact or correctness matters.",
      step3:
        "code.rename, code.replace, code.replace_body, code.insert, or code.delete for the edit.",
      step4: "code.diagnostics plus tests/build as verification.",
    },
    flow: "Never start code changes with blind file edits. Discover with code tools, edit with code tools, then verify.",
    examples: [
      '{"queries":["code.find","code.replace","code.replace_body"]}',
      '{"action":"replace_body","path":"internal/mcp/handlers/initial.go","symbol":"writeWorkflow","body":"func writeWorkflow(...) { ... }"}',
    ],
  });
  add("workflow.plan-new", {
    when: "Create a direct task and plan it when work is too small for a spec.",
    flow: '/kn-plan --new "<work summary>" creates a task, classifies tiny/normal/high-risk, then continues normal planning.',
  });
  add("workflow.spec", {
    when: "Create a dated spec for normal or high-risk feature work.",
    flow: "Use /kn-spec for ambiguous or high-risk work. New specs use specs/<yyyy-mm-dd>/<slug>; generated tasks use compact [slug-NN] titles.",
  });
  add("workflow.verify", {
    when: "Verify task/doc/spec state before declaring work complete.",
    flow: 'Use validate(entity) for focused checks, validate(scope:"sdd") for spec coverage, and run tests/build for code changes.',
  });

  // templates
  add("templates.create", {
    when: "Create a reusable code generation template definition.",
    params: {
      name: "required — template name",
      description: "template summary",
      doc: "linked documentation path",
    },
  });
  add("templates.get", {
    when: "Read a template definition before running or modifying generation behavior.",
    params: { name: "required — template name" },
  });
  add("templates.list", {
    when: "List available templates before choosing generation boilerplate.",
    params: {},
  });
  add("templates.run", {
    when: "Render a template with variables and optionally write generated files.",
    params: {
      name: "required — template name",
      variables: "template variables object",
      dryRun: "preview only without writing files; default true",
    },
    why: "Use dryRun first to preview generated files before writing.",
    examples: [
      'templates({ action: "run", name: "go-feature", variables: {"name": "label"}, dryRun: true })',
    ],
  });

  // validate
  add("validate.validate", {
    when: "Validate tasks, docs, templates, refs, or SDD coverage before marking work complete.",
    params: {
      scope: "all | tasks | docs | templates | sdd",
      entity: "specific task ID or doc path",
      strict: "treat warnings as errors",
      fix: "auto-fix supported issues",
    },
    flow: "Run targeted validation after tests and before task completion.",
  });

  // decision
  add("decision", {
    when: "Use for first-class System Decision lifecycle operations and explicit reviewed Legacy Decision Memory migration.",
    params: {
      action:
        "Required: create, list, get, link, accept, supersede, review_inbox, resolve, migration_preview, migration_apply, migration_rollback.",
      title: "Required for create.",
      id: "Required for get/link; accepted as old decision ID for supersede if oldId is omitted.",
      candidateId:
        "Required for persisted candidate resolution; never use targetId as the candidate.",
      "oldId/newId": "Required pair for supersede.",
      resolution:
        "Decision review resolution: accept_new, supersede_existing, link_as_related, reject_new; create_draft remains a compatibility no-op for an existing draft.",
      "sources/docs":
        "Sources and related docs/tasks remain evidence links; every create defaults to draft.",
      accept:
        "Marks a draft verified and accepted only after readable sources and completed linked tasks pass validation; optional supersedes are committed atomically.",
      migration:
        "Preview is read-only. Apply requires memoryId plus migrationResolution. Rollback requires memoryId and refuses unsafe post-migration drift.",
    },
    flow: "Use migration_preview first, review one candidate, then migration_apply with an explicit resolution. Never create Memory category decision.",
  });

  return r;
}
