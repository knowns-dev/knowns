// `knowns doctor` (internal/cli/doctor.go): read-only diagnostics for the active project and the
// local integrations. The checks live in domain/doctor; this file parses flags and renders.

import type {
  CheckResult,
  Evidence,
  Result,
  Scope,
  Status,
  Verdict,
} from "../../domain/doctor/model.ts";
import { type CommandContext, defineCommand } from "../core/define.ts";
import { exitError, SilentExit } from "../core/exit.ts";
import {
  StyleBold,
  StyleDim,
  StyleError,
  StyleInfo,
  StyleSuccess,
  StyleWarning,
} from "../core/plainoutput.ts";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function parseDoctorScopes(values: string[], valid: (s: string) => boolean): Scope[] {
  const seen = new Set<string>();
  const scopes: Scope[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const scope = part.trim();
      if (scope === "") continue;
      if (!valid(scope)) throw new Error(`unknown doctor scope ${JSON.stringify(scope)}`);
      if (!seen.has(scope)) {
        seen.add(scope);
        scopes.push(scope as Scope);
      }
    }
  }
  return scopes;
}

/** json.Marshal of one evidence value (HTML characters escaped, as encoding/json does by default). */
function marshalValue(v: unknown): string {
  return JSON.stringify(sortKeys(v))
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}

/** Go marshals a map with its keys sorted. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort(cmp)) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function formatDoctorEvidence(evidence: Evidence): string {
  return Object.keys(evidence)
    .sort(cmp)
    .map((k) => `${k}=${marshalValue(evidence[k])}`)
    .join(", ");
}

/** The JSON encoding of a Result: Go's struct field order, omitempty fields dropped. */
export function doctorJson(result: Result): string {
  const checks = result.checks.map((c) => {
    const o: Record<string, unknown> = {
      id: c.id,
      scope: c.scope,
      status: c.status,
      summary: c.summary,
    };
    if (c.evidence && Object.keys(c.evidence).length > 0) o.evidence = sortKeys(c.evidence);
    if (c.remediation) {
      o.remediation = {
        description: c.remediation.description,
        ...(c.remediation.command ? { command: c.remediation.command } : {}),
      };
    }
    if (c.skipReason) o.skipReason = c.skipReason;
    return o;
  });
  const p = result.project;
  const project: Record<string, unknown> = { active: p.active };
  if (p.name) project.name = p.name;
  if (p.path) project.path = p.path;
  project.knownsVersion = p.knownsVersion;
  const body = {
    schemaVersion: result.schemaVersion,
    verdict: result.verdict,
    strict: result.strict,
    project,
    summary: result.summary,
    checks,
  };
  // Go's encoder runs with SetEscapeHTML(false): only the JSON syntax is escaped.
  return `${JSON.stringify(body, null, 2)}\n`;
}

function renderChecks(
  out: string[],
  checks: CheckResult[],
  verbose: boolean,
  styled: boolean,
): void {
  const visible = checks.filter((c) => verbose || c.status === "warn" || c.status === "fail");
  if (visible.length === 0) return;
  out.push("\n");
  out.push(styled ? `${StyleBold.render("Checks")}\n` : "Checks:\n");
  for (const check of visible) {
    const label = check.status.toUpperCase();
    const status = styled ? styledStatus(check.status) : label;
    out.push(`  ${status} [${check.id}] ${check.summary}\n`);
    const reason = check.evidence?.reason;
    if (typeof reason === "string" && reason.trim() !== "") out.push(`    Reason: ${reason}\n`);
    if (verbose && check.evidence && Object.keys(check.evidence).length > 0) {
      out.push(`    Evidence: ${formatDoctorEvidence(check.evidence)}\n`);
    }
    if (check.skipReason) out.push(`    Skip reason: ${check.skipReason}\n`);
    if (check.remediation) {
      out.push(`    Remediation: ${check.remediation.description}\n`);
      if (check.remediation.command) out.push(`    Run: ${check.remediation.command}\n`);
    }
  }
}

function styledStatus(s: Status): string {
  const label = s.toUpperCase();
  switch (s) {
    case "pass":
      return StyleSuccess.render(label);
    case "warn":
      return StyleWarning.render(label);
    case "fail":
      return StyleError.render(label);
    default:
      return StyleDim.render(label);
  }
}

function styledVerdict(v: Verdict): string {
  const label = v.toUpperCase();
  return v === "healthy"
    ? StyleSuccess.render(label)
    : v === "degraded"
      ? StyleWarning.render(label)
      : StyleError.render(label);
}

export function renderDoctorPlain(result: Result, verbose: boolean): string {
  const out: string[] = ["Knowns Doctor\n"];
  out.push(
    result.project.active
      ? `Project: ${result.project.name} (${result.project.path})\n`
      : "Project: no active project\n",
  );
  out.push(`Version: ${result.project.knownsVersion}\n`);
  out.push(`Verdict: ${result.verdict.toUpperCase()}\n`);
  const s = result.summary;
  out.push(`Summary: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail, ${s.skip} skip\n`);
  renderChecks(out, result.checks, verbose, false);
  return out.join("");
}

export function renderDoctorStyled(result: Result, verbose: boolean): string {
  const out: string[] = [`${StyleBold.render("Knowns Doctor")}\n`];
  if (result.project.active) {
    out.push(
      `${StyleDim.render("Project:")} ${StyleInfo.render(`${result.project.name} (${result.project.path})`)}\n`,
    );
  } else {
    out.push(`${StyleDim.render("Project:")} ${StyleWarning.render("no active project")}\n`);
  }
  out.push(`${StyleDim.render("Version:")} ${result.project.knownsVersion}\n`);
  out.push(`${StyleDim.render("Verdict:")} ${styledVerdict(result.verdict)}\n`);
  const s = result.summary;
  out.push(
    `${StyleDim.render("Summary:")} ${s.pass} pass, ${s.warn} warn, ${s.fail} fail, ${s.skip} skip\n`,
  );
  renderChecks(out, result.checks, verbose, true);
  return out.join("");
}

/** The dependencies a test can replace. */
export interface DoctorRunDeps {
  checkersFor?: (
    project: import("../../domain/doctor/foundation.ts").DoctorProject | undefined,
    ctx: CommandContext,
  ) => Promise<import("../../domain/doctor/model.ts").Checker[]>;
}

async function defaultCheckers(
  project: import("../../domain/doctor/foundation.ts").DoctorProject | undefined,
  ctx: CommandContext,
) {
  const { allCheckers, inspectQdrantReadOnly } = await import("../../domain/doctor/index.ts");
  const { statusAll, runtimeNames } = await import("../../domain/setup/runtimeinstall.ts");
  const { defaultOptions } = await import("../../domain/setup/runtimeinstall.ts");
  const { lookPath } = await import("../../domain/setup/env.ts");
  const { defaultExists, defaultReadFile } = await import("../../domain/doctor/local.ts");
  const { detectEmbedding } = await import("./runtime-ps.ts");
  const { skillsOutOfSync, staleSkillDirs, skillRootsUnder } = await import(
    "../../domain/instructions/index.ts"
  );
  const { globalSkillsScopeDefault, EmbeddingSettingsStore } = await import(
    "../../storage/stores/embedding-settings-store.ts"
  );
  const { userHomeDir } = await import("../../domain/setup/env.ts");
  const { join } = await import("node:path");
  const { buildReadiness, inactivePayload } = await import("../../domain/readiness/index.ts");
  const { buildSearchEnvironment } = await import("../../domain/searchenv/index.ts");
  const { all: allLspAdapters } = await import("../../lsp/adapters/index.ts");
  const env = ctx.env;
  const settingsPath = (): string => join(userHomeDir(env), ".knowns", "settings.json");

  return allCheckers(project, {
    project,
    env,
    readiness: () => {
      if (!project) return inactivePayload();
      return buildReadiness(project.storage, buildSearchEnvironment({ env }), { lsp: [] });
    },
    embedding: () => detectEmbedding(project?.store, env),
    lspStatuses: async () => {
      if (!project) return [];
      const { collectProjectRuntimeStatuses } = await import("../../lsp/project.ts");
      return collectProjectRuntimeStatuses(project.store.projectRoot);
    },
    lspIds: () =>
      allLspAdapters()
        .map((a) => a.id())
        .sort(cmp),
    runtimeHooks: () => statusAll(defaultOptions(env, ctx.cwd)),
    runtimeNames,
    skillsOutOfSync,
    globalSkills: () => {
      try {
        return staleSkillDirs(skillRootsUnder(userHomeDir(env)));
      } catch {
        return [];
      }
    },
    globalScope: () => globalSkillsScopeDefault(new EmbeddingSettingsStore(settingsPath())),
    exists: defaultExists,
    lookPath: (n) => lookPath(n, env),
    readFile: defaultReadFile,
    qdrant: (signal) => {
      if (!project) throw new Error("project store unavailable");
      return inspectQdrantReadOnly(project, env, signal);
    },
  });
}

export const doctorDeps: DoctorRunDeps = {};

export default defineCommand({
  use: "doctor",
  short: "Diagnose project and local integration health",
  long: `Run read-only diagnostics for the active Knowns project.

Every applicable check runs, including bounded probes of the configured
embedding provider. Use --scope to select diagnostic areas and --verbose to
show passing and skipped checks.`,
  flags: [
    { type: "bool", name: "verbose", usage: "Show passing and skipped checks", default: false },
    {
      type: "bool",
      name: "strict",
      usage: "Return exit code 1 when the verdict is degraded",
      default: false,
    },
    {
      type: "stringSlice",
      name: "scope",
      usage: "Diagnostic scope (repeatable or comma-separated)",
      default: [],
    },
  ],
  flagError: (_cmd, err) => exitError(2, err),
  async run(ctx) {
    const model = await import("../../domain/doctor/model.ts");
    if (ctx.args.length > 0) {
      throw exitError(
        2,
        new Error(`unknown command ${JSON.stringify(ctx.args[0])} for "knowns doctor"`),
      );
    }
    let scopes: Scope[];
    try {
      scopes = parseDoctorScopes(ctx.flags.strings("scope"), model.isScope);
    } catch (e) {
      throw exitError(2, e as Error);
    }

    const { findProjectRoot } = await import("../../storage/core/project-location.ts");
    const { Store } = await import("../../storage/core/index.ts");
    const { createStorage } = await import("../../storage/adapters.ts");
    let project: import("../../domain/doctor/foundation.ts").DoctorProject | undefined;
    try {
      const root = findProjectRoot(ctx.cwd);
      const store = Store.open(root);
      project = { store, storage: createStorage(store) };
    } catch {
      project = undefined;
    }

    const strict = ctx.flags.bool("strict");
    let result: Result;
    try {
      const { projectFromStore } = await import("../../domain/doctor/foundation.ts");
      const checkers = await (doctorDeps.checkersFor ?? defaultCheckers)(project, ctx);
      result = await model.run({ project: projectFromStore(project), scopes, strict }, checkers);
    } catch (e) {
      throw exitError(2, new Error(`run doctor: ${(e as Error).message}`));
    }

    const verbose = ctx.flags.bool("verbose");
    if (ctx.json) ctx.print(doctorJson(result));
    else if (ctx.plain) ctx.print(renderDoctorPlain(result, verbose));
    else ctx.print(renderDoctorStyled(result, verbose));

    const code = model.exitCode(result);
    if (code !== 0) throw new SilentExit(code);
  },
});
