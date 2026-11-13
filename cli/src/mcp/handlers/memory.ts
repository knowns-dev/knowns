// Port of internal/mcp/handlers/memory.go.
import { goQuote } from "../../cli/core/gofmt.ts";
import {
  MemoryReviewService,
  memoryJson,
  memoryResultJson,
} from "../../domain/memoryreview/index.ts";
import {
  deriveMemoryKey,
  inspectMemoryClaim,
  MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH,
  MEMORY_DETAIL_MARKER,
  type MemoryEntry,
  memoryCurrentForDefaultRetrieval,
  selectMemoryCleanupCandidates,
  validateLegacyDecisionMemoryUpdate,
  validateMemoryCategory,
  validatePreferenceWhy,
  validMemoryConfidence,
  validMemoryLayer,
  validMemoryStatus,
} from "../../models/memory.ts";
import {
  boolArg,
  errFailed,
  errNotFound,
  intArg,
  noProjectError,
  stringArg,
  stringSetArg,
  stringSliceArg,
} from "../args.ts";
import { goMap, marshalIndent } from "../gojson.ts";
import { notifyRefresh } from "../notify.ts";
import type { McpState, Project } from "../state.ts";
import {
  argsOf,
  type CallToolRequest,
  type CallToolResult,
  errorResult,
  requireString,
  textResult,
} from "../tool.ts";

export async function handle(
  state: McpState,
  _ctx: unknown,
  req: CallToolRequest,
): Promise<CallToolResult> {
  const a = requireString(req, "action");
  if (!a.ok) return errorResult("action is required");
  switch (a.value) {
    case "add":
      return add(state, req);
    case "get":
      return get(state, req);
    case "update":
      return update(state, req);
    case "delete":
      return del(state, req);
    case "list":
      return list(state, req);
    case "promote":
      return promoteOrDemote(state, req, true);
    case "demote":
      return promoteOrDemote(state, req, false);
    case "cleanup":
      return cleanup(state, req);
    case "resolve":
      return resolve(state, req);
    case "confirm":
      return confirm(state, req);
    case "contradict":
      return contradict(state, req);
    default:
      return errorResult(`unknown memory action: ${a.value}`);
  }
}

const nowText = (): string => new Date().toISOString();

async function indexMemory(project: Project, id: string): Promise<void> {
  const { bestEffortIndexMemory } = await import("../../runtime/index/best-effort.ts");
  try {
    bestEffortIndexMemory(project.storage, id);
  } catch {
    // best effort
  }
}

async function removeMemory(project: Project, id: string): Promise<void> {
  const { bestEffortRemoveMemory } = await import("../../runtime/index/best-effort.ts");
  try {
    bestEffortRemoveMemory(project.storage, id);
  } catch {
    // best effort
  }
}

async function reviewService(project: Project): Promise<MemoryReviewService> {
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  return new MemoryReviewService(project.storage, { searchEnv: buildSearchEnvironment() });
}

function writeResult(entry: MemoryEntry, replaced: boolean): CallToolResult {
  const info = inspectMemoryClaim(entry.content ?? "");
  const out: Record<string, unknown> = {};
  if (replaced) out.replaced = true;
  out.memory = memoryJson(entry);
  out.claim = info.claim;
  out.claimSource = info.claimSource;
  if (info.detailBytes) out.detailBytes = info.detailBytes;
  if (info.claimSource === MEMORY_CLAIM_SOURCE_FIRST_PARAGRAPH) {
    out.claimWarning = `Only the first paragraph (${Buffer.byteLength(info.claim)} bytes) is injected; the remaining ${info.detailBytes ?? 0} bytes are fetched with memory(action:"get", id:${goQuote(entry.id)}). Nobody chose that boundary. Add ${MEMORY_DETAIL_MARKER} where the claim ends to settle it, or run \`knowns memory migrate --write\` to freeze the current split.`;
  }
  return textResult(marshalIndent(out));
}

function findByKey(project: Project, layer: string, key: string): MemoryEntry | undefined {
  if (key === "") return undefined;
  for (const entry of project.storage.memory.listPersistent(layer)) {
    if (entry.layer !== layer) continue;
    const existing = entry.key || deriveMemoryKey(entry.title);
    if (existing !== "" && existing === key) return entry;
  }
  return undefined;
}

interface Write {
  title: string;
  key: string;
  category: string;
  content: string;
  tags: string[] | undefined;
  status: string;
  sources: string[];
  confidence: string;
  ttlDays: number;
}

async function replaceByKey(
  project: Project,
  entry: MemoryEntry,
  w: Write,
): Promise<CallToolResult> {
  const updated: MemoryEntry = { ...entry, key: w.key };
  if (w.title !== "") updated.title = w.title;
  if (w.category !== "") updated.category = w.category;
  if (w.content !== "") updated.content = w.content;
  if (w.tags !== undefined) updated.tags = w.tags;
  if (w.status !== "") updated.status = w.status;
  if (w.sources.length > 0) updated.sources = w.sources;
  if (w.confidence !== "") updated.confidence = w.confidence;
  if (w.ttlDays > 0) updated.ttlDays = w.ttlDays;
  try {
    validateLegacyDecisionMemoryUpdate(entry, updated);
    validatePreferenceWhy(updated.category ?? "", updated.content ?? "");
  } catch (e) {
    return errorResult((e as Error).message);
  }
  const now = nowText();
  updated.updatedAt = now;
  if (w.sources.length > 0 || w.confidence !== "") updated.lastVerified = now;
  try {
    await project.storage.memory.update(updated);
  } catch (e) {
    return errFailed("update memory", e);
  }
  await indexMemory(project, updated.id);
  notifyRefresh(project.store);
  return writeResult(updated, true);
}

async function add(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const c = requireString(req, "content");
  if (!c.ok) return errorResult("content is required");
  const content = c.value;
  const args = argsOf(req);
  const [title] = stringArg(args, "title");
  let [layer] = stringArg(args, "layer");
  const [category] = stringArg(args, "category");
  const [tagsRaw, tagsOk] = stringSliceArg(args, "tags");
  const tags = tagsOk ? tagsRaw : undefined;
  let [key] = stringArg(args, "key");
  const [status] = stringArg(args, "status");
  const [sources] = stringSliceArg(args, "sources");
  const [confidence] = stringArg(args, "confidence");
  const [ttlDays] = intArg(args, "ttlDays");

  if (layer === "") layer = "project";
  if (!validMemoryLayer(layer)) return errorResult("layer must be 'project' or 'global'");
  try {
    validateMemoryCategory(category);
    validatePreferenceWhy(category, content);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  if (status !== "" && !validMemoryStatus(status)) {
    return errorResult(`invalid status ${goQuote(status)}`);
  }
  if (confidence !== "" && !validMemoryConfidence(confidence)) {
    return errorResult(`invalid confidence ${goQuote(confidence)}`);
  }

  // Only an explicit key upserts; a key derived from the title never matches on its own.
  if (key !== "") {
    let existing: MemoryEntry | undefined;
    try {
      existing = findByKey(project, layer, key);
    } catch (e) {
      return errFailed("look up memory key", e);
    }
    if (existing) {
      return replaceByKey(project, existing, {
        title,
        key,
        category,
        content,
        tags,
        status,
        sources,
        confidence,
        ttlDays,
      });
    }
  }
  if (key === "") key = deriveMemoryKey(title);

  const now = nowText();
  const entry: MemoryEntry = {
    id: "",
    title,
    layer,
    content,
    tags: tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  if (key !== "") entry.key = key;
  if (category !== "") entry.category = category;
  if (sources.length > 0) entry.sources = sources;
  if (confidence !== "") entry.confidence = confidence;
  if (ttlDays > 0) entry.ttlDays = ttlDays;
  if (sources.length > 0 || confidence !== "") entry.lastVerified = now;

  const requested = status === "" ? "active" : status;
  let result: Awaited<ReturnType<MemoryReviewService["add"]>>;
  try {
    result = await (await reviewService(project)).add(entry, { status: requested });
  } catch (e) {
    return errFailed("create memory", e);
  }
  if (result.status === "review_required")
    return textResult(marshalIndent(memoryResultJson(result)));
  for (const id of result.changedIds ?? []) if (id !== "") await indexMemory(project, id);
  notifyRefresh(project.store);
  return writeResult(result.memory as MemoryEntry, false);
}

function getEntry(project: Project, id: string): MemoryEntry | undefined {
  try {
    const entry = project.storage.memory.get(id);
    return validMemoryLayer(entry.layer) ? entry : undefined;
  } catch {
    return undefined;
  }
}

const notFound = (id: string): CallToolResult =>
  errNotFound("memory", new Error(`memory ${goQuote(id)} not found`));

async function get(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const entry = getEntry(project, id.value);
  if (!entry) return notFound(id.value);
  return textResult(marshalIndent(memoryJson(entry)));
}

/** time.Format(time.RFC3339): whole seconds, UTC "Z". */
const rfc3339 = (ts: string): string => {
  const ms = Date.parse(ts);
  return Number.isNaN(ms)
    ? "0001-01-01T00:00:00Z"
    : new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
};

async function list(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [layer] = stringArg(args, "layer");
  const [category] = stringArg(args, "category");
  const [tag] = stringArg(args, "tag");
  const [status] = stringArg(args, "status");
  const includeAll = boolArg(args, "includeAll");
  if (layer !== "" && !validMemoryLayer(layer))
    return errorResult("layer must be 'project' or 'global'");
  if (status !== "" && !validMemoryStatus(status)) {
    return errorResult("status must be a valid memory status");
  }
  let entries: MemoryEntry[];
  try {
    entries = project.storage.memory.listPersistent(layer);
  } catch (e) {
    return errFailed("list memories", e);
  }
  if (category !== "") entries = entries.filter((e) => e.category === category);
  if (tag !== "") entries = entries.filter((e) => (e.tags ?? []).includes(tag));
  if (status !== "") entries = entries.filter((e) => e.status === status);
  else if (!includeAll) entries = entries.filter((e) => memoryCurrentForDefaultRetrieval(e));
  const summaries = entries.map((e) => {
    const s: Record<string, unknown> = { id: e.id, title: e.title, layer: e.layer };
    if (e.category) s.category = e.category;
    if (e.status) s.status = e.status;
    if (e.tags && e.tags.length > 0) s.tags = e.tags;
    s.createdAt = rfc3339(e.createdAt);
    s.updatedAt = rfc3339(e.updatedAt);
    return s;
  });
  return textResult(marshalIndent(summaries));
}

function candidateFromArgs(args: Record<string, unknown>): MemoryEntry {
  const [id] = stringArg(args, "id");
  const [title] = stringArg(args, "title");
  const [layer] = stringArg(args, "layer");
  const [category] = stringArg(args, "category");
  const [content] = stringArg(args, "content");
  const [tags] = stringSliceArg(args, "tags");
  const [sources] = stringSliceArg(args, "sources");
  const [confidence] = stringArg(args, "confidence");
  const [ttlDays] = intArg(args, "ttlDays");
  const e: MemoryEntry = { id, title, layer, content, createdAt: "", updatedAt: "" };
  if (category !== "") e.category = category;
  if (tags.length > 0) e.tags = tags;
  if (sources.length > 0) e.sources = sources;
  if (confidence !== "") e.confidence = confidence;
  if (ttlDays !== 0) e.ttlDays = ttlDays;
  return e;
}

async function resolve(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  const [resolution, ok] = stringArg(args, "resolution");
  if (!ok || resolution === "") return errorResult("resolution is required");
  const [targetId] = stringArg(args, "targetId");
  const [status] = stringArg(args, "status");
  const [rejectedReason] = stringArg(args, "rejectedReason");
  let result: Awaited<ReturnType<MemoryReviewService["resolve"]>>;
  try {
    result = await (await reviewService(project)).resolve(candidateFromArgs(args), {
      resolution,
      targetId,
      status,
      rejectedReason,
    });
  } catch (e) {
    return errFailed("resolve memory review", e);
  }
  for (const id of result.changedIds ?? []) if (id !== "") await indexMemory(project, id);
  notifyRefresh(project.store);
  return textResult(marshalIndent(memoryResultJson(result)));
}

async function cleanup(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const args = argsOf(req);
  let [layer] = stringArg(args, "layer");
  if (layer === "") layer = "project";
  if (!validMemoryLayer(layer)) return errorResult("layer must be 'project' or 'global'");
  let olderThanDays = 7;
  const [o, ook] = intArg(args, "olderThanDays");
  if (ook && o > 0) olderThanDays = o;
  let limit = 20;
  const [l, lok] = intArg(args, "limit");
  if (lok && l > 0) limit = l;
  let entries: MemoryEntry[];
  try {
    entries = project.storage.memory.listPersistent(layer);
  } catch (e) {
    return errFailed("list memories", e);
  }
  const result = selectMemoryCleanupCandidates(entries, olderThanDays, limit, Date.now());
  return textResult(marshalIndent(result));
}

async function update(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const entry = getEntry(project, id.value);
  if (!entry) return notFound(id.value);
  const args = argsOf(req);
  const clear = stringSetArg(args, "clear");
  const [title, tok] = stringArg(args, "title");
  if (clear.has("title")) entry.title = "";
  else if (tok && title !== "") entry.title = title;
  const [content, cok] = stringArg(args, "content");
  if (clear.has("content")) delete entry.content;
  else if (cok && content !== "") entry.content = content;
  const [category, catok] = stringArg(args, "category");
  if (clear.has("category")) delete entry.category;
  else if (catok && category !== "") entry.category = category;
  const [tags, tgok] = stringSliceArg(args, "tags");
  if (tgok) entry.tags = tags;
  const [key, kok] = stringArg(args, "key");
  if (kok && key !== "") entry.key = key;

  let evidenceChanged = false;
  const [sources, sok] = stringSliceArg(args, "sources");
  if (sok) {
    entry.sources = sources;
    evidenceChanged = true;
  }
  const [confidence, cfok] = stringArg(args, "confidence");
  if (cfok && confidence !== "") {
    if (!validMemoryConfidence(confidence))
      return errorResult(`invalid confidence ${goQuote(confidence)}`);
    entry.confidence = confidence;
    evidenceChanged = true;
  }
  const [ttl, ttok] = intArg(args, "ttlDays");
  if (ttok && ttl > 0) entry.ttlDays = ttl;
  const [status, stok] = stringArg(args, "status");
  if (stok && status !== "") {
    if (!validMemoryStatus(status)) return errorResult(`invalid status ${goQuote(status)}`);
    entry.status = status;
  }
  // The gates apply only to what the caller supplied, never to what the entry already holds.
  if (catok && category !== "") {
    try {
      validateMemoryCategory(category);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
  if (cok && content !== "") {
    try {
      validatePreferenceWhy(entry.category ?? "", content);
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }
  const now = nowText();
  entry.updatedAt = now;
  const [lastVerified, lvok] = stringArg(args, "lastVerified");
  if (lvok && lastVerified !== "") {
    const parsed = parseRfc3339(lastVerified);
    if (parsed === undefined) {
      return errorResult(`lastVerified must be RFC3339, got ${goQuote(lastVerified)}`);
    }
    entry.lastVerified = parsed;
  } else if (evidenceChanged) {
    entry.lastVerified = now;
  }
  try {
    await project.storage.memory.update(entry);
  } catch (e) {
    return errFailed("update memory", e);
  }
  await indexMemory(project, entry.id);
  notifyRefresh(project.store);
  return writeResult(entry, false);
}

/** time.Parse(time.RFC3339, v): the instant, or undefined. */
function parseRfc3339(v: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

async function del(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const entry = getEntry(project, id.value);
  if (!entry) return notFound(id.value);
  const args = argsOf(req);
  let dryRun = true;
  if (Object.hasOwn(args, "dryRun") && typeof args.dryRun === "boolean") dryRun = args.dryRun;
  if (dryRun) {
    return textResult(
      marshalIndent(
        goMap({
          dryRun: true,
          message: `Would delete memory: ${entry.id} (${entry.title}, layer: ${entry.layer})`,
        }),
      ),
    );
  }
  try {
    await project.storage.memory.delete(id.value);
  } catch (e) {
    return errFailed("delete memory", e);
  }
  await removeMemory(project, id.value);
  notifyRefresh(project.store);
  return textResult(
    marshalIndent(
      goMap({ deleted: true, message: `Deleted memory: ${entry.id} (${entry.title})` }),
    ),
  );
}

async function promoteOrDemote(
  state: McpState,
  req: CallToolRequest,
  promote: boolean,
): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  let entry: MemoryEntry;
  try {
    entry = promote
      ? await project.storage.memory.promotePersistent(id.value)
      : await project.storage.memory.demotePersistent(id.value);
  } catch (e) {
    return errorResult((e as Error).message);
  }
  await indexMemory(project, entry.id);
  notifyRefresh(project.store);
  return textResult(marshalIndent(memoryJson(entry)));
}

async function confirm(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const entry = getEntry(project, id.value);
  if (!entry) return notFound(id.value);
  const now = nowText();
  entry.lastVerified = now;
  entry.updatedAt = now;
  try {
    await project.storage.memory.update(entry);
  } catch (e) {
    return errFailed("confirm memory", e);
  }
  await indexMemory(project, entry.id);
  notifyRefresh(project.store);
  return textResult(marshalIndent(memoryJson(entry)));
}

async function contradict(state: McpState, req: CallToolRequest): Promise<CallToolResult> {
  const project = state.getProject();
  if (!project) return noProjectError();
  const id = requireString(req, "id");
  if (!id.ok) return errorResult("id is required");
  const [note] = stringArg(argsOf(req), "note");
  if (note === "") {
    return errorResult("note is required: say what you observed that contradicts this memory");
  }
  const entry = getEntry(project, id.value);
  if (!entry) return notFound(id.value);
  const now = nowText();
  entry.updatedAt = now;
  entry.metadata = { ...(entry.metadata ?? {}) };
  let outcome: string;
  let needsUser: boolean;
  let explanation: string;
  if ((entry.category ?? "").trim().toLowerCase() === "preference") {
    entry.metadata["disputed.note"] = note;
    entry.metadata["disputed.at"] = rfc3339(now);
    outcome = "disputed";
    needsUser = true;
    explanation =
      "This is a preference, so it is the user's own commitment and only the user can withdraw it. The dispute is recorded and the memory stays active. Raise it with them rather than acting as though it were retired.";
  } else {
    entry.status = "stale";
    entry.metadata["disputed.note"] = note;
    entry.metadata["disputed.at"] = rfc3339(now);
    outcome = "stale";
    needsUser = false;
    explanation =
      "This is a claim about the code, which the repository settles, so it has been marked stale and will no longer be retrieved.";
  }
  entry.metadata = goMap(entry.metadata) as Record<string, string>;
  try {
    await project.storage.memory.update(entry);
  } catch (e) {
    return errFailed("contradict memory", e);
  }
  await indexMemory(project, entry.id);
  notifyRefresh(project.store);
  return textResult(marshalIndent({ outcome, needsUser, explanation, memory: memoryJson(entry) }));
}
