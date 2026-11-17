// KN-PRGZMS: a reviewer can accept a draft that only conflicts with current guidance.
import { afterAll, describe, expect, test } from "bun:test";
import {
  ALLOWED_RESOLUTIONS,
  DecisionReviewService,
  lexicalScore,
} from "../../../src/domain/decisionreview/index.ts";
import { significantTokenSet } from "../../../src/domain/decisionreview/text.ts";
import type { DecisionEntry } from "../../../src/models/decision.ts";
import { cleanupLabs, lab } from "../world.ts";

afterAll(cleanupLabs);

const BUN = "20261103-1337-use-bun-for-everything";
const evidence = { sources: ["@doc/architecture"], relatedTasks: ["FX-3VT2SR"] };

const cand = (title: string, extra: Partial<DecisionEntry> = {}): DecisionEntry => ({
  id: "",
  title,
  status: "",
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const CONFLICTING = "Bun everything scripts";

async function conflictingDraft(_l: ReturnType<typeof lab>, svc: DecisionReviewService) {
  const added = await svc.add(cand(CONFLICTING, { decision: "Scripts run on bun", ...evidence }));
  expect(added.status).toBe("review_required");
  expect(added.matches?.[0]?.id).toBe(BUN);
  expect(added.matches?.[0]?.kind).toBe("conflict");
  expect(added.decision).toBeDefined();
  return added.decision?.id as string;
}

describe("accept_distinct (KN-PRGZMS)", () => {
  test("needs_resolution lists accept_distinct", async () => {
    expect(ALLOWED_RESOLUTIONS).toContain("accept_distinct");
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(cand(CONFLICTING, { ...evidence }));
    expect(added.allowedResolutions).toContain("accept_distinct");
    expect(
      l.storage.decisions.get(added.decision?.id as string).reviewAllowedResolutions,
    ).toContain("accept_distinct");
  });

  test("accepts a conflicting draft, keeps the match current and records the reason", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const id = await conflictingDraft(l, svc);
    await expect(svc.accept(id)).rejects.toThrow("needs duplicate/conflict resolution");
    const r = await svc.resolve(undefined, {
      candidateId: id,
      resolution: "accept_distinct",
      reason: "narrower rule about scripts only",
    });
    expect(r.status).toBe("resolved");
    expect(r.resolution).toBe("accept_distinct");
    expect(r.decision?.status).toBe("accepted");
    expect(r.changedIds).toEqual([id]);
    expect(r.decision?.verification).toContain(
      `review: accepted as distinct from @decision/${BUN} (conflict): narrower rule about scripts only`,
    );
    expect(l.storage.decisions.get(BUN).status).toBe("accepted");
    expect(l.storage.decisions.get(BUN).supersededBy ?? []).toEqual([]);
  });

  test("a reason is required", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const id = await conflictingDraft(l, svc);
    for (const reason of [undefined, "", "   "]) {
      await expect(
        svc.resolve(undefined, { candidateId: id, resolution: "accept_distinct", reason }),
      ).rejects.toThrow("reason is required for accept_distinct");
    }
    expect(l.storage.decisions.get(id).status).toBe("draft");
  });

  test("evidence blockers still refuse", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(cand(CONFLICTING, { decision: "Scripts run on bun" }));
    const id = added.decision?.id as string;
    await expect(
      svc.resolve(undefined, { candidateId: id, resolution: "accept_distinct", reason: "r" }),
    ).rejects.toThrow();
    expect(l.storage.decisions.get(id).status).toBe("draft");
  });

  test("an exact duplicate is refused and points at merge_duplicate", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const added = await svc.add(
      cand("Use bun for everything", { decision: "Bun everywhere", ...evidence }),
    );
    const id = added.decision?.id as string;
    await expect(
      svc.resolve(undefined, { candidateId: id, resolution: "accept_distinct", reason: "r" }),
    ).rejects.toThrow("merge_duplicate");
    expect(l.storage.decisions.get(id).status).toBe("draft");
  });

  test("after the dismissal, accept and accept_new no longer block", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const id = await conflictingDraft(l, svc);
    await svc.resolve(undefined, { candidateId: id, resolution: "accept_distinct", reason: "r" });
    const again = await svc.accept(id);
    expect(again.decision?.status).toBe("accepted");
    const viaNew = await svc.resolve(undefined, { candidateId: id, resolution: "accept_new" });
    expect(viaNew.decision?.status).toBe("accepted");
  });

  test("accept_new keeps requiring a clean review", async () => {
    const l = lab();
    const svc = new DecisionReviewService(l.storage);
    const id = await conflictingDraft(l, svc);
    await expect(
      svc.resolve(undefined, { candidateId: id, resolution: "accept_new" }),
    ).rejects.toThrow("accept_new requires ready_for_review");
  });
});

describe("function words are not topic words (KN-PRGZMS)", () => {
  // Divergence from Go 0.34.1: Go reports lexical:conflict_topic for these titles because its
  // stop word list is English only.
  test("the reported Vietnamese titles are not a conflict", () => {
    const a = "Raw HTML trong Markdown được giữ nguyên bằng atom chỉ đọc trong Rich mode";
    const b = "Nội dung soạn thảo lưu dưới dạng Markdown, editor chỉ là lớp hiển thị";
    const [, kind, reasons] = lexicalScore(cand(a), cand(b));
    expect(kind).not.toBe("conflict");
    expect(reasons).not.toContain("lexical:conflict_topic");
  });

  test("a domain word plus an English function word is not a conflict", () => {
    const [, kind, reasons] = lexicalScore(
      cand("Markdown stays the source for the editor"),
      cand("Markdown rendering uses the cache"),
    );
    expect(kind).not.toBe("conflict");
    expect(reasons).not.toContain("lexical:conflict_topic");
  });

  test("Vietnamese function words are dropped, content words stay", () => {
    const tokens = significantTokenSet("Markdown chỉ của trong được là markdown editor");
    expect([...tokens].sort()).toEqual(["editor", "markdown"]);
  });
});
