// `knowns task`: port of internal/cli/task.go.
import {
  applyStatusTransition,
  historyMetadataPageToWire,
  taskToWire,
  taskVersionHistoryToWire,
  taskVersionToWire,
} from "../../domain/tasklifecycle/index.ts";
import type { AcceptanceCriterion, Task } from "../../models/task.ts";
import type { TaskVersionHistory } from "../../models/version.ts";
import { arbitraryArgs, exactArgs, minimumNArgs } from "../core/args.ts";
import { type CommandContext, defineCommand, type FlagSpec } from "../core/define.ts";
import { goQuote } from "../core/gofmt.ts";
import { splitCSV } from "../core/helpers.ts";
import {
  markdownDisplayWidth,
  newTerminalMarkdownBodyRenderer,
  terminalMarkdownStyle,
  terminalWidth,
} from "../core/markdown.ts";
import { DEFAULT_PLAIN_ITEM_LIMIT, getPageOpts, isTTY, plainPageRequested } from "../core/pager.ts";
import { renderSuccess, StyleDim } from "../core/plainoutput.ts";
import {
  cliLifecycleActor,
  newCLITaskLifecycleService,
  openStorage,
  runCLILifecycle,
} from "./task-lifecycle.ts";
import {
  renderPlainFullTaskHistory,
  renderPlainTaskHistory,
  renderTaskDetailed,
  renderTaskHistory,
  renderTaskTable,
  renderTaskTree,
  sortTasksForList,
  sprintTaskListPlain,
  sprintTaskPlain,
  sprintTaskTreePlain,
} from "./task-render.ts";
import { formatRFC3339 } from "./task-text.ts";

const wrapErr = (prefix: string, e: unknown): Error =>
  new Error(`${prefix}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });

/** Body markdown is rendered only on a terminal; otherwise the raw text passes through. */
function renderTaskForTerminal(task: Task): string {
  return isTTY()
    ? renderTaskDetailed(
        task,
        newTerminalMarkdownBodyRenderer(markdownDisplayWidth(), terminalMarkdownStyle()),
      )
    : renderTaskDetailed(task);
}

// --- task view -------------------------------------------------------------------------------

async function runTaskView(ctx: CommandContext, id: string): Promise<void> {
  const storage = await openStorage(ctx);
  let task: Task;
  try {
    task = storage.tasks.get(id);
  } catch {
    throw new Error(`task ${goQuote(id)} not found`);
  }
  // Load the active timer if any; unreadable timer state shows as no timer.
  try {
    const timer = storage.time.getActiveTimer(task.id);
    if (timer) task.activeTimer = timer;
  } catch {
    // GetActiveTimer hides state errors.
  }
  if (ctx.json) {
    ctx.printJSON(taskToWire(task));
    return;
  }
  if (ctx.plain) {
    ctx.printPaged(sprintTaskPlain(task));
    return;
  }
  ctx.print(renderTaskForTerminal(task));
}

// --- task create -----------------------------------------------------------------------------

async function runTaskCreate(ctx: CommandContext): Promise<void> {
  const title = ctx.args.join(" ");
  const storage = await openStorage(ctx);

  const description = ctx.flags.string("description");
  const acList = ctx.flags.strings("ac");
  let status = ctx.flags.string("status");
  let priority = ctx.flags.string("priority");
  let assignee = ctx.flags.string("assignee");
  const labels = ctx.flags.strings("label");
  const parent = ctx.flags.string("parent");
  const spec = ctx.flags.string("spec");
  const fulfills = ctx.flags.strings("fulfills");
  const plan = ctx.flags.string("plan");
  const notes = ctx.flags.string("notes");
  const prefix = ctx.flags.string("prefix");

  // Load config for defaults.
  let cfg: ReturnType<typeof storage.config.load> | undefined;
  try {
    cfg = storage.config.load();
  } catch {
    cfg = undefined;
  }

  if (status === "") status = "todo";
  if (priority === "") {
    priority = "medium";
    if (cfg?.settings.defaultPriority) priority = cfg.settings.defaultPriority;
  }
  if (assignee === "" && cfg) assignee = cfg.settings.defaultAssignee ?? "";

  const now = new Date();
  const nowText = now.toISOString();
  const task: Task = {
    id: "",
    title,
    status,
    priority,
    labels,
    createdAt: nowText,
    updatedAt: nowText,
    archived: false,
    acceptanceCriteria: null,
    timeSpent: 0,
  };
  if (description !== "") task.description = description;
  if (assignee !== "") task.assignee = assignee;
  if (parent !== "") task.parent = parent;
  if (spec !== "") task.spec = spec;
  if (fulfills.length > 0) task.fulfills = fulfills;
  if (plan !== "") task.implementationPlan = plan;
  if (notes !== "") task.implementationNotes = notes;
  if (status === "done") {
    task.status = "todo";
    applyStatusTransition(task, status, now);
  }
  const criteria: AcceptanceCriterion[] = acList.map((text) => ({ text, completed: false }));
  if (criteria.length > 0) task.acceptanceCriteria = criteria;

  try {
    const { createTaskWithHistory } = await import("../../storage/history/index.ts");
    await createTaskWithHistory(
      storage.ctx,
      task,
      { author: assignee, changes: storage.versions.trackChanges(null, task) },
      prefix,
    );
  } catch (e) {
    throw wrapErr("create task", e);
  }

  try {
    const { taskLifecycleSeams } = await import("./task-lifecycle.ts");
    await taskLifecycleSeams.indexTask?.(storage, task.id);
  } catch {
    // Best effort.
  }

  ctx.print(`${renderSuccess(`Created task ${task.id}: ${task.title}`)}\n`);
}

// --- task list -------------------------------------------------------------------------------

async function runTaskList(ctx: CommandContext): Promise<void> {
  const storage = await openStorage(ctx);
  const statusFilter = ctx.flags.string("status");
  const assigneeFilter = ctx.flags.string("assignee");
  const priorityFilter = ctx.flags.string("priority");
  const labelFilter = ctx.flags.string("label");
  const treeMode = ctx.flags.bool("tree");
  const includeHistorical = ctx.flags.bool("include-historical");

  let tasks: Task[];
  try {
    tasks = includeHistorical ? storage.tasks.listAll() : storage.tasks.listActive();
  } catch (e) {
    throw wrapErr("list tasks", e);
  }

  let filtered = tasks.filter(
    (t) =>
      !(
        (statusFilter !== "" && t.status !== statusFilter) ||
        (assigneeFilter !== "" && (t.assignee ?? "") !== assigneeFilter) ||
        (priorityFilter !== "" && t.priority !== priorityFilter) ||
        (labelFilter !== "" && !(t.labels ?? []).includes(labelFilter))
      ),
  );
  // One sort, above the fork into plain / table / JSON, so all render the same rows in order.
  filtered = sortTasksForList(filtered);

  if (ctx.json) {
    // Go's sort returns a nil slice for an empty list, which marshals as null.
    ctx.printJSON(filtered.length === 0 ? null : filtered.map(taskToWire));
    return;
  }
  if (filtered.length === 0) {
    ctx.print(`${StyleDim.render("No tasks found.")}\n`);
    return;
  }
  if (treeMode) {
    if (ctx.plain) ctx.printPaged(sprintTaskTreePlain(filtered));
    else ctx.print(renderTaskTree(filtered));
    return;
  }
  if (!ctx.plain) {
    ctx.print(renderTaskTable(filtered, terminalWidth(ctx.env)));
    return;
  }
  let { page } = getPageOpts(ctx.cmd);
  const total = filtered.length;
  let limit = DEFAULT_PLAIN_ITEM_LIMIT;
  if (!plainPageRequested(ctx.cmd)) limit = Math.max(total, 1);
  if (page <= 0) page = 1;
  const start = (page - 1) * limit;
  let end = start + limit;
  if (start >= total) {
    const totalPages = Math.trunc((total + limit - 1) / limit);
    ctx.print(`PAGE: ${page}/${totalPages} (no more items)\n`);
    return;
  }
  if (end > total) end = total;
  let out = sprintTaskListPlain(filtered.slice(start, end));
  if (total > limit) {
    const totalPages = Math.trunc((total + limit - 1) / limit);
    out += `\nPAGE: ${page}/${totalPages} (items ${start + 1}-${end} of ${total})\n`;
    if (page < totalPages) out += `Use --page ${page + 1} to see more results.\n`;
  }
  ctx.print(out);
}

// --- task edit -------------------------------------------------------------------------------

async function runTaskEdit(ctx: CommandContext): Promise<void> {
  const id = ctx.args[0] as string;
  const storage = await openStorage(ctx);
  const service = newCLITaskLifecycleService(storage);
  const f = ctx.flags;
  const outOfRange = (idx: number, task: Task): Error =>
    new Error(
      `AC index ${idx} out of range (task has ${(task.acceptanceCriteria ?? []).length} criteria)`,
    );
  let task: Task;
  try {
    task = await service.updateTask(id, {
      actor: cliLifecycleActor(ctx.env),
      expectedHash: f.string("expected-hash"),
      mutate: (t) => {
        if (f.changed("title")) t.title = f.string("title");
        if (f.changed("description")) {
          const v = f.string("description");
          if (v === "") delete t.description;
          else t.description = v;
        }
        if (f.changed("status")) t.status = f.string("status");
        if (f.changed("priority")) t.priority = f.string("priority");
        if (f.changed("assignee")) {
          const v = f.string("assignee");
          if (v === "") delete t.assignee;
          else t.assignee = v;
        }
        if (f.changed("labels")) {
          const parts = splitCSV(f.string("labels"));
          t.labels = parts.length > 0 ? parts : null;
        }
        if (f.changed("spec")) {
          const v = f.string("spec");
          if (v === "") delete t.spec;
          else t.spec = v;
        }
        if (f.changed("parent")) {
          const v = f.string("parent");
          if (v === "") delete t.parent;
          else t.parent = v;
        }
        if (f.changed("plan")) {
          const v = f.string("plan");
          if (v === "") delete t.implementationPlan;
          else t.implementationPlan = v;
        }
        if (f.changed("notes")) {
          const v = f.string("notes");
          if (v === "") delete t.implementationNotes;
          else t.implementationNotes = v;
        }
        if (f.changed("append-notes")) {
          const v = f.string("append-notes");
          // Blank line so each appended entry stays its own markdown block.
          t.implementationNotes = t.implementationNotes ? `${t.implementationNotes}\n\n${v}` : v;
          if (t.implementationNotes === "") delete t.implementationNotes;
        }
        if (f.changed("fulfills")) {
          const fulfills = f.strings("fulfills");
          if (fulfills.length > 0) t.fulfills = fulfills;
          else delete t.fulfills;
        }
        if (f.changed("order")) t.order = f.int("order");

        if (f.changed("ac")) {
          const list = [...(t.acceptanceCriteria ?? [])];
          for (const text of f.strings("ac")) list.push({ text, completed: false });
          t.acceptanceCriteria = list;
        }
        if (f.changed("check-ac")) {
          for (const idx of f.ints("check-ac")) {
            const list = t.acceptanceCriteria ?? [];
            const item = list[idx - 1];
            if (idx < 1 || !item) throw outOfRange(idx, t);
            item.completed = true;
          }
        }
        if (f.changed("uncheck-ac")) {
          for (const idx of f.ints("uncheck-ac")) {
            const list = t.acceptanceCriteria ?? [];
            const item = list[idx - 1];
            if (idx < 1 || !item) throw outOfRange(idx, t);
            item.completed = false;
          }
        }
        if (f.changed("remove-ac")) {
          // Highest index first keeps the remaining indices stable.
          const indices = [...f.ints("remove-ac")].sort((a, b) => b - a);
          for (const idx of indices) {
            const list = t.acceptanceCriteria ?? [];
            if (idx < 1 || idx > list.length) throw outOfRange(idx, t);
            list.splice(idx - 1, 1);
            t.acceptanceCriteria = list;
          }
        }
      },
    });
  } catch (e) {
    throw wrapErr("update task", e);
  }
  ctx.print(`${renderSuccess(`Updated task ${task.id}`)}\n`);
}

// --- task history ----------------------------------------------------------------------------

async function runTaskHistory(ctx: CommandContext): Promise<void> {
  const id = ctx.args[0] as string;
  const storage = await openStorage(ctx);
  const revision = ctx.flags.string("revision");
  const metadata = ctx.flags.bool("metadata");
  const offset = ctx.flags.int("offset");
  const limit = ctx.flags.int("limit");

  if (revision !== "") {
    let version: Awaited<ReturnType<typeof storage.versions.getTaskRevisionDetail>>;
    try {
      version = await storage.versions.getTaskRevisionDetail(id, revision);
    } catch (e) {
      throw wrapErr("get task revision", e);
    }
    if (ctx.json) {
      ctx.printJSON(taskVersionToWire(version));
    } else {
      const history: TaskVersionHistory = {
        taskId: id,
        currentVersion: version.version,
        versions: [version],
      };
      if (ctx.plain) ctx.printPaged(renderPlainTaskHistory(id, history));
      else ctx.print(renderTaskHistory(id, history));
    }
    return;
  }
  if (metadata || offset !== 0 || limit !== 0) {
    let page: Awaited<ReturnType<typeof storage.versions.listTaskHistoryMetadata>>;
    try {
      page = await storage.versions.listTaskHistoryMetadata(id, offset, limit);
    } catch (e) {
      throw wrapErr("list task history metadata", e);
    }
    if (ctx.json) {
      ctx.printJSON(historyMetadataPageToWire(page));
    } else {
      let b = `TASK: ${id}\nOFFSET: ${page.offset}\nLIMIT: ${page.limit}\nCURRENT_VERSION: ${page.currentVersion}\nHAS_MORE: ${page.hasMore}\n`;
      if (page.tailTruncated) b += "TAIL_TRUNCATED: true\n";
      for (const item of page.items ?? []) {
        b += `VERSION: ${item.id}\nTIMESTAMP: ${formatRFC3339(item.timestamp)}\n`;
        if (item.source) b += `SOURCE: ${item.source}\n`;
        if (item.newHash) b += `NEW_HASH: ${item.newHash}\n`;
        b += "\n";
      }
      ctx.printPaged(b);
    }
    return;
  }
  let history: TaskVersionHistory;
  try {
    history = await storage.versions.getHistory(id);
  } catch (e) {
    throw wrapErr("get history", e);
  }
  if (ctx.json) {
    ctx.printJSON(taskVersionHistoryToWire(history));
    return;
  }
  if ((history.versions ?? []).length === 0) {
    ctx.print(`No version history for task ${id}\n`);
    return;
  }
  if (ctx.plain) ctx.printPaged(renderPlainFullTaskHistory(id, history));
  else ctx.print(renderTaskHistory(id, history));
}

// --- the command tree ------------------------------------------------------------------------

const expectedHashFlag: FlagSpec = {
  type: "string",
  name: "expected-hash",
  usage: "Expected canonical hash for optimistic concurrency",
};
const yesPreviewFlag: FlagSpec = {
  type: "bool",
  name: "yes",
  usage: "Execute; otherwise preview only",
};

export default defineCommand({
  use: "task [id]",
  short: "Manage tasks",
  long: "Create, view, edit, and manage project tasks.",
  example: `  # The everyday loop
  knowns task list
  knowns task create "Add JWT auth"
  knowns task edit KN-A1B2C3 -s in-progress
  knowns task edit KN-A1B2C3 -s done

  # Read one task; the id alone is shorthand for "task view"
  knowns task KN-A1B2C3`,
  // `knowns task <id>` is shorthand for `knowns task view <id>`.
  args: arbitraryArgs,
  run: async (ctx) => {
    if (ctx.args.length === 0) {
      ctx.cmd.help();
      return;
    }
    await runTaskView(ctx, ctx.args[0] as string);
  },
  subcommands: [
    defineCommand({
      use: "create <title>",
      short: "Create a new task",
      example: `  # A task with nothing but a title
  knowns task create "Add JWT auth"

  # With outcome-oriented acceptance criteria, repeat --ac per criterion
  knowns task create "Add JWT auth" \\
    --ac "User can log in and receive a token" \\
    --ac "Expired tokens are rejected"

  # With priority and labels
  knowns task create "Fix login timeout" --priority high -l auth,bug

  # As a subtask of an existing task
  knowns task create "Write auth tests" --parent KN-A1B2C3`,
      args: minimumNArgs(1),
      flags: [
        { type: "string", name: "description", shorthand: "d", usage: "Task description" },
        { type: "stringArray", name: "ac", usage: "Acceptance criterion (repeatable)" },
        { type: "string", name: "status", shorthand: "s", usage: "Task status" },
        { type: "string", name: "priority", usage: "Task priority (low|medium|high)" },
        { type: "string", name: "assignee", shorthand: "a", usage: "Task assignee" },
        { type: "stringArray", name: "label", shorthand: "l", usage: "Task label (repeatable)" },
        { type: "string", name: "parent", usage: "Parent task ID" },
        { type: "string", name: "spec", usage: "Linked spec document path" },
        {
          type: "stringArray",
          name: "fulfills",
          usage: "Spec AC this task fulfills (repeatable)",
        },
        { type: "string", name: "plan", usage: "Implementation plan" },
        { type: "string", name: "notes", usage: "Implementation notes" },
        {
          type: "string",
          name: "prefix",
          usage: "Custom task ID prefix (2-8 alphanumeric characters)",
        },
      ],
      run: runTaskCreate,
    }),
    defineCommand({
      use: "list",
      short: "List tasks",
      example: `  # Every task
  knowns task list

  # Only what is being worked on
  knowns task list --status in-progress

  # Your own high-priority work
  knowns task list --assignee @me --priority high

  # As a parent/child tree
  knowns task list --tree`,
      flags: [
        { type: "string", name: "status", usage: "Filter by status" },
        { type: "string", name: "assignee", usage: "Filter by assignee" },
        { type: "string", name: "priority", usage: "Filter by priority" },
        { type: "string", name: "label", usage: "Filter by label" },
        { type: "bool", name: "tree", usage: "Show tasks as tree hierarchy" },
        {
          type: "bool",
          name: "include-historical",
          usage: "Include historical entities, including archived Tasks",
        },
      ],
      run: runTaskList,
    }),
    defineCommand({
      use: "view <id>",
      short: "View a task",
      example: `  # Full task, styled
  knowns task view KN-A1B2C3

  # The same thing, since view is optional
  knowns task KN-A1B2C3

  # Parseable output for an agent
  knowns task KN-A1B2C3 --plain`,
      args: exactArgs(1),
      run: (ctx) => runTaskView(ctx, ctx.args[0] as string),
    }),
    defineCommand({
      use: "edit <id>",
      short: "Edit a task",
      example: `  # Take the task
  knowns task edit KN-A1B2C3 -s in-progress -a @me

  # Record the plan before writing code
  knowns task edit KN-A1B2C3 --plan $'1. Read the spec\\n2. Add the middleware\\n3. Test'

  # Tick criterion 1, one-indexed, only once the work is actually done
  knowns task edit KN-A1B2C3 --check-ac 1

  # Append progress without replacing the existing notes
  knowns task edit KN-A1B2C3 --append-notes "Middleware landed, tests next"

  # Finish
  knowns task edit KN-A1B2C3 -s done`,
      args: exactArgs(1),
      flags: [
        { type: "string", name: "title", shorthand: "t", usage: "New title" },
        { type: "string", name: "description", shorthand: "d", usage: "New description" },
        { type: "string", name: "status", shorthand: "s", usage: "New status" },
        { type: "string", name: "priority", usage: "New priority" },
        { type: "string", name: "assignee", shorthand: "a", usage: "New assignee" },
        { type: "string", name: "labels", usage: "New labels (comma-separated)" },
        { type: "stringArray", name: "ac", usage: "Add acceptance criterion (repeatable)" },
        { type: "intSlice", name: "check-ac", usage: "Check AC by 1-based index (repeatable)" },
        { type: "intSlice", name: "uncheck-ac", usage: "Uncheck AC by 1-based index (repeatable)" },
        { type: "intSlice", name: "remove-ac", usage: "Remove AC by 1-based index (repeatable)" },
        { type: "string", name: "plan", usage: "Set implementation plan" },
        { type: "string", name: "notes", usage: "Set implementation notes (replaces existing)" },
        { type: "string", name: "append-notes", usage: "Append to implementation notes" },
        { type: "string", name: "spec", usage: "Linked spec document path" },
        { type: "string", name: "parent", usage: "Parent task ID" },
        expectedHashFlag,
        {
          type: "stringArray",
          name: "fulfills",
          usage: "Spec ACs this task fulfills (repeatable)",
        },
        { type: "int", name: "order", usage: "Display order (lower = first)" },
      ],
      run: runTaskEdit,
    }),
    defineCommand({
      use: "hard-delete <id>",
      aliases: ["delete"],
      short: "Permanently delete a task and retain a content-free tombstone",
      args: exactArgs(1),
      flags: [
        { type: "string", name: "reason", usage: "Required deletion reason" },
        { type: "bool", name: "yes", usage: "Explicitly confirm permanent deletion" },
        {
          type: "bool",
          name: "allow-hard-delete",
          usage: "Grant this local CLI invocation hard-delete capability",
        },
      ],
      run: (ctx) =>
        runCLILifecycle(
          ctx,
          {
            operation: "hard_delete",
            taskId: ctx.args[0] as string,
            execute: ctx.flags.bool("yes"),
            confirmed: ctx.flags.bool("yes"),
            reason: ctx.flags.string("reason"),
            actor: cliLifecycleActor(ctx.env),
          },
          ctx.flags.bool("allow-hard-delete"),
        ),
    }),
    defineCommand({
      use: "archive <id>",
      short: "Archive a task",
      args: exactArgs(1),
      flags: [yesPreviewFlag, expectedHashFlag],
      run: (ctx) =>
        runCLILifecycle(
          ctx,
          {
            operation: "archive",
            taskId: ctx.args[0] as string,
            execute: ctx.flags.bool("yes"),
            actor: cliLifecycleActor(ctx.env),
            expectedHash: ctx.flags.string("expected-hash"),
          },
          false,
        ),
    }),
    defineCommand({
      use: "unarchive <id>",
      short: "Restore a task from the archive",
      args: exactArgs(1),
      flags: [yesPreviewFlag, expectedHashFlag],
      run: (ctx) =>
        runCLILifecycle(
          ctx,
          {
            operation: "reopen",
            taskId: ctx.args[0] as string,
            execute: ctx.flags.bool("yes"),
            actor: cliLifecycleActor(ctx.env),
            expectedHash: ctx.flags.string("expected-hash"),
          },
          false,
        ),
    }),
    defineCommand({
      use: "batch-archive [ids...]",
      short: "Preview or execute a batch archive",
      args: arbitraryArgs,
      flags: [yesPreviewFlag],
      run: (ctx) =>
        runCLILifecycle(
          ctx,
          {
            operation: "batch_archive",
            ids: ctx.args,
            execute: ctx.flags.bool("yes"),
            actor: cliLifecycleActor(ctx.env),
          },
          false,
        ),
    }),
    defineCommand({
      use: "batch-unarchive <ids...>",
      short: "Preview or execute a batch unarchive",
      args: arbitraryArgs,
      flags: [yesPreviewFlag],
      run: (ctx) =>
        runCLILifecycle(
          ctx,
          {
            operation: "batch_unarchive",
            ids: ctx.args,
            execute: ctx.flags.bool("yes"),
            actor: cliLifecycleActor(ctx.env),
          },
          false,
        ),
    }),
    defineCommand({
      use: "history <id>",
      short: "Show version history of a task",
      args: exactArgs(1),
      flags: [
        { type: "bool", name: "metadata", usage: "List payload-free revision metadata" },
        { type: "int", name: "offset", usage: "Metadata page offset (newest first)" },
        { type: "int", name: "limit", usage: "Metadata page size (0 means all)" },
        { type: "string", name: "revision", usage: "Load one revision detail (vN or numeric)" },
      ],
      run: runTaskHistory,
    }),
  ],
});
