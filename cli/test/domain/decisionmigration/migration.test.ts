import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOWED_RESOLUTIONS,
  classifyNoise,
  type DecisionMigrationOptions,
  DecisionMigrationService,
  MigrationApplyError,
  memorySources,
  previewReportJson,
  validateSelection,
} from "../../../src/domain/decisionmigration/index.ts";
import { cleanupLabs, type Lab, lab, memoryFile } from "../world.ts";

afterAll(cleanupLabs);

const BUN = "20261103-1337-use-bun-for-everything";
const FLAGS =
  "We adopt feature flags for risky rollouts across every service. See @doc/architecture for the rationale.";

function legacyLab(extra: Record<string, string> = {}): Lab {
  const l = lab();
  l.write(
    "project/.knowns/memory/memory-leg1.md",
    memoryFile("leg1", "Adopt feature flags", FLAGS, { category: "decision" }),
  );
  l.write(
    "project/.knowns/memory/memory-leg2.md",
    memoryFile("leg2", "Adopt feature flags again", FLAGS, { category: "decision" }),
  );
  l.write(
    "project/.knowns/memory/memory-leg3.md",
    memoryFile("leg3", "Project workflow decision", "Short.", { category: "decision" }),
  );
  for (const [rel, content] of Object.entries(extra)) l.write(rel, content);
  return l;
}

const svc = (l: Lab, o: DecisionMigrationOptions = {}) =>
  new DecisionMigrationService(l.storage, o);
const journalDir = (l: Lab) => join(l.root, "migrations", "decision-memory");
const sel = (memoryId: string, resolution: string, rest = {}) => ({
  memoryId,
  resolution,
  ...rest,
});
const create = (id: string) =>
  sel(id, "create_decision", { relatedDocs: ["architecture"], relatedTasks: ["FX-3VT2SR"] });

describe("preview", () => {
  test("classifies deterministically and writes nothing", () => {
    const l = legacyLab();
    const before = JSON.stringify([
      readdirSync(join(l.root, "memory")),
      readdirSync(join(l.root, "decisions")),
    ]);
    const a = svc(l).preview();
    const b = svc(l).preview();
    expect(previewReportJson(a)).toEqual(previewReportJson(b));
    expect(existsSync(journalDir(l))).toBe(false);
    expect(
      JSON.stringify([readdirSync(join(l.root, "memory")), readdirSync(join(l.root, "decisions"))]),
    ).toBe(before);
    expect(a.counts).toEqual({ total: 3, highNoise: 1, duplicate: 2, withIssue: 1 });
    const by = Object.fromEntries(a.candidates.map((c) => [c.memoryId, c]));
    expect(by.leg1?.proposedResolution).toBe("create_decision");
    expect(by.leg1?.proposedDecisionId).toMatch(/^20261001-1000-adopt-feature-flags$/);
    expect(by.leg2?.proposedResolution).toBe("consolidate_duplicate");
    expect(by.leg2?.proposedTargetId).toBe("leg1");
    expect(by.leg3?.proposedResolution).toBe("archive_noise");
    expect(by.leg3?.sourceIssues).toEqual(["missing_source"]);
  });

  test("a corrupt or foreign journal is refused", () => {
    const l = legacyLab();
    svc(l).preview();
    l.write("project/.knowns/migrations/decision-memory/leg1.json", "{not json");
    expect(() => svc(l).preview()).toThrow('parse migration journal for memory "leg1"');
    l.write(
      "project/.knowns/migrations/decision-memory/leg1.json",
      JSON.stringify({ version: 2, memoryId: "leg1", migrationId: "decision-memory-leg1" }),
    );
    expect(() => svc(l).preview()).toThrow("unsupported identity or version");
  });

  test("noise and source classification", () => {
    const mem = (title: string, content: string, metadata?: Record<string, string>) => ({
      id: "m",
      title,
      layer: "project",
      content,
      metadata,
      createdAt: "",
      updatedAt: "",
    });
    expect(classifyNoise(mem("Instruction source of truth", "x"))).toEqual([
      "high",
      ["generic_runtime_capture_title"],
    ]);
    expect(classifyNoise(mem("t", "x", { Runtime_Capture: "true" }))).toEqual([
      "high",
      ["runtime_capture_metadata"],
    ]);
    expect(classifyNoise(mem("t", "x", { runtime: "false" }))[0]).toBe("medium");
    expect(classifyNoise(mem("t", "one two three four five six seven eight"))[0]).toBe("low");
    expect(
      memorySources({
        ...mem("t", "see @doc/a/b. and (@task/x-1), @decision/d;"),
        sources: [" @memory/z ", ""],
      }),
    ).toEqual(["@decision/d", "@doc/a/b", "@memory/z", "@task/x-1"]);
  });
});

describe("selection validation", () => {
  test("rejects incomplete or inconsistent selections", () => {
    expect(() => validateSelection(sel("", "archive_noise"))).toThrow("memoryId is required");
    expect(() => validateSelection(sel("bad id", "archive_noise"))).toThrow(
      'invalid migration memory ID "bad id"',
    );
    expect(() => validateSelection(sel("a", "link_existing"))).toThrow(
      "decisionId is required for link_existing",
    );
    expect(() => validateSelection(sel("a", "consolidate_duplicate"))).toThrow(
      "targetMemoryId is required",
    );
    expect(() =>
      validateSelection(sel("a", "consolidate_duplicate", { targetMemoryId: "a" })),
    ).toThrow("cannot target itself");
    expect(() => validateSelection(sel("a", "reclassify"))).toThrow(
      "category is required for reclassify",
    );
    expect(() => validateSelection(sel("a", "reclassify", { category: "decision" }))).toThrow(
      "legacy and read-only",
    );
    expect(() => validateSelection(sel("a", "bogus"))).toThrow(
      'unsupported migration resolution "bogus"',
    );
    expect(() => validateSelection(sel("a", "archive_noise", { acceptVerified: true }))).toThrow(
      "Decision-backed",
    );
    for (const r of ALLOWED_RESOLUTIONS) expect(typeof r).toBe("string");
  });

  test("apply refuses no selections and duplicates", async () => {
    const s = svc(legacyLab());
    await expect(s.apply([])).rejects.toThrow(
      "at least one explicitly reviewed migration selection",
    );
    await expect(
      s.apply([sel("leg3", "archive_noise"), sel("leg3", "reject_noise")]),
    ).rejects.toThrow('memory "leg3" is selected more than once');
  });
});

describe("apply and rollback", () => {
  test("create_decision stays draft, leaves the legacy memory active, then rolls back", async () => {
    const l = legacyLab();
    const r = await svc(l).apply([create("leg1")]);
    const item = r.results[0];
    expect(item?.state).toBe("applied");
    expect(item?.legacyExcluded).toBe(false);
    const id = item?.decisionId as string;
    const d = l.storage.decisions.get(id);
    expect(d.status).toBe("draft");
    expect(d.tags).toEqual(["legacy-memory-migration"]);
    expect(d.sources).toEqual(["@doc/architecture", "@memory/leg1"]);
    expect(l.storage.memory.get("leg1").status).toBe("active");
    const journal = JSON.parse(readFileSync(join(journalDir(l), "leg1.json"), "utf8"));
    expect(Object.keys(journal).slice(0, 5)).toEqual([
      "version",
      "migrationId",
      "memoryId",
      "selection",
      "originalMemory",
    ]);
    expect(journal.state).toBe("applied");

    const again = await svc(l).apply([create("leg1")]);
    expect(again.results[0]?.idempotent).toBe(true);

    const back = await svc(l).rollback("leg1");
    expect(back).toEqual({ memoryId: "leg1", state: "rolled_back", decisionId: id });
    expect(() => l.storage.decisions.get(id)).toThrow("not found");
    expect((await svc(l).rollback("leg1")).state).toBe("rolled_back");
    await expect(svc(l).apply([create("leg1")])).rejects.toBeInstanceOf(MigrationApplyError);
  });

  test("accept-verified finalizes: the legacy memory is archived and points at the decision", async () => {
    const l = legacyLab();
    const r = await svc(l).apply([{ ...create("leg1"), acceptVerified: true }]);
    const id = r.results[0]?.decisionId as string;
    expect(l.storage.decisions.get(id).status).toBe("accepted");
    expect(r.results[0]?.legacyExcluded).toBe(true);
    const m = l.storage.memory.get("leg1");
    expect(m.status).toBe("archived");
    expect(m.mergedInto).toBe(`@decision/${id}`);
    expect(m.metadata?.["decisionMigration.id"]).toBe("decision-memory-leg1");

    await svc(l).rollback("leg1");
    const restored = l.storage.memory.get("leg1");
    expect(restored.status).toBe("active");
    expect(restored.mergedInto).toBeUndefined();
    expect(l.storage.decisions.get(id).status).toBe("rejected");
  });

  test("the consumption gate keeps the legacy memory active until the decision is current", async () => {
    const l = legacyLab();
    const r = await svc(l, { currentDecisionConsumptionActive: false }).apply([
      { ...create("leg1"), acceptVerified: true },
    ]);
    expect(r.results[0]?.legacyExcluded).toBe(false);
    expect(l.storage.memory.get("leg1").status).toBe("active");
    const resumed = await svc(l).apply([{ ...create("leg1"), acceptVerified: true }]);
    expect(resumed.results[0]).toMatchObject({ idempotent: true, legacyExcluded: true });
    expect(l.storage.memory.get("leg1").status).toBe("archived");
  });

  test("consolidate_duplicate needs its target applied first and orders the batch", async () => {
    const l = legacyLab();
    const early = (await svc(l)
      .apply([sel("leg2", "consolidate_duplicate", { targetMemoryId: "leg1" })])
      .catch((e: unknown) => e)) as MigrationApplyError;
    expect(early.result.results[0]?.error).toBe(
      'duplicate target memory "leg1" has no applied Decision migration',
    );
    const r = await svc(l).apply([
      sel("leg2", "consolidate_duplicate", { targetMemoryId: "leg1" }),
      create("leg1"),
    ]);
    expect(r.results.map((i) => i.memoryId)).toEqual(["leg1", "leg2"]);
    expect(r.results[1]?.decisionId).toBe(r.results[0]?.decisionId);
  });

  test("memory-only resolutions", async () => {
    const l = legacyLab();
    const r = await svc(l).apply([
      sel("leg3", "reject_noise", { reason: " noise " }),
      sel("leg1", "reclassify", { category: "Pattern" }),
      sel("leg2", "leave_unchanged"),
    ]);
    // Applied in memory id order: leg1 reclassify, leg2 leave_unchanged, leg3 reject_noise.
    expect(r.results.map((i) => i.legacyExcluded)).toEqual([true, false, true]);
    const m3 = l.storage.memory.get("leg3");
    expect(m3.status).toBe("rejected");
    expect(m3.rejectedReason).toBe("noise");
    expect(l.storage.memory.get("leg1").category).toBe("pattern");
    expect(l.storage.memory.get("leg2").status).toBe("active");
    await svc(l).rollback("leg3");
    expect(l.storage.memory.get("leg3").status).toBe("active");
  });

  test("a failure mid-way compensates, records a failed journal, and a retry succeeds", async () => {
    const l = legacyLab();
    let fail = true;
    const flaky = svc(l, {
      beforeStep: (_id, step) => {
        if (step === "before_memory" && fail) throw new Error("injected");
      },
    });
    const err = await flaky.apply([create("leg1")]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MigrationApplyError);
    const failure = err as MigrationApplyError;
    expect(failure.message).toBe("1 Decision Memory migration item(s) failed");
    expect(failure.result.results[0]).toMatchObject({
      state: "failed",
      error: "injected",
      legacyExcluded: false,
    });
    expect(
      readdirSync(join(l.root, "decisions")).some((f) => f.includes("adopt-feature-flags")),
    ).toBe(false);
    expect(JSON.parse(readFileSync(join(journalDir(l), "leg1.json"), "utf8")).state).toBe("failed");
    expect(l.storage.memory.get("leg1").status).toBe("active");
    fail = false;
    const ok = await flaky.apply([create("leg1")]);
    expect(ok.results[0]?.state).toBe("applied");
  });

  test("a journal write failure at commit is compensated", async () => {
    const l = legacyLab();
    let writes = 0;
    const s = svc(l, {
      journalWriter: () => {
        writes++;
        if (writes === 2) throw new Error("disk full");
      },
    });
    const err = (await s.apply([create("leg1")]).catch((e: unknown) => e)) as MigrationApplyError;
    expect(err.result.results[0]?.error).toContain("disk full");
    expect(
      readdirSync(join(l.root, "decisions")).some((f) => f.includes("adopt-feature-flags")),
    ).toBe(false);
  });

  test("accept-verified without evidence fails and compensates", async () => {
    const l = legacyLab();
    const err = (await svc(l)
      .apply([{ ...sel("leg3", "create_decision"), acceptVerified: true }])
      .catch((e: unknown) => e)) as MigrationApplyError;
    expect(err.result.results[0]?.error).toContain("verify migrated decision");
    expect(l.storage.memory.get("leg3").status).toBe("active");
    expect(
      readdirSync(join(l.root, "decisions")).filter((f) => f.includes("project-workflow")).length,
    ).toBe(0);
  });

  test("rollback refuses when the migrated memory changed afterwards", async () => {
    const l = legacyLab();
    await svc(l).apply([sel("leg3", "archive_noise")]);
    const m = l.storage.memory.get("leg3");
    m.content = "edited after migration";
    await l.storage.memory.update(m);
    await expect(svc(l).rollback("leg3")).rejects.toThrow("changed after migration");
  });

  test("link_existing records only the provenance it added and rollback removes only that", async () => {
    const l = legacyLab();
    const before = l.storage.decisions.get(BUN);
    const r = await svc(l).apply([
      sel("leg1", "link_existing", { decisionId: BUN, relatedTasks: ["FX-3VT2SR"] }),
    ]);
    expect(r.results[0]?.decisionId).toBe(BUN);
    const linked = l.storage.decisions.get(BUN);
    expect(linked.sources).toContain("@memory/leg1");
    expect(linked.relatedTasks).toEqual(before.relatedTasks);
    await svc(l).rollback("leg1");
    expect(l.storage.decisions.get(BUN).sources).toEqual(before.sources);
  });

  test("a journal for a different selection blocks a changed request", async () => {
    const l = legacyLab();
    await svc(l).apply([sel("leg3", "archive_noise")]);
    const err = (await svc(l)
      .apply([sel("leg3", "reject_noise")])
      .catch((e: unknown) => e)) as MigrationApplyError;
    expect(err.result.results[0]?.error).toContain(
      "already has a migration journal for a different reviewed selection",
    );
  });

  test("journals are written atomically with mode 0600 and a trailing newline", async () => {
    const l = legacyLab();
    await svc(l).apply([sel("leg3", "archive_noise")]);
    const path = join(journalDir(l), "leg3.json");
    expect(readFileSync(path, "utf8").endsWith("}\n")).toBe(true);
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    writeFileSync(path, readFileSync(path, "utf8"));
  });
});
