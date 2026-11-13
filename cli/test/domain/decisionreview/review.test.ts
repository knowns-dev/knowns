import { afterAll, describe, expect, test } from "bun:test";
import {
  ALLOWED_RESOLUTIONS,
  canonicalDecisionHash,
  DecisionReviewService,
  decisionJson,
  decisionResultJson,
  decisionReviewIsStale,
  lexicalScore,
  normalizeRelatedDocPath,
  normalizeRelatedTaskIds,
  READY_RESOLUTIONS,
} from "../../../src/domain/decisionreview/index.ts";
import type { DecisionEntry } from "../../../src/models/decision.ts";
import { cleanupLabs, lab } from "../world.ts";

afterAll(cleanupLabs);

const BUN = "20261103-1337-use-bun-for-everything";
const MONO = "20261103-1337-adopt-a-monorepo";

const cand = (title: string, extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: "",
  title,
  status: "",
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const evidence = { sources: ["@doc/architecture"], relatedTasks: ["FX-3VT2SR"] };
const NOW = new Date("2026-11-04T09:00:00.000Z");

describe("DecisionReviewService.add", () => {
  test("no match and no evidence persists a needs_evidence draft", async () => {
    const l = lab();
    const r = await new DecisionReviewService(l.storage, { now: () => NOW }).add(
      cand("Brand new topic", { decision: "x" }),
    );
    expect(r.status).toBe("created");
    const d = l.storage.decisions.get(r.decision?.id as string);
    expect(d.status).toBe("draft");
    expect(d.reviewState).toBe("needs_evidence");
    expect(d.reviewBlockers?.[0]).toContain("needs at least one source");
    expect(d.reviewBlockers?.[0]).not.toContain('decision ""');
    expect(decisionReviewIsStale(d)).toBe(false);
  });

  test("verified evidence and no match is ready_for_review with the ready resolutions", async () => {
    const l = lab();
    const r = await new DecisionReviewService(l.storage).add(
      cand("Brand new topic", { decision: "x", ...evidence }),
    );
    const d = l.storage.decisions.get(r.decision?.id as string);
    expect(d.reviewState).toBe("ready_for_review");
    expect(d.reviewAllowedResolutions).toEqual([...READY_RESOLUTIONS]);
    expect(d.reviewEvaluatedHash).toBe(canonicalDecisionHash(d));
  });

  test("a duplicate of current guidance needs resolution and reports the match hash", async () => {
    const l = lab();
    const r = await new DecisionReviewService(l.storage).add(
      cand("Use bun for everything", { decision: "Bun everywhere", ...evidence }),
    );
    expect(r.status).toBe("review_required");
    expect(r.matches?.[0]?.id).toBe(BUN);
    expect(r.matches?.[0]?.kind).toBe("duplicate");
    expect(r.matches?.[0]?.hash).toBe(canonicalDecisionHash(l.storage.decisions.get(BUN)));
    expect(r.allowedResolutions).toEqual([...ALLOWED_RESOLUTIONS]);
    const d = l.storage.decisions.get(r.decision?.id as string);
    expect(d.reviewState).toBe("needs_resolution");
    expect(d.reviewMatches?.[0]?.id).toBe(BUN);
  });

  test("shared topic words with different text are a conflict", () => {
    const [score, kind, reasons] = lexicalScore(
      cand("Bun runtime for scripts everywhere"),
      cand("Use bun for scripts"),
    );
    expect(kind).toBe("conflict");
    expect(reasons).toContain("lexical:conflict_topic");
    expect(score).toBeGreaterThanOrEqual(0.82);
  });

  test("direct acceptance and bad input are rejected", async () => {
    const svc = new DecisionReviewService(lab().storage);
    await expect(svc.add(cand("x", { status: "accepted" }))).rejects.toThrow("must start as draft");
    await expect(svc.add(cand(" "))).rejects.toThrow("decision title is required");
    await expect(svc.add(cand("x", { status: "nope" }))).rejects.toThrow(
      'invalid decision status: "nope"',
    );
    await expect(svc.add(cand("x", { id: "bad id" }))).rejects.toThrow(
      'invalid decision ID: "bad id"',
    );
  });

  test("skipReview writes no review metadata", async () => {
    const l = lab();
    const r = await new DecisionReviewService(l.storage).add(cand("Quick one"), {
      skipReview: true,
    });
    expect(l.storage.decisions.get(r.decision?.id as string).reviewState).toBeUndefined();
  });

  test("the stubbed semantic leg contributes matches; its failure does not break review", async () => {
    const l = lab();
    const hit = await new DecisionReviewService(l.storage, {
      semanticSearch: () => [
        {
          id: BUN,
          title: "Use bun for everything",
          score: 0.9,
          kind: "duplicate",
          matchedBy: ["semantic"],
        },
      ],
    }).review(cand("Something worded differently"));
    expect(hit?.matches?.[0]?.matchedBy).toEqual(["semantic"]);
    const miss = await new DecisionReviewService(l.storage, {
      semanticSearch: () => {
        throw new Error("down");
      },
    }).review(cand("Something worded differently"));
    expect(miss).toBeUndefined();
  });
});

describe("accept and resolve", () => {
  test("accept requires evidence, done tasks and resolution of matches", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    await expect(svc.accept(MONO)).rejects.toThrow("needs at least one source before acceptance");
    expect(l.storage.decisions.get(MONO).reviewState).toBe("needs_evidence");
    await l.storage.decisions.link(MONO, [], ["FX-3VT2SR"], ["@doc/architecture"]);
    const r = await svc.accept(MONO);
    expect(r.decision?.status).toBe("accepted");
    expect(r.decision?.verification).toEqual([
      "source:@doc/architecture",
      "task:@task-FX-3VT2SR:done",
    ]);
    expect(r.changedIds).toEqual([MONO]);
  });

  test("a task that is not done blocks acceptance", async () => {
    const l = lab();
    const open = l.storage.tasks.listAll().find((t) => t.status !== "done");
    if (!open) throw new Error("fixture has no open task");
    await l.storage.decisions.link(MONO, [], [open.id], ["@doc/architecture"]);
    await expect(new DecisionReviewService(l.storage).accept(MONO)).rejects.toThrow(
      `linked task "${open.id}" is "${open.status}"`,
    );
  });

  test("a source that cannot be read blocks acceptance", async () => {
    const l = lab();
    await l.storage.decisions.link(MONO, [], ["FX-3VT2SR"], ["@doc/does-not-exist"]);
    await expect(new DecisionReviewService(l.storage).accept(MONO)).rejects.toThrow(
      'source "@doc/does-not-exist" is not readable',
    );
  });

  test("resolve link_as_related transfers provenance and rejects the duplicate", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(
      cand("Use bun for everything", { decision: "Bun everywhere", ...evidence }),
    );
    const id = added.decision?.id as string;
    const r = await svc.resolve(undefined, {
      candidateId: id,
      resolution: "link_as_related",
      targetId: BUN,
    });
    expect(r.decision?.status).toBe("rejected");
    expect(r.current?.sources).toContain(`@decision/${id}`);
    // idempotent
    const again = await svc.resolve(undefined, {
      candidateId: id,
      resolution: "link_as_related",
      targetId: BUN,
    });
    expect(again.decision?.status).toBe("rejected");
  });

  test("resolve supersede_existing replaces the current decision", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(
      cand("Use bun for everything", { decision: "Bun everywhere", ...evidence }),
    );
    const id = added.decision?.id as string;
    await expect(
      svc.resolve(undefined, { candidateId: id, resolution: "supersede_existing", targetId: MONO }),
    ).rejects.toThrow("is not a persisted review match");
    const r = await svc.resolve(undefined, {
      candidateId: id,
      resolution: "supersede_existing",
      targetId: BUN,
    });
    expect(r.decision?.status).toBe("accepted");
    expect(r.superseded?.id).toBe(BUN);
    expect(l.storage.decisions.get(BUN).status).toBe("superseded");
    expect(r.changedIds).toEqual([id, BUN]);
  });

  test("accept_new needs ready_for_review", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    await expect(
      svc.resolve(undefined, { candidateId: MONO, resolution: "accept_new" }),
    ).rejects.toThrow("accept_new requires ready_for_review");
    const added = await svc.add(cand("Brand new topic", { decision: "x", ...evidence }));
    const r = await svc.resolve(undefined, {
      candidateId: added.decision?.id as string,
      resolution: "accept_new",
    });
    expect(r.resolution).toBe("accept_new");
    expect(r.decision?.status).toBe("accepted");
  });

  test("reject_new is idempotent; create_draft keeps the draft pending", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const a = await svc.resolve(undefined, { candidateId: MONO, resolution: "reject_new" });
    const b = await svc.resolve(undefined, { candidateId: MONO, resolution: "reject_new" });
    expect(a.decision?.status).toBe("rejected");
    expect(b.decision?.status).toBe("rejected");
    await expect(
      svc.resolve(undefined, { candidateId: MONO, resolution: "create_draft" }),
    ).rejects.toThrow("is not a draft candidate");
    const draft = await svc.add(cand("Pending thing"));
    const c = await svc.resolve(undefined, {
      candidateId: draft.decision?.id as string,
      resolution: "create_draft",
    });
    expect(c.pendingVerification).toBe(true);
  });

  test("an unpersisted candidate can be resolved directly", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const created = await svc.resolve(cand("Direct draft"), { resolution: "create_draft" });
    expect(created.decision?.status).toBe("draft");
    const rejected = await svc.resolve(cand("Direct reject"), { resolution: "reject_new" });
    expect(rejected.decision?.status).toBe("rejected");
    const linked = await svc.resolve(cand("Direct link"), {
      resolution: "link_as_related",
      targetId: BUN,
    });
    expect(linked.decision?.sources).toContain(`@decision/${BUN}`);
    const sup = await svc.resolve(cand("Direct supersede"), {
      resolution: "supersede_existing",
      targetId: BUN,
    });
    expect(sup.pendingVerification).toBe(true);
    expect(sup.current?.id).toBe(BUN);
    await expect(svc.resolve(cand("x"), { resolution: "bogus" })).rejects.toThrow(
      "unsupported decision review resolution: bogus",
    );
    await expect(svc.resolve(cand("x"), { resolution: "" })).rejects.toThrow(
      "resolution is required",
    );
  });
});

describe("inbox and staleness", () => {
  test("reviewCandidates refreshes unreviewed drafts and skips legacy migration drafts", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    await svc.add(cand("Tagged legacy", { tags: ["legacy-memory-migration"] }), {
      skipReview: true,
    });
    await svc.add(cand("Plain draft"), { skipReview: true });
    const ids = (await svc.reviewCandidates()).map((d) => d.title);
    expect(ids).toContain("Plain draft");
    expect(ids).toContain("Adopt a monorepo");
    expect(ids).not.toContain("Tagged legacy");
  });

  test("editing a reviewed draft makes its review stale", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(cand("Stale soon", { decision: "x" }));
    const id = added.decision?.id as string;
    expect(decisionReviewIsStale(l.storage.decisions.get(id))).toBe(false);
    await l.storage.decisions.link(id, [], [], ["@doc/architecture"]);
    expect(decisionReviewIsStale(l.storage.decisions.get(id))).toBe(true);
    expect(decisionReviewIsStale(await svc.refreshCandidate(id))).toBe(false);
  });

  test("the fixture's Go-written review hash is reproduced", () => {
    const d = lab().storage.decisions.get(MONO);
    expect(d.reviewEvaluatedHash).toBe(canonicalDecisionHash(d));
  });
});

describe("helpers and shapes", () => {
  test("related ids and doc paths are normalised like Go", () => {
    expect(normalizeRelatedTaskIds(["@task-a", "@task/b", "task-c", "d", " ", "@task-a"])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(normalizeRelatedDocPath("@doc/specs/x.md")).toBe("specs/x");
    expect(normalizeRelatedDocPath("/guides/y")).toBe("guides/y");
  });

  test("decisions and results marshal in Go field order", () => {
    const d = decisionJson({
      id: "i",
      title: "t",
      status: "draft",
      tags: [],
      reviewMatches: [{ id: "m", title: "mt", score: 0.5, hash: "h" }],
      createdAt: "c",
      updatedAt: "u",
      decision: "x",
    });
    expect(Object.keys(d)).toEqual([
      "id",
      "title",
      "status",
      "reviewMatches",
      "createdAt",
      "updatedAt",
      "decision",
    ]);
    expect(Object.keys((d.reviewMatches as object[])[0] as object)).toEqual([
      "id",
      "title",
      "score",
      "hash",
    ]);
    expect(
      Object.keys(
        decisionResultJson({ status: "resolved", changedIds: ["a"], pendingVerification: true }),
      ),
    ).toEqual(["status", "changedIds", "pendingVerification"]);
  });
});
