// internal/server/routes/memories.go
import {
  bestEffortIndexMemory,
  bestEffortRemoveMemory,
} from "../../cli/commands/memory-support.ts";
import {
  MemoryReviewService,
  memoryJson,
  memoryResultJson,
  RESULT_REVIEW_REQUIRED,
} from "../../domain/memoryreview/index.ts";
import { extract as _extract, parse } from "../../domain/references/index.ts";
import { decisionRef } from "../../models/decision.ts";
import {
  isLegacyDecisionMemoryCategory,
  LEGACY_DECISION_MEMORY_WRITE_ERROR,
  type MemoryEntry,
  validMemoryConfidence,
  validMemoryStatus,
  validPersistentMemoryLayer,
} from "../../models/memory.ts";
import type { Storage } from "../../storage/adapters.ts";
import { goNow } from "../../storage/history/go-json.ts";
import { type App, requireStore } from "../app.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { firstNonEmpty, goMap, type Obj, readStruct } from "./support.ts";

void _extract;

const memJson = (e: MemoryEntry): Obj => memoryJson(e) as Obj;

function mutationStatus(e: unknown): number {
  return e instanceof Error && e.message === LEGACY_DECISION_MEMORY_WRITE_ERROR ? 400 : 500;
}

function appendUnique(existing: readonly string[] | undefined, ...values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...(existing ?? []), ...values]) {
    if (v === "" || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function replaceSource(
  sources: readonly string[] | undefined,
  source: string,
  replacement: string,
): string[] {
  if (!sources || sources.length === 0) return [replacement];
  let replaced = false;
  const out = sources.map((s) => {
    if (s === source) {
      replaced = true;
      return replacement;
    }
    return s;
  });
  if (!replaced) out.push(replacement);
  return appendUnique(undefined, ...out);
}

const sortTime = (e: MemoryEntry): number => {
  const t = e.updatedAt && !e.updatedAt.startsWith("0001-") ? e.updatedAt : e.createdAt;
  return Date.parse(t) || 0;
};

function ttlExpired(e: MemoryEntry, now: number): boolean {
  const ttl = e.ttlDays ?? 0;
  if (ttl <= 0 || !e.lastVerified || e.lastVerified.startsWith("0001-")) return false;
  return now > Date.parse(e.lastVerified) + ttl * 24 * 3600 * 1000;
}

interface Issue {
  code: string;
  message: string;
  source?: string;
  targetId?: string;
  replacementId?: string;
}

interface ReviewCtx {
  taskIDs: Set<string>;
  docPaths: Set<string>;
  memoryIDs: Set<string>;
}

function sourceIssues(
  s: Storage,
  ctx: ReviewCtx,
  source: string,
): { issues: Issue[]; repairs: Obj[] } {
  const none = { issues: [], repairs: [] };
  const ref = parse(source);
  if (!ref) return none;
  const broken = (target: string) => ({
    issues: [
      {
        code: "MEMORY_BROKEN_SOURCE_REF",
        message: "Memory source reference is broken",
        source: source.trim(),
        targetId: target,
      },
    ],
    repairs: [],
  });
  switch (ref.type) {
    case "task":
      return ctx.taskIDs.has(ref.target) ? none : broken(ref.target);
    case "doc":
      return ctx.docPaths.has(ref.target) ? none : broken(ref.target);
    case "memory":
      return ctx.memoryIDs.has(ref.target) ? none : broken(ref.target);
    case "decision": {
      let d: import("../../models/decision.ts").DecisionEntry;
      try {
        d = s.decisions.get(ref.target);
      } catch {
        return broken(ref.target);
      }
      const by = d.supersededBy ?? [];
      if (d.status === "superseded" || by.length > 0) {
        const replacementID = by[0] ?? "";
        const issue: Issue = {
          code: "MEMORY_SOURCE_DECISION_SUPERSEDED",
          message: "Memory source decision is superseded",
          source,
          targetId: ref.target,
        };
        if (replacementID) issue.replacementId = replacementID;
        if (replacementID === "") return { issues: [issue], repairs: [] };
        return {
          issues: [issue],
          repairs: [
            {
              source,
              replacement: decisionRef(replacementID),
              decisionId: ref.target,
              replacementDecisionId: replacementID,
            },
          ],
        };
      }
      return none;
    }
    default:
      return none;
  }
}

export function registerMemories(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const broadcast = (type: string, data: unknown) => app.sse.broadcast({ type, data });

  const lookup = (id: string): MemoryEntry | undefined => {
    try {
      const e = app.need().memory.get(id);
      return validPersistentMemoryLayer(e.layer) ? e : undefined;
    } catch {
      return undefined;
    }
  };

  r.get(
    "/api/memories",
    guard((c) => {
      const s = app.need();
      const layer = c.query("layer");
      const category = c.query("category");
      const tag = c.query("tag");
      if (layer !== "" && !validPersistentMemoryLayer(layer)) {
        return respondError(400, "invalid layer: must be project or global");
      }
      let entries: MemoryEntry[];
      try {
        entries = s.memory.listPersistent(layer);
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      if (category !== "") entries = entries.filter((e) => (e.category ?? "") === category);
      if (tag !== "") entries = entries.filter((e) => (e.tags ?? []).includes(tag));
      return jsonResponse(200, entries.map(memJson));
    }),
  );

  r.post(
    "/api/memories",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "createMemoryRequest",
        {
          title: "string",
          content: "string",
          layer: "string",
          category: "string",
          status: "string",
          confidence: "string",
          ttlDays: "int",
          sources: "strings",
          tags: "strings",
          metadata: "stringMap",
          skipReview: "bool",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      const layer = (v.layer as string | undefined) || "project";
      if (!validPersistentMemoryLayer(layer)) {
        return respondError(400, "invalid layer: must be project or global");
      }
      const now = goNow();
      const skipReview = v.skipReview === true;
      const entry: MemoryEntry = {
        id: "",
        title: (v.title as string | undefined) ?? "",
        layer,
        createdAt: now,
        updatedAt: now,
      };
      const set = <K extends keyof MemoryEntry>(k: K, val: MemoryEntry[K] | undefined) => {
        if (val !== undefined && val !== "" && val !== 0) entry[k] = val;
      };
      set("content", v.content as string | undefined);
      set("category", v.category as string | undefined);
      set("status", v.status as string | undefined);
      set("confidence", v.confidence as string | undefined);
      set("ttlDays", v.ttlDays as number | undefined);
      entry.sources = (v.sources as string[] | undefined) ?? [];
      entry.tags = (v.tags as string[] | undefined) ?? [];
      if (v.metadata) entry.metadata = { ...(v.metadata as Record<string, string>) };
      if (skipReview) {
        entry.metadata ??= {};
        entry.metadata.reviewOverride = "create_anyway";
      }
      const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
      try {
        const result = await new MemoryReviewService(s, {
          searchEnv: buildSearchEnvironment(),
        }).add(entry, {
          skipReview,
          status: (v.status as string | undefined) ?? "",
        });
        if (result.status === RESULT_REVIEW_REQUIRED) {
          return jsonResponse(409, memoryResultJson(result));
        }
        for (const id of result.changedIds ?? []) if (id) await bestEffortIndexMemory(s, id);
        broadcast("memories:created", { memory: memJson(result.memory as MemoryEntry) });
        return jsonResponse(201, memJson(result.memory as MemoryEntry));
      } catch (e) {
        return respondError(mutationStatus(e), errMessage(e));
      }
    }),
  );

  r.get(
    "/api/memories/review",
    guard(async () => {
      const s = app.need();
      let entries: MemoryEntry[];
      try {
        entries = s.memory.listPersistent("");
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      entries = [...entries].sort((a, b) => sortTime(b) - sortTime(a));
      const ctx: ReviewCtx = { taskIDs: new Set(), docPaths: new Set(), memoryIDs: new Set() };
      try {
        for (const t of s.tasks.listAll()) ctx.taskIDs.add(t.id);
      } catch {
        // ignored, as in Go
      }
      try {
        for (const d of s.docs.list()) ctx.docPaths.add(d.path);
      } catch {
        // ignored
      }
      for (const e of entries) ctx.memoryIDs.add(e.id);
      const counts: Record<string, number> = {
        proposed: 0,
        duplicate_review: 0,
        stale_ttl: 0,
        missing_source: 0,
        source_missing: 0,
        source_decision_superseded: 0,
      };
      const items: Obj[] = [];
      const now = Date.now();
      for (const entry of entries) {
        const reasons: string[] = [];
        const add = (reason: string) => {
          if (!reasons.includes(reason)) reasons.push(reason);
        };
        const issues: Issue[] = [];
        const repairs: Obj[] = [];
        let matches: ReturnType<typeof memoryResultJson>["matches"];
        if (entry.status === "proposed") {
          add("proposed");
          try {
            const review = await new MemoryReviewService(s, {
              entries,
              semanticSearch: () => [],
            }).review(entry);
            if (review && (review.matches?.length ?? 0) > 0) {
              matches = memoryResultJson({ status: "created", matches: review.matches }).matches;
              add("duplicate_review");
            }
          } catch {
            // err != nil is skipped
          }
        }
        if (entry.status === "stale" || ttlExpired(entry, now)) {
          add("stale_ttl");
          issues.push({
            code: "MEMORY_TTL_EXPIRED",
            message: "Memory TTL is expired or marked stale",
          });
        }
        if ((entry.sources ?? []).length === 0) {
          add("missing_source");
          issues.push({
            code: "MEMORY_MISSING_SOURCE",
            message: "Memory has no source references",
          });
        } else {
          for (const source of entry.sources ?? []) {
            const res = sourceIssues(s, ctx, source);
            for (const issue of res.issues) {
              issues.push(issue);
              add(
                issue.code === "MEMORY_SOURCE_DECISION_SUPERSEDED"
                  ? "source_decision_superseded"
                  : "source_missing",
              );
            }
            repairs.push(...res.repairs);
          }
        }
        if (reasons.length === 0) continue;
        for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
        const item: Obj = { memory: memJson(entry), reasons };
        if (issues.length > 0) item.issues = issues;
        if (matches) item.matches = matches;
        if (repairs.length > 0) item.repairSources = repairs;
        items.push(item);
      }
      return jsonResponse(200, { memories: entries.map(memJson), items, counts: goMap(counts) });
    }),
  );

  r.post(
    "/api/memories/review/resolve",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "resolveMemoryReviewRequest",
        {
          resolution: "string",
          targetId: "string",
          status: "string",
          id: "string",
          title: "string",
          content: "string",
          layer: "string",
          category: "string",
          tags: "strings",
          sources: "strings",
          confidence: "string",
          ttlDays: "int",
          rejectedReason: "string",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      const resolution = (v.resolution as string | undefined) ?? "";
      if (resolution === "") return respondError(400, "resolution is required");
      const candidate: MemoryEntry = {
        id: (v.id as string | undefined) ?? "",
        title: (v.title as string | undefined) ?? "",
        layer: (v.layer as string | undefined) ?? "",
        createdAt: "0001-01-01T00:00:00Z",
        updatedAt: "0001-01-01T00:00:00Z",
      };
      for (const k of ["content", "category", "confidence"] as const) {
        if (v[k]) candidate[k] = v[k] as string;
      }
      if (v.tags !== undefined) candidate.tags = v.tags as string[];
      if (v.sources !== undefined) candidate.sources = v.sources as string[];
      if (v.ttlDays) candidate.ttlDays = v.ttlDays as number;
      const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
      try {
        const result = await new MemoryReviewService(s, {
          searchEnv: buildSearchEnvironment(),
        }).resolve(candidate, {
          resolution,
          targetId: (v.targetId as string | undefined) ?? "",
          status: (v.status as string | undefined) ?? "",
          rejectedReason: (v.rejectedReason as string | undefined) ?? "",
        });
        for (const id of result.changedIds ?? []) if (id) await bestEffortIndexMemory(s, id);
        broadcast("memories:updated", { result: memoryResultJson(result) });
        return jsonResponse(200, memoryResultJson(result));
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/memories/bulk",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "bulkMemoryActionRequest",
        { action: "string", ids: "strings", rejectedReason: "string" },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const ids = (body.v.ids as string[] | undefined) ?? [];
      const action = (body.v.action as string | undefined) ?? "";
      if (ids.length === 0) return respondError(400, "ids are required");
      if (action !== "verify" && action !== "archive" && action !== "reject_proposed") {
        return respondError(400, "unsupported bulk memory action");
      }
      const entries: MemoryEntry[] = [];
      for (const id of ids) {
        const e = lookup(id);
        if (!e) return respondError(404, `memory not found: ${id}`);
        if (action === "reject_proposed" && e.status !== "proposed") {
          return respondError(400, "reject_proposed can only target proposed memories");
        }
        if (isLegacyDecisionMemoryCategory(e.category ?? "") && action === "verify") {
          return respondError(400, LEGACY_DECISION_MEMORY_WRITE_ERROR);
        }
        entries.push(e);
      }
      const now = goNow();
      const updated: MemoryEntry[] = [];
      for (const e of entries) {
        if (action === "verify") {
          e.status = "active";
          e.lastVerified = now;
        } else if (action === "archive") e.status = "archived";
        else {
          e.status = "rejected";
          e.rejectedReason = firstNonEmpty(
            (body.v.rejectedReason as string | undefined) ?? "",
            "rejected_by_review",
          );
        }
        e.updatedAt = now;
        try {
          await s.memory.update(e);
        } catch (err) {
          return respondError(mutationStatus(err), errMessage(err));
        }
        await bestEffortIndexMemory(s, e.id);
        updated.push(e);
      }
      broadcast("memories:updated", { bulk: true, count: updated.length });
      return jsonResponse(200, { count: updated.length, updated: updated.map(memJson) });
    }),
  );

  r.get(
    "/api/memories/{id}",
    guard((c) => {
      const e = lookup(c.params.id as string);
      return e ? jsonResponse(200, memJson(e)) : respondError(404, "memory not found");
    }),
  );

  r.put(
    "/api/memories/{id}",
    guard(async (c) => {
      const s = app.need();
      const entry = lookup(c.params.id as string);
      if (!entry) return respondError(404, "memory not found");
      const body = await readStruct(
        c,
        "updateMemoryRequest",
        {
          title: "string",
          content: "string",
          category: "string",
          status: "string",
          confidence: "string",
          ttlDays: "int",
          sources: "strings",
          tags: "strings",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      const set = (k: "title" | "content" | "category") => {
        if (v[k] !== undefined) {
          if (k === "title") entry.title = v[k] as string;
          else if (v[k] === "") delete entry[k];
          else entry[k] = v[k] as string;
        }
      };
      set("title");
      set("content");
      set("category");
      if (v.status !== undefined) {
        if (!validMemoryStatus(v.status as string))
          return respondError(400, "invalid memory status");
        entry.status = v.status as string;
      }
      if (v.confidence !== undefined) {
        if (v.confidence !== "" && !validMemoryConfidence(v.confidence as string)) {
          return respondError(400, "invalid memory confidence");
        }
        if (v.confidence === "") delete entry.confidence;
        else entry.confidence = v.confidence as string;
      }
      if (v.ttlDays !== undefined) {
        if ((v.ttlDays as number) < 0) return respondError(400, "ttlDays must be non-negative");
        if (v.ttlDays === 0) delete entry.ttlDays;
        else entry.ttlDays = v.ttlDays as number;
      }
      if (v.sources !== undefined) entry.sources = v.sources as string[];
      if (v.tags !== undefined) entry.tags = v.tags as string[];
      entry.updatedAt = goNow();
      try {
        await s.memory.update(entry);
      } catch (e) {
        return respondError(mutationStatus(e), errMessage(e));
      }
      await bestEffortIndexMemory(s, entry.id);
      broadcast("memories:updated", { memory: memJson(entry) });
      return jsonResponse(200, memJson(entry));
    }),
  );

  r.delete(
    "/api/memories/{id}",
    guard(async (c) => {
      const s = app.need();
      const id = c.params.id as string;
      if (!lookup(id)) return respondError(404, "memory not found");
      try {
        await s.memory.delete(id);
      } catch (e) {
        return respondError(mutationStatus(e), errMessage(e));
      }
      await bestEffortRemoveMemory(s, id);
      return jsonResponse(200, { deleted: true, id });
    }),
  );

  r.post(
    "/api/memories/{id}/action",
    guard(async (c) => {
      const s = app.need();
      const entry = lookup(c.params.id as string);
      if (!entry) return respondError(404, "memory not found");
      const body = await readStruct(
        c,
        "memoryActionRequest",
        {
          action: "string",
          sources: "strings",
          source: "string",
          replacement: "string",
          rejectedReason: "string",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      const now = goNow();
      switch (v.action) {
        case "verify":
          entry.status = "active";
          entry.lastVerified = now;
          if (v.sources !== undefined) entry.sources = v.sources as string[];
          break;
        case "archive":
          entry.status = "archived";
          break;
        case "reject":
          entry.status = "rejected";
          entry.rejectedReason = firstNonEmpty(
            (v.rejectedReason as string | undefined) ?? "",
            "rejected_by_review",
          );
          break;
        case "link_source":
          entry.sources = appendUnique(
            entry.sources,
            ...((v.sources as string[] | undefined) ?? []),
          );
          entry.lastVerified = now;
          break;
        case "repair_source":
          if (!v.source || !v.replacement)
            return respondError(400, "source and replacement are required");
          entry.sources = replaceSource(entry.sources, v.source as string, v.replacement as string);
          entry.lastVerified = now;
          break;
        default:
          return respondError(400, "unsupported memory action");
      }
      entry.updatedAt = now;
      try {
        await s.memory.update(entry);
      } catch (e) {
        return respondError(mutationStatus(e), errMessage(e));
      }
      await bestEffortIndexMemory(s, entry.id);
      broadcast("memories:updated", { memory: memJson(entry) });
      return jsonResponse(200, memJson(entry));
    }),
  );

  for (const [name, fn] of [
    ["promote", "promotePersistent"],
    ["demote", "demotePersistent"],
  ] as const) {
    r.post(
      `/api/memories/{id}/${name}`,
      guard(async (c) => {
        const s = app.need();
        try {
          const entry = await s.memory[fn](c.params.id as string);
          await bestEffortIndexMemory(s, entry.id);
          return jsonResponse(200, memJson(entry));
        } catch (e) {
          return respondError(400, errMessage(e));
        }
      }),
    );
  }
}
