// `knowns memory`: port of internal/cli/memory.go.

import type { MemoryReviewResult } from "../../domain/memoryreview/index.ts";
import {
  MemoryReviewService,
  memoryJson,
  memoryResultJson,
} from "../../domain/memoryreview/index.ts";
import {
  MEMORY_LAYER_PROJECT,
  type MemoryCleanupCandidate,
  type MemoryEntry,
  memoryCurrentForDefaultRetrieval,
  selectMemoryCleanupCandidates,
  validMemoryStatus,
  validPersistentMemoryLayer,
} from "../../models/memory.ts";
import { arbitraryArgs, exactArgs, minimumNArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { DEFAULT_PLAIN_ITEM_LIMIT, getPageOpts, plainPageRequested } from "../core/pager.ts";
import {
  renderDim,
  renderSeparator,
  renderSuccess,
  renderWarning,
  StyleBold,
  StyleDim,
  StyleID,
  StyleTitle,
  StyleWarning,
} from "../core/plainoutput.ts";
import memoryMigrate from "./memory-migrate.ts";
import {
  bestEffortIndexMemory,
  bestEffortRemoveMemory,
  containsTag,
  layerStyle,
  openStorage,
  renderTags,
  rfc3339,
  scanToken,
  searchEnvironment,
} from "./memory-support.ts";

/** Default soft limit per layer. */
const DEFAULT_MEMORY_SOFT_LIMIT = 100;

const goPad = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - [...s].length));

/** Go slices bytes; for ASCII-and-beyond titles `title[:25]` cuts on bytes. */
function byteCut(s: string, n: number): string {
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length <= n) return s;
  return new TextDecoder("utf-8").decode(bytes.subarray(0, n));
}

async function runMemoryView(ctx: CommandContext, id: string): Promise<void> {
  const storage = await openStorage(ctx);
  let entry: MemoryEntry;
  try {
    entry = storage.memory.get(id);
  } catch {
    throw new Error(`memory "${id}" not found`);
  }
  if (ctx.json) {
    ctx.printJSON(memoryJson(entry));
    return;
  }
  if (ctx.plain) {
    let out = `ID: ${entry.id}\n`;
    out += `TITLE: ${entry.title}\n`;
    out += `LAYER: ${entry.layer}\n`;
    if (entry.category) out += `CATEGORY: ${entry.category}\n`;
    if (entry.tags && entry.tags.length > 0) out += `TAGS: ${entry.tags.join(", ")}\n`;
    out += `UPDATED: ${entry.updatedAt.slice(0, 10)}\n\n`;
    if (entry.content) out += `${entry.content}\n`;
    ctx.printPaged(out);
    return;
  }
  ctx.print(renderMemoryView(entry));
}

function renderMemoryView(entry: MemoryEntry): string {
  let b = `${StyleTitle.render(entry.title)}\n`;
  b += `${StyleDim.render("Layer:")} ${layerStyle(entry.layer)}  ${StyleDim.render("Category:")} ${entry.category ?? ""}\n`;
  if (entry.tags && entry.tags.length > 0) {
    b += `${StyleDim.render("Tags:")} ${renderTags(entry.tags)}\n`;
  }
  b += `${renderSeparator(60)}\n`;
  if (entry.content) b += `${entry.content}\n`;
  return b;
}

function renderMemoryList(entries: MemoryEntry[]): string {
  let b = `  ${StyleBold.render(goPad("ID", 8))}  ${StyleBold.render(goPad("TITLE", 30))}  ${StyleBold.render(goPad("LAYER", 10))}  ${StyleBold.render("CATEGORY")}\n`;
  b += `  ${renderSeparator(70)}\n`;
  for (const e of entries) {
    let title = e.title;
    if (Buffer.byteLength(title) > 28) title = `${byteCut(title, 25)}...`;
    b += `  ${StyleID.render(goPad(e.id, 8))}  ${goPad(title, 30)}  ${goPad(layerStyle(e.layer), 10)}  ${StyleDim.render(e.category ?? "")}\n`;
  }
  return b;
}

const memoryList = defineCommand({
  use: "list",
  short: "List memory entries",
  flags: [
    {
      type: "string",
      name: "layer",
      usage: "Filter by layer (working, project, global)",
      default: "",
    },
    { type: "string", name: "category", usage: "Filter by category", default: "" },
    { type: "string", name: "tag", usage: "Filter by tag", default: "" },
    { type: "string", name: "status", usage: "Filter by memory status", default: "" },
    {
      type: "bool",
      name: "all-statuses",
      usage: "Include non-active memory statuses",
      default: false,
    },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    const layer = ctx.flags.string("layer");
    const category = ctx.flags.string("category");
    const tagFilter = ctx.flags.string("tag");
    const statusFilter = ctx.flags.string("status");
    const allStatuses = ctx.flags.bool("all-statuses");

    let entries: MemoryEntry[];
    try {
      entries = storage.memory.list(layer);
    } catch (e) {
      throw new Error(`list memory: ${(e as Error).message}`, { cause: e });
    }
    if (statusFilter !== "" && !validMemoryStatus(statusFilter)) {
      throw new Error(`invalid memory status: "${statusFilter}"`);
    }
    // Go keeps a nil slice nil through the filters, which marshals as null rather than [].
    const wasNil = entries.length === 0;
    if (category !== "") entries = entries.filter((e) => (e.category ?? "") === category);
    if (statusFilter !== "") entries = entries.filter((e) => e.status === statusFilter);
    else if (!allStatuses) entries = entries.filter((e) => memoryCurrentForDefaultRetrieval(e));
    if (tagFilter !== "") entries = entries.filter((e) => containsTag(e.tags, tagFilter));

    if (ctx.json) {
      ctx.printJSON(wasNil ? null : entries.map(memoryJson));
      return;
    }
    if (entries.length === 0) {
      ctx.print(`${StyleDim.render("No memory entries found.")}\n`);
      return;
    }
    if (ctx.plain) {
      let { page } = getPageOpts(ctx.cmd);
      const total = entries.length;
      let limit = DEFAULT_PLAIN_ITEM_LIMIT;
      if (!plainPageRequested(ctx.cmd)) limit = Math.max(total, 1);
      if (page <= 0) page = 1;
      const start = (page - 1) * limit;
      let end = start + limit;
      if (start >= total) {
        const totalPages = Math.floor((total + limit - 1) / limit);
        ctx.print(`PAGE: ${page}/${totalPages} (no more items)\n`);
        return;
      }
      if (end > total) end = total;
      let pb = "";
      for (const e of entries.slice(start, end)) {
        pb += `MEMORY: ${e.id}\n`;
        pb += `  TITLE: ${e.title}\n`;
        pb += `  LAYER: ${e.layer}\n`;
        if (e.category) pb += `  CATEGORY: ${e.category}\n`;
        if (e.tags && e.tags.length > 0) pb += `  TAGS: ${e.tags.join(", ")}\n`;
        pb += "\n";
      }
      ctx.print(pb);
      if (total > limit) {
        const totalPages = Math.floor((total + limit - 1) / limit);
        ctx.print(`PAGE: ${page}/${totalPages} (items ${start + 1}-${end} of ${total})\n`);
        if (page < totalPages) ctx.print(`Use --page ${page + 1} to see more results.\n`);
      }
      return;
    }
    ctx.print(renderMemoryList(entries));
  },
});

function cleanupPlain(candidates: MemoryCleanupCandidate[]): string {
  if (candidates.length === 0) return "No stale memories found\n";
  let pb = "";
  for (const c of candidates) {
    pb += `MEMORY: ${c.id}\n`;
    pb += `  TITLE: ${c.title}\n`;
    pb += `  LAYER: ${c.layer}\n`;
    if (c.category) pb += `  CATEGORY: ${c.category}\n`;
    if (c.tags && c.tags.length > 0) pb += `  TAGS: ${c.tags.join(", ")}\n`;
    pb += `  AGE_DAYS: ${c.ageDays}\n`;
    pb += `  CREATED_AT: ${rfc3339(c.createdAt)}\n`;
    pb += `  UPDATED_AT: ${rfc3339(c.updatedAt)}\n`;
    if (c.content) pb += `  CONTENT:\n${c.content}\n`;
    pb += "\n";
  }
  return pb;
}

const memoryCleanup = defineCommand({
  use: "cleanup",
  short: "List stale memory cleanup candidates",
  flags: [
    { type: "int", name: "older-than", usage: "Minimum stale age in days", default: 7 },
    {
      type: "string",
      name: "layer",
      usage: "Memory layer (project, global; default: project)",
      default: MEMORY_LAYER_PROJECT,
    },
    { type: "int", name: "limit", usage: "Maximum cleanup candidates to return", default: 20 },
  ],
  async run(ctx) {
    const storage = await openStorage(ctx);
    let olderThanDays = ctx.flags.int("older-than");
    let layer = ctx.flags.string("layer");
    let limit = ctx.flags.int("limit");
    if (layer === "") layer = MEMORY_LAYER_PROJECT;
    if (!validPersistentMemoryLayer(layer)) throw new Error("layer must be 'project' or 'global'");
    if (olderThanDays <= 0) olderThanDays = 7;
    if (limit <= 0) limit = 20;

    let entries: MemoryEntry[];
    try {
      entries = storage.memory.listPersistent(layer);
    } catch (e) {
      throw new Error(`list memory cleanup candidates: ${(e as Error).message}`, { cause: e });
    }
    const candidates = selectMemoryCleanupCandidates(entries, olderThanDays, limit, Date.now());
    if (ctx.json) {
      ctx.printJSON(candidates);
      return;
    }
    if (ctx.plain) {
      ctx.printPaged(cleanupPlain(candidates));
      return;
    }
    if (candidates.length === 0) {
      ctx.print(`${StyleDim.render("No stale memories found.")}\n`);
      return;
    }
    ctx.printPaged(cleanupPlain(candidates));
  },
});

const memoryView = defineCommand({
  use: "view <id>",
  short: "View a memory entry",
  args: exactArgs(1),
  run: (ctx) => runMemoryView(ctx, ctx.args[0] as string),
});

function reviewRequiredText(result: MemoryReviewResult): string {
  let b = `${renderWarning("Memory review required: similar memories already exist.")}\n`;
  for (const match of result.matches ?? []) {
    b += `MEMORY: ${match.id}\n`;
    b += `  TITLE: ${match.title}\n`;
    b += `  LAYER: ${match.layer}\n`;
    if (match.category) b += `  CATEGORY: ${match.category}\n`;
    if (match.status) b += `  STATUS: ${match.status}\n`;
    b += `  SCORE: ${match.score.toFixed(2)}\n`;
    if (match.matchedBy && match.matchedBy.length > 0) {
      b += `  MATCHED_BY: ${match.matchedBy.join(", ")}\n`;
    }
    b += "\n";
  }
  b += `Allowed resolutions: ${(result.allowedResolutions ?? []).join(", ")}\n`;
  b += "Use --create-anyway to create this memory explicitly.\n";
  return b;
}

const memoryCreate = defineCommand({
  use: "create <title>",
  short: "Create a new memory entry",
  args: minimumNArgs(1),
  flags: [
    {
      type: "string",
      name: "layer",
      usage: "Memory layer (working, project, global; default: project)",
      default: "",
    },
    {
      type: "string",
      name: "category",
      usage:
        "Memory category (pattern, convention, preference, failure); decision is legacy and rejected",
      default: "",
    },
    { type: "stringArray", name: "tag", shorthand: "t", usage: "Memory tag (repeatable)" },
    { type: "string", name: "content", shorthand: "c", usage: "Memory content", default: "" },
    {
      type: "string",
      name: "status",
      usage: "Explicit memory status for human create/override",
      default: "",
    },
    {
      type: "bool",
      name: "create-anyway",
      usage: "Create even when duplicate review candidates are found",
      default: false,
    },
  ],
  async run(ctx) {
    const title = ctx.args.join(" ");
    const storage = await openStorage(ctx);
    let layer = ctx.flags.string("layer");
    const category = ctx.flags.string("category");
    const tags = ctx.flags.strings("tag");
    const content = ctx.flags.string("content");
    const createAnyway = ctx.flags.bool("create-anyway");
    const status = ctx.flags.string("status");
    if (status !== "" && !validMemoryStatus(status)) {
      throw new Error(`invalid memory status: "${status}"`);
    }
    if (layer === "") layer = MEMORY_LAYER_PROJECT;

    let count = 0;
    try {
      count = storage.memory.countByLayer(layer);
    } catch {
      count = 0;
    }
    if (count >= DEFAULT_MEMORY_SOFT_LIMIT) {
      ctx.print(
        `${renderWarning(`Layer "${layer}" has ${count} entries (soft limit: ${DEFAULT_MEMORY_SOFT_LIMIT}). Consider cleaning up.`)}\n`,
      );
    }

    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: "",
      title,
      layer,
      content,
      tags: tags.length > 0 ? [...tags] : [],
      createdAt: now,
      updatedAt: now,
      ...(category !== "" ? { category } : {}),
    };

    const svc = new MemoryReviewService(storage, { searchEnv: searchEnvironment(ctx) });
    let result: MemoryReviewResult;
    try {
      result = createAnyway
        ? await svc.add(entry, { skipReview: true, status: status.trim() || "proposed" })
        : await svc.add(entry, { status });
    } catch (e) {
      throw new Error(`create memory: ${(e as Error).message}`, { cause: e });
    }
    if (result.status === "review_required") {
      if (ctx.json) {
        ctx.printJSON(memoryResultJson(result));
        return;
      }
      ctx.printPaged(reviewRequiredText(result));
      return;
    }
    for (const id of result.changedIds ?? []) await bestEffortIndexMemory(storage, id);
    const m = result.memory as MemoryEntry;
    ctx.print(
      `${renderSuccess(`Created memory: ${m.id} (${m.title}, layer: ${m.layer}, status: ${m.status ?? ""})`)}\n`,
    );
  },
});

const memoryEdit = defineCommand({
  use: "edit <id>",
  short: "Edit a memory entry",
  args: exactArgs(1),
  flags: [
    { type: "string", name: "title", shorthand: "t", usage: "New title", default: "" },
    { type: "string", name: "category", usage: "New category", default: "" },
    { type: "stringArray", name: "tag", usage: "New tags (replaces existing)" },
    { type: "string", name: "content", shorthand: "c", usage: "Replace content", default: "" },
    { type: "string", name: "append", shorthand: "a", usage: "Append to content", default: "" },
  ],
  async run(ctx) {
    const id = ctx.args[0] as string;
    const storage = await openStorage(ctx);
    let entry: MemoryEntry;
    try {
      entry = storage.memory.get(id);
    } catch {
      throw new Error(`memory "${id}" not found`);
    }
    if (ctx.flags.changed("title")) entry.title = ctx.flags.string("title");
    if (ctx.flags.changed("category")) {
      const v = ctx.flags.string("category");
      if (v === "") delete entry.category;
      else entry.category = v;
    }
    if (ctx.flags.changed("tag")) entry.tags = [...ctx.flags.strings("tag")];
    if (ctx.flags.changed("content")) entry.content = ctx.flags.string("content");
    if (ctx.flags.changed("append")) {
      const v = ctx.flags.string("append");
      if (!entry.content) {
        entry.content = v;
      } else {
        if (!entry.content.endsWith("\n")) entry.content += "\n";
        entry.content += v;
      }
    }
    entry.updatedAt = new Date().toISOString();
    try {
      await storage.memory.update(entry);
    } catch (e) {
      throw new Error(`update memory: ${(e as Error).message}`, { cause: e });
    }
    await bestEffortIndexMemory(storage, entry.id);
    ctx.print(`${renderSuccess(`Updated memory: ${entry.id}`)}\n`);
  },
});

const memoryDelete = defineCommand({
  use: "delete <id>",
  short: "Delete a memory entry",
  args: exactArgs(1),
  flags: [
    { type: "bool", name: "dry-run", usage: "Preview what would be deleted", default: false },
    { type: "bool", name: "force", usage: "Skip confirmation prompt", default: false },
  ],
  async run(ctx) {
    const id = ctx.args[0] as string;
    const storage = await openStorage(ctx);
    const dryRun = ctx.flags.bool("dry-run");
    const force = ctx.flags.bool("force");
    let entry: MemoryEntry;
    try {
      entry = storage.memory.get(id);
    } catch {
      throw new Error(`memory "${id}" not found`);
    }
    if (dryRun) {
      ctx.print(
        `${renderDim(`Would delete memory: ${entry.id} (${entry.title}, layer: ${entry.layer})`)}\n`,
      );
      return;
    }
    if (!force) {
      ctx.print(
        `${StyleWarning.render("Delete memory")} ${StyleBold.render(entry.id)} (${entry.title})? ${StyleDim.render("This cannot be undone. (y/n)")}: `,
      );
      const answer = scanToken();
      if (answer !== "y" && answer !== "yes") {
        ctx.print(`${StyleDim.render("Aborted.")}\n`);
        return;
      }
    }
    try {
      await storage.memory.delete(id);
    } catch (e) {
      throw new Error(`delete memory: ${(e as Error).message}`, { cause: e });
    }
    await bestEffortRemoveMemory(storage, id);
    ctx.print(`${renderSuccess(`Deleted memory: ${entry.id}`)}\n`);
  },
});

const memoryPromote = defineCommand({
  use: "promote <id>",
  short: "Promote a memory entry up one layer",
  args: exactArgs(1),
  async run(ctx) {
    const storage = await openStorage(ctx);
    const entry = await storage.memory.promote(ctx.args[0] as string);
    await bestEffortIndexMemory(storage, entry.id);
    ctx.print(`${renderSuccess(`Promoted memory ${entry.id} to layer: ${entry.layer}`)}\n`);
  },
});

const memoryDemote = defineCommand({
  use: "demote <id>",
  short: "Demote a memory entry down one layer",
  args: exactArgs(1),
  async run(ctx) {
    const storage = await openStorage(ctx);
    const entry = await storage.memory.demote(ctx.args[0] as string);
    await bestEffortIndexMemory(storage, entry.id);
    ctx.print(`${renderSuccess(`Demoted memory ${entry.id} to layer: ${entry.layer}`)}\n`);
  },
});

export default defineCommand({
  use: "memory",
  short: "Manage memory entries",
  long: "Create, view, and manage project and global memory entries.",
  args: arbitraryArgs,
  async run(ctx) {
    if (ctx.args.length === 0) {
      ctx.cmd.help();
      return;
    }
    await runMemoryView(ctx, ctx.args[0] as string);
  },
  subcommands: [
    memoryList,
    memoryCleanup,
    memoryView,
    memoryCreate,
    memoryEdit,
    memoryDelete,
    memoryPromote,
    memoryDemote,
    memoryMigrate,
  ],
});
