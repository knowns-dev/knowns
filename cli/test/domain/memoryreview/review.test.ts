import { afterAll, describe, expect, test } from "bun:test";
import {
  ALLOWED_RESOLUTIONS,
  MemoryReviewService,
  memoryJson,
  memoryResultJson,
} from "../../../src/domain/memoryreview/index.ts";
import type { MemoryEntry } from "../../../src/models/memory.ts";
import { cleanupLabs, lab, memoryFile } from "../world.ts";

afterAll(cleanupLabs);

const fresh = (title: string, content = "", extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "",
  title,
  layer: "project",
  content,
  createdAt: "",
  updatedAt: "",
  ...extra,
});

const NOW = new Date("2026-11-04T09:00:00.000Z");

describe("MemoryReviewService.add", () => {
  test("no match creates a proposed memory", async () => {
    const l = lab();
    const svc = new MemoryReviewService(l.storage, { now: () => NOW });
    const r = await svc.add(fresh("Totally unrelated subject", "nothing alike here at all"));
    expect(r.status).toBe("created");
    expect(r.memory?.status).toBe("proposed");
    expect(r.memory?.createdAt).toBe(NOW.toISOString());
    expect(r.changedIds).toEqual([r.memory?.id as string]);
    expect(l.storage.memory.get(r.memory?.id as string).title).toBe("Totally unrelated subject");
  });

  test("a current duplicate asks for review and writes nothing", async () => {
    const l = lab();
    const before = l.storage.memory.list("").length;
    const r = await new MemoryReviewService(l.storage).add(
      fresh("Prefer hyphens", "Use plain hyphens.\n\n**Why:** reads as machine-written otherwise."),
    );
    expect(r.status).toBe("review_required");
    expect(r.matches?.[0]?.id).toBe("rrvcia");
    expect(r.matches?.[0]?.matchedBy).toContain("lexical:title");
    expect(r.allowedResolutions).toEqual([...ALLOWED_RESOLUTIONS]);
    expect(l.storage.memory.list("").length).toBe(before);
  });

  test("skipReview creates despite a duplicate, with the requested status", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage).add(fresh("Prefer hyphens"), {
      skipReview: true,
      status: "stale",
    });
    expect(r.status).toBe("created");
    expect(r.memory?.status).toBe("stale");
  });

  test("a non-current (proposed) memory is not a review match", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage).add(
      fresh("Pattern: keep stores small", "Keep stores small."),
    );
    expect(r.status).toBe("created");
  });

  test("the legacy decision category, bad layer, status, confidence and ttl are rejected", async () => {
    const svc = new MemoryReviewService(lab().storage);
    await expect(svc.add(fresh("x", "", { category: "decision" }))).rejects.toThrow(
      "legacy and read-only",
    );
    await expect(svc.add(fresh("x", "", { layer: "working" }))).rejects.toThrow(
      'invalid memory layer: "working"',
    );
    await expect(svc.add(fresh("x"), { status: "bogus" })).rejects.toThrow(
      'invalid memory status: "bogus"',
    );
    await expect(svc.add(fresh("x", "", { confidence: "sure" }))).rejects.toThrow(
      "invalid memory confidence",
    );
    await expect(svc.add(fresh("x", "", { ttlDays: -1 }))).rejects.toThrow(
      "ttlDays must be non-negative",
    );
  });

  test("matchedBy order is fixed and the score is capped with a category bonus", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage).review(
      fresh(
        "Prefer hyphens",
        "Use plain hyphens.\n\n**Why:** reads as machine-written otherwise.",
        {
          category: "preference",
        },
      ),
    );
    expect(r?.matches?.[0]?.score).toBe(1);
    expect(r?.matches?.[0]?.matchedBy).toEqual([
      "lexical:title",
      "lexical:content",
      "lexical:title_tokens",
      "lexical:content_tokens",
      "lexical:combined",
      "lexical:category",
    ]);
  });
});

describe("semantic leg", () => {
  test("a stubbed semantic search is merged with the lexical leg, best score wins", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage, {
      semanticSearch: () => [
        {
          id: "rrvcia",
          title: "Prefer hyphens",
          layer: "project",
          score: 0.9,
          matchedBy: ["semantic"],
        },
        { id: "zzz", title: "Other", layer: "project", score: 0.8, matchedBy: ["semantic"] },
        { id: "low", title: "Low", layer: "project", score: 0.1, matchedBy: ["semantic"] },
      ],
    }).review(fresh("Prefer hyphens", "Use plain hyphens."));
    expect(r?.matches?.map((m) => m.id)).toEqual(["rrvcia", "zzz"]);
    expect(r?.matches?.[0]?.matchedBy).toContain("semantic");
    expect(r?.matches?.[0]?.matchedBy).toContain("lexical:title");
  });

  test("a failing semantic search leaves the lexical matches", async () => {
    const r = await new MemoryReviewService(lab().storage, {
      semanticSearch: () => {
        throw new Error("offline");
      },
    }).review(fresh("Prefer hyphens", "Use plain hyphens."));
    expect(r?.matches?.[0]?.id).toBe("rrvcia");
  });

  test("the match limit applies", async () => {
    const l = lab();
    for (let i = 0; i < 4; i++) {
      l.write(
        `project/.knowns/memory/memory-dup${i}.md`,
        memoryFile(`dup${i}`, "Shared title words", "shared content words here"),
      );
    }
    const r = await new MemoryReviewService(l.storage, { reviewLimit: 2 }).review(
      fresh("Shared title words", "shared content words here"),
    );
    expect(r?.matches?.length).toBe(2);
  });

  test("Entries replaces the disk listing", async () => {
    const l = lab();
    const only = l.storage.memory.get("rrvcia");
    const r = await new MemoryReviewService(l.storage, { entries: [] }).review(
      fresh("Prefer hyphens"),
    );
    expect(r).toBeUndefined();
    const r2 = await new MemoryReviewService(l.storage, { entries: [only] }).review(
      fresh("Prefer hyphens"),
    );
    expect(r2?.matches?.length).toBe(1);
  });
});

describe("MemoryReviewService.resolve", () => {
  test("update_existing records verification and merges only the given fields", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage, { now: () => NOW }).resolve(
      fresh("", "new body", { tags: ["t1"], ttlDays: 5 }),
      { resolution: "update_existing", targetId: "rrvcia", status: "stale" },
    );
    expect(r.resolution).toBe("update_existing");
    const m = l.storage.memory.get("rrvcia");
    expect(m.title).toBe("Prefer hyphens");
    expect(m.content).toBe("new body");
    expect(m.tags).toEqual(["t1"]);
    expect(m.ttlDays).toBe(5);
    expect(m.status).toBe("stale");
    expect(new Date(m.lastVerified as string).getTime()).toBe(NOW.getTime());
  });

  test("archive_existing_create_new archives the target and creates the replacement", async () => {
    const l = lab();
    const r = await new MemoryReviewService(l.storage).resolve(fresh("Replacement", "body"), {
      resolution: "archive_existing_create_new",
      targetId: "rrvcia",
      status: "active",
    });
    expect(l.storage.memory.get("rrvcia").status).toBe("archived");
    expect(r.changedIds?.[0]).toBe("rrvcia");
    expect(r.memory?.status).toBe("active");
    expect(r.changedIds?.length).toBe(2);
  });

  test("an invalid replacement fails before the existing memory is archived", async () => {
    const l = lab();
    await expect(
      new MemoryReviewService(l.storage).resolve(fresh("R", "", { category: "decision" }), {
        resolution: "archive_existing_create_new",
        targetId: "rrvcia",
      }),
    ).rejects.toThrow("legacy and read-only");
    expect(l.storage.memory.get("rrvcia").status).toBe("active");
  });

  test("merge_existing tombstones an existing candidate or a fresh one", async () => {
    const l = lab();
    const svc = new MemoryReviewService(l.storage, { now: () => NOW });
    const merged = await svc.resolve(
      { ...fresh("Prefer hyphens"), id: "rrvcia" },
      { resolution: "merge_existing", targetId: "kunv9q" },
    );
    expect(merged.memory?.status).toBe("merged");
    expect(l.storage.memory.get("rrvcia").mergedInto).toBe("kunv9q");
    const fresh2 = await svc.resolve(fresh("Tomb"), {
      resolution: "merge_existing",
      targetId: "kunv9q",
    });
    expect(fresh2.memory?.mergedInto).toBe("kunv9q");
    expect(fresh2.memory?.status).toBe("merged");
  });

  test("reject_new stores a rejected memory with a reason", async () => {
    const l = lab();
    const svc = new MemoryReviewService(l.storage);
    const a = await svc.resolve(fresh("Rejected one"), { resolution: "reject_new" });
    expect(a.memory?.rejectedReason).toBe("rejected_by_review");
    const b = await svc.resolve(fresh("Rejected two"), {
      resolution: "reject_new",
      rejectedReason: "noise",
    });
    expect(b.memory?.rejectedReason).toBe("noise");
    expect(b.memory?.status).toBe("rejected");
  });

  test("create_proposed forces the proposed status", async () => {
    const r = await new MemoryReviewService(lab().storage).resolve(
      fresh("P", "", { status: "active" }),
      {
        resolution: "create_proposed",
      },
    );
    expect(r.memory?.status).toBe("proposed");
  });

  test("argument errors", async () => {
    const svc = new MemoryReviewService(lab().storage);
    await expect(svc.resolve(undefined, { resolution: "" })).rejects.toThrow(
      "resolution is required",
    );
    await expect(svc.resolve(undefined, { resolution: "nope" })).rejects.toThrow(
      "unsupported memory review resolution: nope",
    );
    await expect(svc.resolve(undefined, { resolution: "update_existing" })).rejects.toThrow(
      "targetId is required for update_existing",
    );
    await expect(
      svc.resolve(undefined, { resolution: "merge_existing", targetId: "missing" }),
    ).rejects.toThrow("not found");
  });
});

describe("JSON shapes", () => {
  test("a memory marshals in Go field order, omitting empties but keeping lastVerified", () => {
    const json = memoryJson({
      id: "a",
      title: "t",
      layer: "project",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      tags: [],
      metadata: {},
    });
    expect(Object.keys(json)).toEqual([
      "id",
      "title",
      "layer",
      "lastVerified",
      "createdAt",
      "updatedAt",
    ]);
    expect(json.lastVerified).toBe("0001-01-01T00:00:00Z");
  });

  test("a result keeps Go's key order", () => {
    const json = memoryResultJson({
      status: "review_required",
      matches: [{ id: "a", title: "t", layer: "project", score: 1 }],
      allowedResolutions: ["x"],
    });
    expect(Object.keys(json)).toEqual(["status", "matches", "allowedResolutions"]);
  });
});
