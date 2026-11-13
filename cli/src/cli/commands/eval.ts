// `knowns eval retrieval`: deterministic retrieval quality gates (internal/cli/eval.go).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { noArgs } from "../core/args.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { goJSONIndent } from "../core/gofmt.ts";
import { getStoreErr } from "../core/helpers.ts";

type Evaluation = typeof import("../../domain/evaluation/index.ts");
type Report = import("../../domain/evaluation/index.ts").EvaluationReport;

/** evaluationExit: silence usage and fail with the outcome. */
function evaluationExit(ctx: CommandContext, outcome: string): Error {
  ctx.cmd.root().silenceUsage = true;
  return new Error(`retrieval evaluation failed: ${outcome}`);
}

function emitReport(ev: Evaluation, ctx: CommandContext, report: Report, outputPath: string): void {
  const data = `${goJSONIndent(ev.reportJSON(report))}\n`;
  if (outputPath !== "") {
    try {
      mkdirSync(dirname(outputPath), { recursive: true, mode: 0o755 });
    } catch (e) {
      throw new Error(`create evaluation report directory: ${(e as Error).message}`);
    }
    try {
      writeFileSync(outputPath, data, { mode: 0o644 });
    } catch (e) {
      throw new Error(`write evaluation report: ${(e as Error).message}`);
    }
  }
  if (ctx.json) ctx.print(data);
  else ctx.print(ev.formatRetrievalEvaluationReport(report));
}

function validateFlags(
  mode: string,
  casesPath: string,
  baselinePath: string,
  updateBaseline: boolean,
  reason: string,
  runtimeIdentity: string,
): void {
  if (mode !== "keyword" && mode !== "semantic" && mode !== "hybrid") {
    throw new Error(`mode: unsupported evaluation mode ${JSON.stringify(mode)}`);
  }
  if (casesPath !== "") {
    if (baselinePath !== "") {
      throw new Error("project-local --cases cannot use a canonical --baseline");
    }
    if (updateBaseline) {
      throw new Error("project-local --cases are report-only and cannot update baselines");
    }
  }
  if (updateBaseline && reason.trim() === "") {
    throw new Error("--update-baseline requires a non-empty --reason");
  }
  if (mode !== "keyword" && runtimeIdentity.trim() === "") {
    throw new Error(`--runtime-id is required for ${mode} evaluation`);
  }
  if (mode !== "keyword" && updateBaseline && baselinePath === "") {
    throw new Error(`--baseline is required when updating a ${mode} baseline`);
  }
}

/** RequirePinnedSemanticEvaluationRuntime: returns the actual identity, throws with it attached. */
async function requirePinnedRuntime(
  ctx: CommandContext,
  storage: import("../../storage/adapters.ts").Storage,
  pinnedIn: string,
): Promise<{ identity: string; err?: Error }> {
  const ev = await import("../../domain/evaluation/index.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const { mockEmbedderEnabled } = await import("../../search/mock-embedder.ts");
  const cfgMod = await import("../../search/config.ts");
  const env = buildSearchEnvironment({ env: ctx.env });
  const pinned = pinnedIn.trim();
  if (pinned === "")
    return { identity: "", err: new Error("pinned semantic runtime identity: required") };
  let actual: string;
  if (mockEmbedderEnabled(ctx.env)) {
    actual = ev.MOCK_EVALUATION_RUNTIME_IDENTITY;
  } else {
    try {
      const cfg = cfgMod.loadSemanticRuntimeConfig(storage, env);
      actual = `${cfg.provider}/${cfg.modelId}@${cfg.dimensions}`;
    } catch (e) {
      return {
        identity: "",
        err: new Error(`load semantic evaluation runtime: ${(e as Error).message}`),
      };
    }
  }
  if (actual !== pinned) {
    return {
      identity: actual,
      err: new Error(
        `semantic runtime identity mismatch: configured ${JSON.stringify(actual)}, pinned ${JSON.stringify(pinned)}`,
      ),
    };
  }
  if (mockEmbedderEnabled(ctx.env)) return { identity: actual };
  const disabled = cfgMod.semanticRuntimeDisabledReason(ctx.env);
  if (disabled.disabled) {
    return {
      identity: actual,
      err: new Error(
        `semantic runtime ${JSON.stringify(actual)} is disabled by ${disabled.reason}`,
      ),
    };
  }
  const runtime = await import("../../search/runtime.ts");
  let available: boolean;
  try {
    available = runtime.semanticIndexAvailableForRuntime(storage, env, "");
  } catch (e) {
    return {
      identity: actual,
      err: new Error(
        `semantic runtime ${JSON.stringify(actual)} index readiness: ${(e as Error).message}`,
      ),
    };
  }
  if (!available) {
    return {
      identity: actual,
      err: new Error(
        `semantic runtime ${JSON.stringify(actual)} index is missing or empty; run an explicit semantic reindex`,
      ),
    };
  }
  try {
    const session = runtime.openSemanticSession(storage, env);
    try {
      await session.close();
    } catch (e) {
      return {
        identity: actual,
        err: new Error(
          `close semantic runtime ${JSON.stringify(actual)} readiness session: ${(e as Error).message}`,
        ),
      };
    }
  } catch (e) {
    return {
      identity: actual,
      err: new Error(
        `semantic runtime ${JSON.stringify(actual)} is not loadable: ${(e as Error).message}`,
      ),
    };
  }
  return { identity: actual };
}

async function runEvalRetrieval(ctx: CommandContext): Promise<void> {
  const ev = await import("../../domain/evaluation/index.ts");
  const mode = ctx.flags.string("mode");
  const casesPath = ctx.flags.string("cases");
  const baselinePath = ctx.flags.string("baseline");
  const updateBaseline = ctx.flags.bool("update-baseline");
  const reason = ctx.flags.string("reason");
  let runtimeIdentity = ctx.flags.string("runtime-id");
  const outputPath = ctx.flags.string("output");
  const scope = casesPath === "" ? "canonical" : "project-local";
  const reportOnly = casesPath !== "";

  const fail = (outcome: string, err: Error, sc = scope, ro = reportOnly): never => {
    const report = ev.evaluationFailureReport(mode, runtimeIdentity, sc, ro, outcome, err);
    emitReport(ev, ctx, report, outputPath);
    throw evaluationExit(ctx, report.outcome);
  };

  try {
    validateFlags(mode, casesPath, baselinePath, updateBaseline, reason, runtimeIdentity);
  } catch (e) {
    fail(ev.OUTCOME_VALIDATION, e as Error);
  }

  let fixture: import("../../domain/evaluation/index.ts").EvaluationFixture;
  try {
    fixture =
      casesPath === ""
        ? ev.loadCanonicalEvaluationFixture()
        : ev.loadEvaluationFixtureFile(casesPath);
  } catch (e) {
    return fail(ev.OUTCOME_VALIDATION, e as Error);
  }
  if (runtimeIdentity === "" && mode === "keyword") runtimeIdentity = "keyword";

  const { createStorage } = await import("../../storage/adapters.ts");
  if (mode !== "keyword") {
    let store: Awaited<ReturnType<typeof getStoreErr>>;
    try {
      store = await getStoreErr(ctx.cmd);
    } catch (e) {
      return fail(ev.OUTCOME_READINESS, e as Error);
    }
    const ready = await requirePinnedRuntime(ctx, createStorage(store), runtimeIdentity);
    if (ready.err) {
      if (ready.identity !== "") runtimeIdentity = ready.identity;
      fail(ev.OUTCOME_READINESS, ready.err);
    }
    runtimeIdentity = ready.identity;
  }

  let baseline: import("../../domain/evaluation/index.ts").EvaluationBaseline | undefined;
  if (casesPath === "") {
    try {
      baseline =
        baselinePath === ""
          ? ev.loadCanonicalEvaluationBaseline()
          : ev.loadEvaluationBaselineFile(baselinePath);
    } catch (e) {
      const notExist = e instanceof ev.NotExistError;
      if (!(updateBaseline && baselinePath !== "" && notExist)) {
        fail(ev.OUTCOME_VALIDATION, e as Error, "canonical", false);
      }
      baseline = undefined;
    }
    if (!updateBaseline) {
      try {
        ev.validateEvaluationBaseline(fixture, baseline, mode, runtimeIdentity);
      } catch (e) {
        fail(ev.OUTCOME_VALIDATION, e as Error, "canonical", false);
      }
    }
  }

  let store: Awaited<ReturnType<typeof getStoreErr>>;
  try {
    store = await getStoreErr(ctx.cmd);
  } catch (e) {
    return fail(ev.OUTCOME_VALIDATION, e as Error);
  }
  const storage = createStorage(store);
  const { retrieveWithRuntime } = await import("../../search/runtime.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const env = buildSearchEnvironment({ env: ctx.env });

  let report: Report;
  try {
    report = await ev.evaluateRetrievalFixture(
      fixture,
      async (tc, m) => {
        const limit = tc.limit && tc.limit > 0 ? tc.limit : 20;
        const { response, runtime } = await retrieveWithRuntime(storage, env, {
          query: tc.query,
          mode: m,
          limit,
          sourceTypes: [...(tc.sourceTypes ?? [])],
          expandReferences: tc.expandReferences ?? false,
          includeHistorical: tc.includeHistorical ?? false,
        });
        if (runtime?.degraded) {
          throw new Error(
            `${m} runtime degraded (${runtime.reason ?? ""}): ${runtime.message ?? ""}; evaluation forbids fallback`,
          );
        }
        if (response.mode !== m) {
          throw new Error(
            `requested ${m} mode but retrieval returned ${response.mode}; evaluation forbids fallback`,
          );
        }
        return response;
      },
      { mode, runtimeIdentity, scope, reportOnly },
    );
  } catch (e) {
    return fail(mode !== "keyword" ? ev.OUTCOME_READINESS : ev.OUTCOME_VALIDATION, e as Error);
  }

  if (updateBaseline) {
    if (report.outcome === ev.OUTCOME_HARD_INVARIANT) {
      emitReport(ev, ctx, report, outputPath);
      throw evaluationExit(ctx, report.outcome);
    }
    const tolerances =
      baseline?.tolerances && Object.keys(baseline.tolerances).length > 0
        ? baseline.tolerances
        : ev.defaultEvaluationTolerances();
    let updated: import("../../domain/evaluation/index.ts").EvaluationBaseline;
    try {
      updated = ev.buildEvaluationBaseline(fixture, report, reason, tolerances);
    } catch (e) {
      return fail(ev.OUTCOME_VALIDATION, e as Error, "canonical", false);
    }
    const target = baselinePath === "" ? ev.CANONICAL_EVALUATION_BASELINE_PATH : baselinePath;
    ev.writeEvaluationBaseline(target, `${goJSONIndent(ev.baselineJSON(updated))}\n`);
    ctx.printErr(`Updated retrieval evaluation baseline: ${target}\n`);
  } else if (casesPath === "") {
    ev.applyEvaluationBaselineGate(report, baseline as NonNullable<typeof baseline>);
  }

  emitReport(ev, ctx, report, outputPath);
  if (!report.reportOnly && report.outcome !== ev.OUTCOME_PASS) {
    throw evaluationExit(ctx, report.outcome);
  }
}

export default defineCommand({
  use: "eval",
  short: "Evaluate deterministic quality gates",
  subcommands: [
    defineCommand({
      use: "retrieval",
      short: "Evaluate retrieval and final ContextPack quality",
      args: noArgs,
      flags: [
        {
          type: "string",
          name: "cases",
          usage:
            "Project-local fixture path (report-only; never gates or updates canonical baselines)",
        },
        { type: "string", name: "baseline", usage: "Baseline file override (canonical runs only)" },
        {
          type: "string",
          name: "mode",
          usage: "Evaluation mode: keyword|semantic|hybrid",
          default: "keyword",
        },
        {
          type: "string",
          name: "runtime-id",
          usage: "Pinned runtime/model identity required by semantic and hybrid evaluation",
        },
        {
          type: "bool",
          name: "update-baseline",
          usage: "Explicitly replace a canonical baseline from the current reviewed result",
        },
        { type: "string", name: "reason", usage: "Review reason required with --update-baseline" },
        {
          type: "string",
          name: "output",
          usage: "Write the versioned JSON report to this explicit path",
        },
      ],
      run: runEvalRetrieval,
    }),
  ],
});
