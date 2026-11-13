// internal/server/routes/decisions.go
import { bestEffortIndexDecision } from "../../cli/commands/memory-support.ts";
import {
  applyResultJson,
  DecisionMigrationService,
  MigrationApplyError,
  previewReportJson,
  rollbackResultJson,
  type Selection,
} from "../../domain/decisionmigration/index.ts";
import {
  DecisionReviewService,
  decisionJson,
  decisionResultJson,
  RESULT_REVIEW_REQUIRED,
} from "../../domain/decisionreview/index.ts";
import {
  type DecisionEntry,
  decisionCurrentForDefaultRetrieval,
  validDecisionStatus,
} from "../../models/decision.ts";
import { type App, requireStore } from "../app.ts";
import { type FieldType, jsonKind } from "../gojson.ts";
import { errMessage, jsonResponse, type Router, respondError } from "../http.ts";
import { type Obj, readStruct } from "./support.ts";

const dec = (d: DecisionEntry): Obj => decisionJson(d) as Obj;

const SELECTION: FieldType = {
  array: {
    custom: (v) => jsonKind(v) === "object",
    goName: "decisionmigration.Selection",
  },
  goName: "[]decisionmigration.Selection",
};

function selectionOf(o: Obj): Selection {
  const s: Selection = {
    memoryId: (o.memoryId as string | undefined) ?? "",
    resolution: (o.resolution as string | undefined) ?? "",
  };
  if (o.decisionId) s.decisionId = o.decisionId as string;
  if (o.targetMemoryId) s.targetMemoryId = o.targetMemoryId as string;
  if (o.category) s.category = o.category as string;
  if (o.reason) s.reason = o.reason as string;
  if (Array.isArray(o.relatedDocs)) s.relatedDocs = o.relatedDocs as string[];
  if (Array.isArray(o.relatedTasks)) s.relatedTasks = o.relatedTasks as string[];
  if (o.acceptVerified === true) s.acceptVerified = true;
  return s;
}

function entryFrom(v: Obj, withId: boolean): DecisionEntry {
  const e: DecisionEntry = {
    id: withId ? ((v.id as string | undefined) ?? "") : "",
    title: (v.title as string | undefined) ?? "",
    status: (v.status as string | undefined) ?? "",
    createdAt: "",
    updatedAt: "",
  };
  for (const k of ["tags", "sources", "relatedDocs", "relatedTasks"] as const) {
    if (v[k] !== undefined) e[k] = v[k] as string[];
  }
  if (v.body) e.content = v.body as string;
  for (const k of ["context", "decision", "alternativesConsidered", "consequences"] as const) {
    if (v[k]) e[k] = v[k] as string;
  }
  return e;
}

export function registerDecisions(r: Router, app: App): void {
  const guard = (h: Parameters<typeof requireStore>[1]) => requireStore(app, h);
  const broadcast = (type: string, data: unknown) => app.sse.broadcast({ type, data });
  const service = async () => {
    const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
    return new DecisionReviewService(app.need(), { searchEnv: buildSearchEnvironment() });
  };

  r.get(
    "/api/decisions/migration/preview",
    guard(() => {
      try {
        return jsonResponse(
          200,
          previewReportJson(new DecisionMigrationService(app.need()).preview()),
        );
      } catch (e) {
        return respondError(409, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/decisions/migration/apply",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "decisionMigrationApplyRequest",
        { selections: SELECTION },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const selections = ((body.v.selections as Obj[] | undefined) ?? []).map(selectionOf);
      if (selections.length === 0) {
        return respondError(
          400,
          "at least one explicitly reviewed migration selection is required",
        );
      }
      try {
        const result = await new DecisionMigrationService(s).apply(selections);
        for (const item of result.results)
          if (item.decisionId) await bestEffortIndexDecision(s, item.decisionId);
        broadcast("decisions:migrated", { result: applyResultJson(result) });
        return jsonResponse(200, applyResultJson(result));
      } catch (e) {
        const result = e instanceof MigrationApplyError ? applyResultJson(e.result) : null;
        return jsonResponse(409, { error: errMessage(e), result });
      }
    }),
  );

  r.post(
    "/api/decisions/migration/{memoryID}/rollback",
    guard(async (c) => {
      const s = app.need();
      try {
        const result = await new DecisionMigrationService(s).rollback(c.params.memoryID as string);
        if (result.decisionId) await bestEffortIndexDecision(s, result.decisionId);
        broadcast("decisions:migration-rolled-back", { result: rollbackResultJson(result) });
        return jsonResponse(200, rollbackResultJson(result));
      } catch (e) {
        return respondError(409, errMessage(e));
      }
    }),
  );

  r.get(
    "/api/decisions",
    guard((c) => {
      const status = c.query("status");
      const tag = c.query("tag");
      const includeAll = c.query("includeAll") === "true" || c.query("all") === "true";
      if (status !== "" && !validDecisionStatus(status))
        return respondError(400, "invalid decision status");
      let decisions: DecisionEntry[];
      try {
        decisions = app.need().decisions.list();
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      const out = decisions.filter((d) => {
        if (status !== "") {
          if (d.status !== status) return false;
        } else if (!includeAll && !decisionCurrentForDefaultRetrieval(d)) return false;
        return tag === "" || (d.tags ?? []).includes(tag);
      });
      return jsonResponse(200, out.map(dec));
    }),
  );

  r.post(
    "/api/decisions",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "createDecisionRequest",
        {
          title: "string",
          status: "string",
          tags: "strings",
          sources: "strings",
          relatedDocs: "strings",
          relatedTasks: "strings",
          body: "string",
          context: "string",
          decision: "string",
          alternativesConsidered: "string",
          consequences: "string",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      if (!v.title) return respondError(400, "title is required");
      if (v.status && !validDecisionStatus(v.status as string))
        return respondError(400, "invalid decision status");
      let result: Awaited<ReturnType<DecisionReviewService["add"]>>;
      try {
        result = await (await service()).add(entryFrom(v, false), {});
      } catch (e) {
        return respondError(500, errMessage(e));
      }
      if (result.status === RESULT_REVIEW_REQUIRED) {
        if (result.candidate) await bestEffortIndexDecision(s, result.candidate.id);
        broadcast("decisions:review-required", { result: decisionResultJson(result) });
        return jsonResponse(409, decisionResultJson(result));
      }
      const decision = result.decision as DecisionEntry;
      await bestEffortIndexDecision(s, decision.id);
      broadcast("decisions:created", { decision: dec(decision) });
      return jsonResponse(201, dec(decision));
    }),
  );

  r.get(
    "/api/decisions/review/inbox",
    guard(async () => {
      try {
        const candidates = await (await service()).reviewCandidates();
        return jsonResponse(200, candidates.map(dec));
      } catch (e) {
        return respondError(500, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/decisions/review/resolve",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "resolveDecisionReviewRequest",
        {
          resolution: "string",
          candidateId: "string",
          targetId: "string",
          replacementId: "string",
          status: "string",
          id: "string",
          title: "string",
          tags: "strings",
          sources: "strings",
          relatedDocs: "strings",
          relatedTasks: "strings",
          body: "string",
          context: "string",
          decision: "string",
          alternativesConsidered: "string",
          consequences: "string",
        },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      if (!v.resolution) return respondError(400, "resolution is required");
      try {
        const result = await (await service()).resolve(entryFrom(v, true), {
          candidateId: (v.candidateId as string | undefined) ?? "",
          resolution: v.resolution as string,
          targetId: (v.targetId as string | undefined) ?? "",
          replacementId: (v.replacementId as string | undefined) ?? "",
          status: (v.status as string | undefined) ?? "",
        });
        for (const id of result.changedIds ?? []) await bestEffortIndexDecision(s, id);
        if ((result.changedIds ?? []).length > 0) {
          broadcast("decisions:updated", { result: decisionResultJson(result) });
        }
        return jsonResponse(200, decisionResultJson(result));
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );

  r.get(
    "/api/decisions/{id}",
    guard((c) => {
      try {
        return jsonResponse(200, dec(app.need().decisions.get(c.params.id as string)));
      } catch {
        return respondError(404, "decision not found");
      }
    }),
  );

  r.post(
    "/api/decisions/{id}/link",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(
        c,
        "linkDecisionRequest",
        { sources: "strings", relatedDocs: "strings", relatedTasks: "strings" },
        "",
      );
      if (!body.ok) return respondError(400, "invalid request body");
      const v = body.v;
      try {
        let decision = await s.decisions.link(
          c.params.id as string,
          (v.relatedDocs as string[] | undefined) ?? [],
          (v.relatedTasks as string[] | undefined) ?? [],
          (v.sources as string[] | undefined) ?? [],
        );
        if (decision.status === "draft")
          decision = await (await service()).refreshCandidate(decision.id);
        await bestEffortIndexDecision(s, decision.id);
        broadcast("decisions:updated", { decision: dec(decision) });
        return jsonResponse(200, dec(decision));
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/decisions/{id}/supersede",
    guard(async (c) => {
      const s = app.need();
      const body = await readStruct(c, "supersedeDecisionRequest", { newId: "string" }, "");
      if (!body.ok) return respondError(400, "invalid request body");
      try {
        const pair = await s.decisions.supersede(
          c.params.id as string,
          (body.v.newId as string | undefined) ?? "",
        );
        await bestEffortIndexDecision(s, pair.old.id);
        await bestEffortIndexDecision(s, pair.next.id);
        broadcast("decisions:updated", { current: dec(pair.next), superseded: dec(pair.old) });
        return jsonResponse(200, { current: dec(pair.next), superseded: dec(pair.old) });
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );

  r.post(
    "/api/decisions/{id}/accept",
    guard(async (c) => {
      const s = app.need();
      // Go reads the body whenever one is set; an empty body is an EOF error there too.
      const body = await readStruct(c, "acceptDecisionRequest", { supersedes: "strings" }, "");
      if (!body.ok) return respondError(400, "invalid request body");
      try {
        const result = await (await service()).accept(c.params.id as string, {
          supersedes: (body.v.supersedes as string[] | undefined) ?? [],
        });
        for (const id of result.changedIds ?? []) await bestEffortIndexDecision(s, id);
        broadcast("decisions:updated", { result: decisionResultJson(result) });
        return jsonResponse(200, decisionResultJson(result));
      } catch (e) {
        return respondError(400, errMessage(e));
      }
    }),
  );
}
