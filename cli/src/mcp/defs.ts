// Tool definitions (name, description, schema) for every Knowns MCP tool, copied from
// internal/mcp/handlers/*.go. Kept apart from the handlers so `tools/list` never loads the
// storage and domain libraries.
import { bool, newTool, num, numArr, obj, str, strArr, type Tool } from "./tool.ts";

export const MUTATION_ENUM = ["summary", "full"] as const;

export const initialTool = (): Tool =>
  newTool(
    "initial",
    `Provides the Knowns session-ready instructions for AI agents.

- initial: Return dynamic project state, required code-intelligence rules, workflow guidance, and tool summary. Required: none. Optional: none. Returns: plain-text instructions to read before performing project work.
`,
    [],
  );

export const helpTool = (): Tool =>
  newTool(
    "help",
    "Retrieves on-demand help for tool actions. Query exact keys like code.find, wildcard prefixes like code.*, or keywords like insert.",
    [
      {
        name: "queries",
        type: "array",
        required: true,
        description: "Help queries: exact tool.action, prefix wildcard tool.*, or keyword search",
        items: "string",
      },
    ],
  );

export const projectTool = (): Tool =>
  newTool(
    "project",
    `Project management operations. Use 'action' to specify: detect, current, set, status.

- detect: Find Knowns projects in common or supplied directories. Required: none. Optional: additionalPaths. Returns: discovered project roots with names and status metadata.
- current: Show the currently active project. Required: none. Optional: none. Returns: active project name, root path, and store status.
- set: Switch the active project. Required: projectRoot. Optional: none. Returns: selected project metadata and readiness status.
- status: Inspect active project readiness. Required: none. Optional: none. Returns: project metadata, knowledge counts, search/model/index readiness, permissions, and capabilities.
`,
    [
      str("action", "Action to perform", {
        required: true,
        enum: ["detect", "current", "set", "status"],
      }),
      str("projectRoot", "Absolute path to the project root directory (required for set)"),
      strArr("additionalPaths", "Additional directory paths to scan for projects (detect)"),
    ],
  );

export const tasksTool = (): Tool =>
  newTool(
    "tasks",
    `Task management operations. Use 'action' to specify: create, get, update, delete, list, history, board, archive, unarchive, batch_archive, batch_unarchive, hard_delete, restore.

- create: Create a task or subtask. Required: title. Optional: description, status, priority, assignee, labels, parent, spec, fulfills, order, prefix, return. Returns: compact summary by default; use return=full for the legacy task payload.
- get: Read task details. Required: taskId. Optional: none. Returns: task metadata, acceptance criteria, plan, notes, spec links, and time spent.
- update: Modify task fields, ACs, plan, or notes. Required: taskId. Optional: title, description, status, priority, assignee, labels, spec, fulfills, order, addAc, checkAc, uncheckAc, removeAc, plan, notes, appendNotes, clear, return. Returns: compact summary by default; use return=full for the legacy task payload.
- delete: Remove a task or preview removal. Required: taskId. Optional: dryRun (default true). Returns: deletion preview or confirmation.
- list: List tasks with filters. Required: none. Optional: status, priority, assignee, unassigned, label, spec, includeHistorical. Returns: matching task summaries with IDs, titles, statuses, priorities, assignees, labels, and spec links.
- history: View task change history. Required: taskId. Optional: none. Returns: chronological change entries with timestamps and metadata.
- board: Show tasks grouped by status. Required: none. Optional: none. Returns: board columns containing task summaries by status.
- archive/unarchive: Preview by default; set execute=true to mutate. Required: taskId.
- batch_archive/batch_unarchive: Preview by default; set execute=true to mutate. Optional: ids for batch_archive; required for batch_unarchive.
- hard_delete: Permission-gated separately from archive. Required: taskId, confirmed=true, and non-empty reason.
- restore: Reactivate a Task whose history head is a delete tombstone, for example after its file vanished briefly and returned. Preview by default; set execute=true to mutate. Required: taskId. Refuses when the file on disk holds different content.
`,
    [
      str("action", "Action to perform", {
        required: true,
        enum: [
          "create",
          "get",
          "update",
          "delete",
          "list",
          "history",
          "board",
          "archive",
          "unarchive",
          "batch_archive",
          "batch_unarchive",
          "hard_delete",
          "restore",
        ],
      }),
      str("taskId", "Task ID (required for get, update, delete, history)"),
      bool("metadata", "Return payload-free paginated history metadata"),
      num("offset", "History metadata offset (newest first)"),
      num("limit", "History metadata page size"),
      str("revision", "Explicit history revision detail (vN or numeric)"),
      str("title", "Task title (required for create, optional for update)"),
      str("description", "Task description (create, update)"),
      str("status", "Task status (create, update, list)", {
        enum: ["todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"],
      }),
      str("priority", "Task priority (create, update, list)", {
        enum: ["low", "medium", "high"],
      }),
      str("assignee", "Task assignee (create, update, list)"),
      strArr("labels", "Task labels (create, update)"),
      str("parent", "Parent task ID for subtasks (create)"),
      str(
        "prefix",
        "Custom task ID prefix for create; overrides the project default without changing config",
      ),
      str("spec", "Spec document path (create, update, list)"),
      strArr("fulfills", "Spec ACs this task fulfills (create, update)"),
      num("order", "Display order (create, update)"),
      strArr("addAc", "Add new acceptance criteria (update)"),
      numArr("checkAc", "Check AC by index, 1-based (update)"),
      numArr("uncheckAc", "Uncheck AC by index, 1-based (update)"),
      numArr("removeAc", "Remove AC by index, 1-based (update)"),
      str("plan", "Implementation plan (update)"),
      str("notes", "Implementation notes, replaces existing (update)"),
      str("appendNotes", "Append to implementation notes (update)"),
      strArr("clear", "Clear string fields (update)"),
      str(
        "return",
        "Success response mode for create/update: summary (default) or full legacy entity",
        { enum: MUTATION_ENUM },
      ),
      str("label", "Filter by label (list)"),
      bool("unassigned", "Only Tasks with no assignee; cannot be combined with assignee (list)"),
      bool("includeHistorical", "Include archived Tasks in the result (list)"),
      bool("dryRun", "Preview only without deleting (default: true) (delete)"),
      strArr("ids", "Task IDs for batch lifecycle actions"),
      bool("execute", "Execute a lifecycle mutation; defaults to false preview"),
      bool("confirmed", "Explicit hard-delete confirmation"),
      str("reason", "Required hard-delete reason"),
      str("actor", "Optional lifecycle audit actor"),
      str("expectedHash", "Expected canonical hash for optimistic concurrency"),
      obj("expectedHashes", "Per-Task expected canonical hashes for batch lifecycle mutations"),
    ],
  );

export const docsTool = (): Tool =>
  newTool(
    "docs",
    "Documentation operations. Use 'action' to specify: create, get, update, delete, hard_delete, list, history, diff, restore. restore rolls back to a given revision; without a revision it reactivates a Doc whose history head is a delete tombstone. hard_delete is separately permission-gated and requires explicit confirmation and reason.",
    [
      str("action", "Action to perform", {
        required: true,
        enum: [
          "create",
          "get",
          "update",
          "delete",
          "hard_delete",
          "list",
          "history",
          "diff",
          "restore",
        ],
      }),
      str("path", "Document path (required for get, update, delete, history, diff, restore)"),
      str("title", "Document title (required for create, optional for update)"),
      str("description", "Document description (create, update)"),
      str("content", "Markdown content (create, update)"),
      strArr("tags", "Document tags (create, update)"),
      str("folder", "Folder path (create)"),
      bool("smart", "Smart mode: auto-return full content if small, else stats+TOC (get)"),
      bool("includeHistory", "Include structured revision history metadata with get responses"),
      bool("info", "Return document stats without content (get)"),
      bool("toc", "Return table of contents only (get)"),
      str("section", "Section by heading title or number (get, update)"),
      str("line", "Specific lines e.g. '42' or '10-20' (get)"),
      str("appendContent", "Append to existing content (update)"),
      str("newPath", "Rename document to new path (update)"),
      str(
        "revision",
        "Revision ID or number for diff/restore (defaults to latest for diff; omit on restore to reactivate a tombstoned Doc)",
      ),
      str("revisionId", "Alias for revision ID used by API clients"),
      bool("metadata", "Return payload-free paginated history metadata"),
      num("offset", "History metadata offset (newest first)"),
      num("limit", "History metadata page size"),
      str("mode", "Restore mode: document (default) or section"),
      str("expectedHash", "Expected canonical hash for optimistic concurrency"),
      bool("confirmed", "Explicit confirmation for hard_delete"),
      str("reason", "Required audit reason for hard_delete"),
      strArr("clear", "Clear string fields like title, description, or content (update)"),
      str(
        "return",
        "Success response mode for create/update: summary (default) or full legacy entity",
        { enum: MUTATION_ENUM },
      ),
      str("tag", "Filter by tag (list)"),
      bool("dryRun", "Preview only without deleting (default: true) (delete)"),
    ],
  );

export const timeTool = (): Tool =>
  newTool(
    "time",
    `Time tracking operations. Use 'action' to specify: start, stop, add, report.

- start: Start an active timer for a task. Required: taskId. Optional: none. Returns: timer start confirmation and task ID; errors if another timer is active.
- stop: Stop an active timer. Required: taskId. Optional: expectedHash. Returns: stopped timer entry with elapsed duration and task update confirmation.
- add: Add a manual time entry. Required: taskId, duration. Optional: note, date (YYYY-MM-DD; defaults to today), expectedHash. Returns: created time entry and updated task time total.
- report: Summarize time entries. Required: none. Optional: from, to, groupBy (task, label, status). Returns: time totals and grouped report rows for the requested date range.
`,
    [
      str("action", "Action to perform", {
        required: true,
        enum: ["start", "stop", "add", "report"],
      }),
      str("taskId", "Task ID to track time for (required for start, stop, add)"),
      str("duration", "Duration (e.g., '2h', '30m', '1h30m') (required for add)"),
      str("note", "Optional note for this entry (add)"),
      str("date", "Optional date (YYYY-MM-DD, defaults to now) (add)"),
      str("expectedHash", "Expected canonical task hash for optimistic concurrency (stop, add)"),
      str("from", "Start date (YYYY-MM-DD) (report)"),
      str("to", "End date (YYYY-MM-DD) (report)"),
      str("groupBy", "Group results by task, label, or status (report)", {
        enum: ["task", "label", "status"],
      }),
    ],
  );

export const searchTool = (): Tool =>
  newTool(
    "search",
    `Search and retrieval operations. Use 'action' to specify: search, retrieve, resolve.

- search: Search docs, tasks, memories, and decisions. Required: query. Optional: type (all, task, doc, memory, decision), mode (hybrid, semantic, keyword), limit, status, priority, assignee, label, tag, includeHistorical. Returns: ranked search results with entity type, path or ID, title, snippet, and score.
- retrieve: Build a context pack from relevant docs, tasks, memories, and decisions. Required: query. Optional: sourceTypes, mode, limit, expandReferences, status, priority, assignee, label, tag, includeHistorical. Returns: assembled context items with citations, metadata, and optional expanded references.
- resolve: Traverse semantic references and graph relationships. Required: ref. Optional: direction (outbound, inbound, both), depth (1-3), relationTypes, entityTypes, limit. Returns: resolved root entity and related entities/relations matching traversal filters.
`,
    [
      str("action", "Action to perform", {
        required: true,
        enum: ["search", "retrieve", "resolve"],
      }),
      str("query", "Search/retrieval query (required for search, retrieve)"),
      str("type", "Search type: all, task, doc, memory, or decision (search)", {
        enum: ["all", "task", "doc", "memory", "decision"],
      }),
      str(
        "mode",
        "Search mode: hybrid (semantic + keyword), semantic only, or keyword only (default: hybrid)",
        { enum: ["hybrid", "semantic", "keyword"] },
      ),
      num("limit", "Limit results (default: 20)"),
      str("status", "Filter tasks, memories, or decisions by status"),
      str("priority", "Filter tasks by priority"),
      str("assignee", "Filter tasks by assignee"),
      str("label", "Filter tasks by label"),
      str("tag", "Filter docs, memories, or decisions by tag"),
      bool(
        "includeHistorical",
        "Include historical entities with status metadata; Task retrieval adds done and archived Tasks",
      ),
      {
        name: "sourceTypes",
        type: "array",
        description: "Optional source types: doc, task, memory, decision (retrieve)",
        items: "string",
        itemsEnum: ["doc", "task", "memory", "decision"],
      },
      bool(
        "expandReferences",
        "Whether to include linked docs/tasks/memories as expanded context (retrieve)",
      ),
      str(
        "ref",
        "Semantic reference expression, e.g. @doc/guides/setup{implements} (required for resolve)",
      ),
      str(
        "direction",
        'Traversal direction from root entity: "outbound" (default), "inbound", or "both" (resolve)',
        { enum: ["outbound", "inbound", "both"] },
      ),
      num("depth", "Max traversal hops, 1–3 (default: 1) (resolve)"),
      str("relationTypes", "Filter by relation kinds, comma-separated (resolve)"),
      str("entityTypes", "Filter result entities by kind, comma-separated (resolve)"),
    ],
  );

export const templatesTool = (): Tool =>
  newTool(
    "templates",
    `Code generation template operations. Use 'action' to specify: create, get, list, run.

- create: Create a template definition. Required: name. Optional: description, doc. Returns: created template metadata.
- get: Read a template definition. Required: name. Optional: none. Returns: template metadata, prompts, actions, messages, and source path.
- list: List available templates. Required: none. Optional: none. Returns: template summaries with names, descriptions, versions, docs, and paths.
- run: Render and optionally write files from a template. Required: name. Optional: variables, dryRun (default true). Returns: generated file previews or write results with template messages.
`,
    [
      str("action", "Action to perform", {
        required: true,
        enum: ["create", "get", "list", "run"],
      }),
      str("name", "Template name (required for create, get, run)"),
      str("description", "Template description (create)"),
      str("doc", "Link to documentation (create)"),
      obj("variables", "Variables for the template (run)"),
      bool("dryRun", "Preview only without writing files (default: true) (run)"),
    ],
  );

export const validateTool = (): Tool =>
  newTool(
    "validate",
    `Validate tasks, docs, templates, and spec-driven development state for reference integrity and quality.

- validate: Run validation checks. Required: none. Optional: scope (all default, tasks, docs, templates, sdd), entity (specific task ID or doc path), strict (treat warnings as errors), fix (auto-fix supported issues). Returns: JSON with valid flag, strict flag, scope, issues, errorCount, warningCount, infoCount, and summary.
`,
    [
      str(
        "scope",
        "Validation scope: 'all' (default), 'tasks', 'docs', 'templates', or 'sdd' for spec-driven checks",
        { enum: ["all", "tasks", "docs", "templates", "sdd"] },
      ),
      str(
        "entity",
        "Validate a specific entity only. Use task ID directly (e.g., '6vbpda') or doc path (e.g., 'specs/user-auth'). Auto-detects type based on format.",
      ),
      bool("strict", "Treat warnings as errors (default: false)"),
      bool("fix", "Auto-fix supported issues like broken doc refs (default: false)"),
    ],
  );

export const memoryTool = (): Tool =>
  newTool(
    "memory",
    "Persistent memory operations. Use 'action' to specify: add, get, update, delete, list, promote, demote, cleanup, resolve, confirm, contradict.",
    [
      str("action", "Action to perform", {
        required: true,
        enum: [
          "add",
          "get",
          "update",
          "delete",
          "list",
          "promote",
          "demote",
          "cleanup",
          "resolve",
          "confirm",
          "contradict",
        ],
      }),
      str("id", "Memory entry ID (required for get, update, delete, promote, demote)"),
      str("content", "Memory content in markdown (required for add)"),
      str("title", "Memory title (add, update)"),
      str("layer", "Memory layer: 'project' (default) or 'global' (add, list)"),
      str(
        "category",
        "One of pattern, convention, preference, failure. The first three are claims about the code and must cite a checkable anchor; preference is a user commitment and must carry a **Why:** line. Anything else is rejected on write, and legacy decision-category writes go to the Decision tool instead (add, update, list)",
      ),
      strArr("tags", "Tags for the memory entry (add, update)"),
      str(
        "key",
        "Upsert handle, unique within a layer; defaults to a slug of the title. Adding with a key that already exists updates that entry in place and reports replaced=true, keeping its id so @memory/<id> refs still resolve (add, update)",
      ),
      strArr(
        "sources",
        "Where this came from. For pattern/convention/failure cite something checkable: a symbol, a file, @doc/<path> or @task-<id>. For preference cite the utterance: who said it and when (add, update, resolve)",
      ),
      str(
        "status",
        "Lifecycle status. On add it defaults to active, so a write nothing conflicts with is retrieved immediately; a write matching an existing memory still returns review_required instead. Also a filter (list) and the selected replacement status (resolve)",
        {
          enum: ["proposed", "active", "stale", "deprecated", "archived", "rejected", "merged"],
        },
      ),
      str("confidence", "Memory confidence metadata (add, update, resolve)", {
        enum: ["low", "medium", "high"],
      }),
      str(
        "lastVerified",
        "RFC3339 timestamp of the last check (update). Supplying sources or confidence stamps this automatically, since providing evidence is itself a verification",
      ),
      num("ttlDays", "Memory TTL in days (add, update, resolve)"),
      str("resolution", "Review resolution (resolve)", {
        enum: [
          "update_existing",
          "archive_existing_create_new",
          "create_proposed",
          "reject_new",
          "merge_existing",
        ],
      }),
      str("targetId", "Existing memory ID selected for duplicate resolution"),
      str(
        "note",
        "Why this memory is wrong (contradict). Say what you observed, not just that it failed",
      ),
      str("rejectedReason", "Reason recorded for reject_new resolution"),
      bool("includeAll", "Include non-active memories in list results (default: false)"),
      str("tag", "Filter by tag (list)"),
      bool("dryRun", "Preview only without deleting (default: true) (delete)"),
      strArr("clear", "Explicitly clear string fields like title, content, or category (update)"),
      num("olderThanDays", "Minimum stale age in days for cleanup candidates (default: 7)"),
      num("limit", "Maximum cleanup candidates to return (default: 20)"),
    ],
  );

export const decisionTool = (): Tool =>
  newTool(
    "decision",
    "System Decision lifecycle and reviewed Legacy Decision Memory migration operations.",
    [
      str("action", "Action to perform", {
        required: true,
        enum: [
          "create",
          "list",
          "get",
          "link",
          "accept",
          "supersede",
          "review_inbox",
          "resolve",
          "migration_preview",
          "migration_apply",
          "migration_rollback",
        ],
      }),
      str(
        "id",
        "Decision ID (required for get/link/accept, old decision for supersede when oldId is omitted)",
      ),
      str("candidateId", "Persisted draft Decision candidate ID (resolve)"),
      str("oldId", "Older decision ID to mark superseded (supersede)"),
      str("newId", "Replacement decision ID (supersede)"),
      str("targetId", "Existing decision ID selected for review resolution"),
      str("replacementId", "Existing replacement decision ID for supersede_existing resolution"),
      str("title", "Decision title (create)"),
      str("status", "Decision status filter (list) or explicit create status", {
        enum: ["draft", "accepted", "superseded", "rejected", "archived"],
      }),
      str("body", "Full markdown body (create)"),
      str("context", "Context section body (create)"),
      str("decision", "Decision section body (create)"),
      str("alternatives", "Alternatives Considered section body (create)"),
      str("consequences", "Consequences section body (create)"),
      strArr("tags", "Decision tags (create)"),
      strArr("sources", "Source refs (create/link)"),
      strArr("relatedDocs", "Related doc paths (create/link)"),
      strArr("relatedTasks", "Related task IDs (create/link)"),
      strArr(
        "supersedes",
        "Current Decision IDs to supersede atomically when accepting a verified draft",
      ),
      str("resolution", "Review resolution (resolve)", {
        enum: ["accept_new", "supersede_existing", "create_draft", "link_as_related", "reject_new"],
      }),
      str("tag", "Filter by tag (list)"),
      bool("includeAll", "Include non-current decisions in list results (default: false)"),
      str("memoryId", "Legacy Decision Memory ID (migration_apply/migration_rollback)"),
      str(
        "migrationResolution",
        "Explicit reviewed Legacy Decision Memory resolution (migration_apply)",
        {
          enum: [
            "create_decision",
            "link_existing",
            "consolidate_duplicate",
            "reclassify",
            "archive_noise",
            "reject_noise",
            "leave_unchanged",
          ],
        },
      ),
      str("decisionId", "Existing or explicit System Decision ID (migration_apply)"),
      str("targetMemoryId", "Previously migrated target Memory ID for duplicate consolidation"),
      str("category", "Non-decision Memory category for reclassification"),
      str("reason", "Reviewed archive/reject rationale"),
      bool(
        "acceptVerified",
        "Accept a migrated draft only when linked evidence passes verification",
      ),
    ],
  );

export const codeTool = (): Tool =>
  newTool(
    "code",
    "Code intelligence operations. Use 'action' to specify: symbols, find, definition, references, implementations, diagnostics, rename, replace, replace_body, insert, delete. Symbols and find return compact JSON by default; set verbose=true for raw/full LSP-style output.",
    [
      str("action", "Action to perform", {
        required: true,
        enum: [
          "symbols",
          "find",
          "definition",
          "references",
          "implementations",
          "diagnostics",
          "rename",
          "replace",
          "replace_body",
          "insert",
          "delete",
        ],
      }),
      str(
        "query",
        "Search or symbol query (required for search, definition, references, implementations)",
      ),
      str("mode", "Mode: find uses hybrid/semantic/keyword; replace uses literal/regex", {
        enum: ["hybrid", "semantic", "keyword", "literal", "regex"],
      }),
      num("limit", "Limit results (default: 10 for search, 100 for symbols, 200 for deps)"),
      num("neighbors", "Max neighbors per match (default: 5) (search)"),
      str("edgeTypes", "Optional comma-separated edge types to expand (search)"),
      str("path", "File path filter or target file path (required for LSP actions)"),
      str("kind", "Optional symbol kind filter (symbols)"),
      str(
        "type",
        "Optional edge type filter: calls, contains, has_method, imports, instantiates, implements, extends (deps)",
      ),
      str("severity", "Optional diagnostics severity filter: error, warning, info, hint", {
        enum: ["error", "warning", "info", "hint"],
      }),
      str(
        "verbose",
        "When true, return full LSP-style output instead of compact format. Supported by: symbols, find.",
      ),
      str(
        "symbol",
        "Symbol name for rename, replace_body, insert, or delete. Nested names may use dots like Type.Method.",
      ),
      str("needle", "Text or regex pattern to replace for action=replace."),
      str("repl", "Replacement text for action=replace."),
      bool(
        "allow_multiple_occurrences",
        "For action=replace, allow replacing multiple matches. Defaults to false.",
      ),
      str("body", "Replacement or inserted source for replace_body or insert."),
      str("position", "For action=insert, insertion position: before or after.", {
        enum: ["before", "after"],
      }),
      bool("confirmed", "Explicit confirmation for action=delete."),
      str("reason", "Non-empty deletion reason required with confirmed=true."),
      num(
        "line",
        "0-based line of the symbol to rename (rename). symbols and find report 1-based lines, so subtract 1.",
      ),
      num("character", "0-based character offset on that line (rename)."),
      str("newName", "New symbol name (rename)."),
      num("depth", "Nest child symbols to this depth (symbols)."),
      bool("include_body", "Include each symbol's source body (symbols, find)."),
      bool("force", "Delete without checking for external references (delete)."),
    ],
  );

/** Registration order is irrelevant on the wire (tools/list sorts), but tools differ in whether
 * RejectUnknownArguments wraps them: initial, help, memory and code register on the raw server. */
export const WRAPPED_TOOLS = new Set([
  "project",
  "tasks",
  "docs",
  "time",
  "search",
  "templates",
  "validate",
  "decision",
]);
