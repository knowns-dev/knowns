// Behavioural ports of the pure helpers in internal/models (config, decision, memory, time).
import { describe, expect, test } from "bun:test";
import {
  defaultProjectSettings,
  effectiveRuntimeWatch,
  effectiveTaskLifecycle,
  normalizeProjectSettings,
  normalizeSkillsScope,
  projectSchema,
  projectSettingsSchema,
  resolveSemanticVectorStore,
  resolveSkillsScope,
  taskLifecycleSettingsSchema,
  validateProjectSettings,
} from "../src/models/config.ts";
import {
  decisionCandidateForReviewInbox,
  decisionCurrentForDefaultRetrieval,
  decisionSlug,
  newDecisionId,
  validDecisionId,
} from "../src/models/decision.ts";
import { parseGoDuration, parseTaskLifecycleDuration } from "../src/models/duration.ts";
import {
  deriveMemoryKey,
  insertMemoryDetailMarker,
  inspectMemoryClaim,
  proposalIsExpired,
  selectMemoryCleanupCandidates,
  stripMemoryDetailMarker,
  validateLegacyDecisionMemoryUpdate,
  validateMemoryCategory,
  validateMemoryId,
  validatePreferenceWhy,
} from "../src/models/memory.ts";
import { normalizeStructuralParams, originPriority } from "../src/models/structural.ts";
import { taskLifecycleState } from "../src/models/task.ts";
import { parseDuration } from "../src/models/time.ts";
import { parseBoundary } from "../src/schema/index.ts";

describe("config", () => {
  test("a partial taskLifecycle block keeps the omitted defaults (Go UnmarshalJSON)", () => {
    expect(taskLifecycleSettingsSchema.parse({ archiveAfter: "7d" })).toEqual({
      excludeDoneFromDefaultRetrieval: true,
      autoArchive: true,
      archiveAfter: "7d",
      purgeAfter: null,
    });
    expect(
      taskLifecycleSettingsSchema.parse({ autoArchive: false, purgeAfter: "90d" }),
    ).toMatchObject({
      autoArchive: false,
      purgeAfter: "90d",
    });
  });

  test("unknown keys survive at every level (Go keeps config.json as a generic map)", () => {
    const input = {
      name: "p",
      id: "p",
      createdAt: "2026-01-01T00:00:00Z",
      futureTopLevel: { a: 1 },
      settings: {
        defaultPriority: "medium",
        statuses: ["todo"],
        futureSetting: [1, 2],
        gitTracking: { tasks: true, futureToggle: false },
        lsp: { languages: { go: { enabled: true, futureKey: "x" } } },
      },
    };
    const out = projectSchema.parse(input);
    expect(out).toEqual({ ...input, settings: { ...input.settings } });
  });

  test("defaults match DefaultProjectSettings", () => {
    const d = defaultProjectSettings();
    expect(d.defaultPriority).toBe("medium");
    expect(d.statuses).toEqual([
      "todo",
      "in-progress",
      "in-review",
      "done",
      "blocked",
      "on-hold",
      "urgent",
    ]);
    expect(d.visibleColumns).toEqual(["todo", "in-progress", "blocked", "done", "in-review"]);
    expect(d.statusColors?.urgent).toBe("orange");
    expect(effectiveTaskLifecycle({})).toEqual({
      excludeDoneFromDefaultRetrieval: true,
      autoArchive: true,
      archiveAfter: "30d",
      purgeAfter: null,
    });
  });

  test("normalize uppercases the task prefix and canonicalizes the skills scope", () => {
    const s = normalizeProjectSettings(
      projectSettingsSchema.parse({
        defaultTaskIdPrefix: " kn ",
        skillsScope: " GLOBAL ",
        statuses: [],
      }),
    );
    expect(s.defaultTaskIdPrefix).toBe("KN");
    expect(s.skillsScope).toBe("global");
    expect(() =>
      normalizeProjectSettings(
        projectSettingsSchema.parse({ defaultTaskIdPrefix: "1x", statuses: [] }),
      ),
    ).toThrow(/settings.defaultTaskIdPrefix/);
    expect(normalizeSkillsScope("")).toBe("");
    expect(() => normalizeSkillsScope("galaxy")).toThrow(/unknown scope "galaxy"/);
  });

  test("skills scope resolution chain: project, then global, then project", () => {
    expect(resolveSkillsScope("none", "global")).toBe("none");
    expect(resolveSkillsScope("", "global")).toBe("global");
    expect(resolveSkillsScope("bogus", "global")).toBe("global");
    expect(resolveSkillsScope("", "")).toBe("project");
  });

  test("validation rejects what Go rejects", () => {
    const base = { statuses: [] as string[] };
    const check = (v: object) =>
      validateProjectSettings(projectSettingsSchema.parse({ ...base, ...v }));
    expect(() => check({})).not.toThrow();
    expect(() => check({ taskLifecycle: { archiveAfter: "banana" } })).toThrow(/archiveAfter/);
    expect(() => check({ taskLifecycle: { archiveAfter: "-1d" } })).toThrow(/negative/);
    expect(() => check({ taskLifecycle: { archiveAfter: "0s" } })).not.toThrow();
    expect(() => check({ taskLifecycle: { purgeAfter: "x" } })).toThrow(/purgeAfter/);
    expect(() => check({ runtimeWatch: { gracePeriod: "soon" } })).toThrow(/gracePeriod/);
    expect(() => check({ runtimeWatch: { gracePeriod: "-5s" } })).toThrow(/negative/);
    expect(() => check({ semanticSearch: { vectorStore: { backend: "pinecone" } } })).toThrow(
      /unsupported backend/,
    );
    expect(() => check({ semanticSearch: { vectorStore: { mode: "external" } } })).toThrow(
      /requires externalURL/,
    );
    expect(() =>
      check({ semanticSearch: { vectorStore: { retention: { previousGenerations: -1 } } } }),
    ).toThrow(/must not be negative/);
  });

  test("runtime watch defaults and overrides", () => {
    expect(effectiveRuntimeWatch({})).toEqual({
      enabled: true,
      eligibleClients: ["mcp", "opencode"],
      gracePeriod: "30s",
    });
    expect(
      effectiveRuntimeWatch({ runtimeWatch: { enabled: false, gracePeriod: "1m" } }),
    ).toMatchObject({
      enabled: false,
      gracePeriod: "1m",
    });
  });

  test("vector store resolution: env > project > global > defaults", () => {
    const none = (_: string) => undefined;
    expect(resolveSemanticVectorStore(undefined, undefined, none)).toMatchObject({
      enabled: false,
      optedOut: false,
      backend: "qdrant",
      mode: "managed",
      install: "lazy",
      managedRoot: "~/.knowns/runtime/qdrant",
      retention: { previousGenerations: 1, previousGenerationTTL: "72h" },
    });
    const project = { enabled: true, model: "m", vectorStore: { install: "now" } };
    const global = {
      enabled: false,
      model: "g",
      vectorStore: { mode: "external", externalURL: "http://x" },
    };
    expect(resolveSemanticVectorStore(project, global, none)).toMatchObject({
      enabled: true,
      install: "now",
      mode: "external",
      externalURL: "http://x",
    });
    const env = (k: string) =>
      ({ KNOWNS_QDRANT_URL: "http://env:6333", KNOWNS_SEMANTIC_VECTOR_ENABLED: "no" })[k];
    expect(resolveSemanticVectorStore(project, undefined, env)).toMatchObject({
      enabled: false,
      optedOut: true,
      mode: "external",
      externalURL: "http://env:6333",
    });
    expect(
      resolveSemanticVectorStore(
        { enabled: true, model: "m", vectorStore: { backend: "none" } },
        undefined,
        none,
      ),
    ).toMatchObject({ enabled: false, optedOut: true });
    // an explicit retention of 0 disables rollback retention instead of inheriting the default
    expect(
      resolveSemanticVectorStore(
        { enabled: true, model: "m", vectorStore: { retention: { previousGenerations: 0 } } },
        undefined,
        none,
      ).retention.previousGenerations,
    ).toBe(0);
  });
});

describe("Go duration parsing", () => {
  test.each([
    ["30s", 30_000_000_000n],
    ["1h30m", 5_400_000_000_000n],
    ["1.5h", 5_400_000_000_000n],
    ["300ms", 300_000_000n],
    ["-5s", -5_000_000_000n],
    ["0", 0n],
    ["2h45m30.5s", 9_930_500_000_000n],
  ])("accepts %p", (input, ns) => {
    expect(parseGoDuration(input)).toBe(ns);
  });

  test.each(["", "5", "s", "1x", "1h-2m", ".", "1..5s"])("rejects %p", (input) => {
    expect(() => parseGoDuration(input)).toThrow();
  });

  test("task lifecycle durations add a day suffix and reject negatives and empties", () => {
    expect(parseTaskLifecycleDuration("30d")).toBe(30n * 86_400_000_000_000n);
    expect(parseTaskLifecycleDuration("0d")).toBe(0n);
    expect(parseTaskLifecycleDuration(" 72h ")).toBe(72n * 3_600_000_000_000n);
    for (const bad of ["", "  ", "-1d", "1.5d", "dd", "-2h", "99999999999999d"]) {
      expect(() => parseTaskLifecycleDuration(bad)).toThrow();
    }
  });
});

describe("time durations (models.ParseDuration)", () => {
  test.each([
    ["2h", 7200],
    ["30m", 1800],
    ["1h30m", 5400],
    ["90s", 90],
    ["1h30m45s", 5445],
    ["0s", 0],
  ])("%p -> %p", (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds);
  });
  test.each(["", "abc", "1x", "0", "h", "1h30"])("rejects %p", (input) => {
    expect(() => parseDuration(input)).toThrow();
  });
});

describe("decisions", () => {
  test("slug and id", () => {
    expect(decisionSlug("  Use Bun!! for scripts ")).toBe("use-bun-for-scripts");
    expect(decisionSlug("***")).toBe("decision");
    const at = new Date(2026, 10, 3, 9, 5);
    expect(newDecisionId("Use Bun", at)).toBe("20261103-0905-use-bun");
    const taken = new Set(["20261103-0905-use-bun", "20261103-0905-use-bun-2"]);
    expect(newDecisionId("Use Bun", at, (id) => taken.has(id))).toBe("20261103-0905-use-bun-3");
    expect(validDecisionId("20261103-0905-use-bun-3")).toBe(true);
    expect(validDecisionId("2026-11-03-use-bun")).toBe(false);
    expect(validDecisionId("20261103-0905-Use")).toBe(false);
  });

  test("current guidance is accepted, verified and not superseded", () => {
    const ok = { status: "accepted", verifiedAt: "2026-01-01T00:00:00Z", supersededBy: [] };
    expect(decisionCurrentForDefaultRetrieval(ok)).toBe(true);
    expect(decisionCurrentForDefaultRetrieval({ ...ok, supersededBy: ["x"] })).toBe(false);
    expect(decisionCurrentForDefaultRetrieval({ ...ok, verifiedAt: undefined })).toBe(false);
    expect(decisionCurrentForDefaultRetrieval({ ...ok, status: "draft" })).toBe(false);
    expect(
      decisionCandidateForReviewInbox({ status: "draft", reviewState: "needs_evidence" }),
    ).toBe(true);
    expect(decisionCandidateForReviewInbox({ status: "draft", reviewState: "" })).toBe(false);
    expect(
      decisionCandidateForReviewInbox({ status: "accepted", reviewState: "needs_evidence" }),
    ).toBe(false);
  });
});

describe("memory", () => {
  test("derive key folds diacritics instead of shredding them", () => {
    expect(deriveMemoryKey("Không dùng em dash trong nội dung")).toBe(
      "khong-dung-em-dash-trong-noi-dung",
    );
    expect(deriveMemoryKey("  Hello, World!  ")).toBe("hello-world");
    expect(deriveMemoryKey("x".repeat(100)).length).toBe(80);
  });

  test("claim boundary", () => {
    expect(inspectMemoryClaim("one paragraph")).toMatchObject({
      claimSource: "whole",
      hasDetail: false,
    });
    expect(inspectMemoryClaim("claim\n\ndetail")).toMatchObject({
      claim: "claim",
      claimSource: "first-paragraph",
      hasDetail: true,
      detailBytes: 8,
    });
    expect(inspectMemoryClaim("claim\n\n<!--memory:detail-->\n\ndetail")).toMatchObject({
      claim: "claim",
      claimSource: "marker",
      hasDetail: true,
    });
    expect(inspectMemoryClaim("<!--memory:detail-->\n\ndetail").claimSource).toBe("whole");
    const inserted = insertMemoryDetailMarker("claim\n\ndetail");
    expect(inserted).toEqual({ content: "claim\n\n<!--memory:detail-->\n\ndetail", changed: true });
    expect(stripMemoryDetailMarker(inserted.content)).toBe("claim\n\ndetail");
    expect(insertMemoryDetailMarker("single").changed).toBe(false);
  });

  test("write-boundary validation", () => {
    expect(() => validateMemoryCategory("")).not.toThrow();
    expect(() => validateMemoryCategory("Pattern")).not.toThrow();
    expect(() => validateMemoryCategory("decision")).toThrow(/legacy and read-only/);
    expect(() => validateMemoryCategory("implementation")).toThrow(/is not allowed/);
    expect(() => validatePreferenceWhy("preference", "no reason")).toThrow(/must state its reason/);
    expect(() => validatePreferenceWhy("preference", "x\n**Why:** y")).not.toThrow();
    expect(() => validatePreferenceWhy("pattern", "anything")).not.toThrow();
    expect(() =>
      validateLegacyDecisionMemoryUpdate(
        { category: "decision" },
        { category: "decision", status: "active" },
      ),
    ).toThrow();
    expect(() =>
      validateLegacyDecisionMemoryUpdate(
        { category: "decision" },
        { category: "decision", status: "archived" },
      ),
    ).not.toThrow();
    for (const bad of ["", "../x", "a/b", "-a", "a.", "x".repeat(129)]) {
      expect(() => validateMemoryId(bad)).toThrow(/invalid memory ID/);
    }
    expect(() => validateMemoryId("abc.def_1-2")).not.toThrow();
  });

  test("proposals expire 30 days after the later of their timestamp and 2026-09-09", () => {
    const entry = {
      status: "proposed",
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:00:00Z",
    };
    const sep9 = Date.UTC(2026, 8, 9);
    const day = 86_400_000;
    expect(proposalIsExpired(entry, 0, sep9 + 29 * day)).toBe(false);
    expect(proposalIsExpired(entry, 0, sep9 + 31 * day)).toBe(true);
    expect(proposalIsExpired({ ...entry, status: "active" }, 0, sep9 + 100 * day)).toBe(false);
  });

  test("cleanup lists abandoned proposals before stale entries, oldest first", () => {
    const now = Date.UTC(2026, 10, 3);
    const mk = (id: string, status: string, updated: string) => ({
      id,
      title: id,
      layer: "project",
      status,
      createdAt: updated,
      updatedAt: updated,
    });
    const out = selectMemoryCleanupCandidates(
      [
        mk("old-active", "active", "2026-01-01T00:00:00Z"),
        mk("fresh", "active", "2026-11-02T00:00:00Z"),
        mk("proposal", "proposed", "2026-09-10T00:00:00Z"),
        mk("older-active", "active", "2025-06-01T00:00:00Z"),
      ],
      0,
      0,
      now,
    );
    expect(out.map((c) => [c.id, c.kind])).toEqual([
      ["proposal", "abandoned-proposal"],
      ["older-active", "stale-entry"],
      ["old-active", "stale-entry"],
    ]);
  });
});

describe("misc", () => {
  test("lifecycle state: archived wins over done", () => {
    expect(taskLifecycleState({ archived: true, status: "done" })).toBe("archived");
    expect(taskLifecycleState({ archived: false, status: "done" })).toBe("done");
    expect(taskLifecycleState({ archived: false, status: "todo" })).toBe("active");
  });
  test("structural params clamp depth and default direction", () => {
    expect(normalizeStructuralParams({})).toEqual({ direction: "outbound", depth: 1 });
    expect(normalizeStructuralParams({ depth: 9, direction: "both" })).toEqual({
      direction: "both",
      depth: 3,
    });
    expect(originPriority("inline")).toBe(1);
    expect(originPriority("other")).toBe(3);
  });
  test("parseBoundary names the failing path", () => {
    expect(() => parseBoundary(projectSchema, { name: 1 }, "config")).toThrow(
      /invalid config: name:/,
    );
  });
});
