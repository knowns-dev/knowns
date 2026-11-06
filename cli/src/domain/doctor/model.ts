// Port of internal/doctor/model.go and runner.go: the read-only diagnostic model and the check
// runner behind `knowns doctor`. Nothing here imports src/cli, so the MCP and server layers can
// run the same checks.
import { VERSION } from "../../version.ts";

export const SCHEMA_VERSION = 2;

export type Status = "pass" | "warn" | "fail" | "skip";
export type Verdict = "healthy" | "degraded" | "unhealthy";
export type Scope = "project" | "validation" | "search" | "runtime" | "lsp" | "ai" | "online";

const SCOPE_ORDER: Record<Scope, number> = {
  project: 0,
  validation: 1,
  search: 2,
  runtime: 3,
  lsp: 4,
  ai: 5,
  online: 6,
};

export const allScopes = (): Scope[] => [
  "project",
  "validation",
  "search",
  "runtime",
  "lsp",
  "ai",
  "online",
];
export const isScope = (s: string): s is Scope => Object.hasOwn(SCOPE_ORDER, s);
const isStatus = (s: string): s is Status =>
  s === "pass" || s === "warn" || s === "fail" || s === "skip";

export interface ProjectInfo {
  active: boolean;
  name?: string;
  path?: string;
  knownsVersion: string;
}

export const inactiveProject = (): ProjectInfo => ({ active: false, knownsVersion: VERSION });

export interface Summary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
}

export interface Remediation {
  description: string;
  command?: string;
}

/** Safe scalar metadata and string lists only: never raw config, log content or errors. */
export type EvidenceValue = null | boolean | string | number | string[] | Evidence | Evidence[];
export interface Evidence {
  [key: string]: EvidenceValue;
}

export interface CheckResult {
  id: string;
  scope: Scope;
  status: Status;
  summary: string;
  evidence?: Evidence;
  remediation?: Remediation;
  skipReason?: string;
}

/** What a check returns; the runner fills id and scope and normalizes the rest. */
export type CheckOutcome = Omit<CheckResult, "id" | "scope">;

export interface Result {
  schemaVersion: number;
  verdict: Verdict;
  strict: boolean;
  project: ProjectInfo;
  summary: Summary;
  checks: CheckResult[];
}

export const exitCode = (r: Result): number =>
  r.verdict === "unhealthy" || (r.strict && r.verdict === "degraded") ? 1 : 0;

const deriveVerdict = (s: Summary): Verdict =>
  s.fail > 0 ? "unhealthy" : s.warn > 0 ? "degraded" : "healthy";

const EVIDENCE_KEY = /^[a-z][A-Za-z0-9]*$/;

function validEvidence(e: Evidence | undefined): boolean {
  if (!e) return true;
  for (const [key, value] of Object.entries(e)) {
    if (!EVIDENCE_KEY.test(key)) return false;
    if (value === null) continue;
    switch (typeof value) {
      case "boolean":
      case "string":
      case "number":
        continue;
    }
    if (Array.isArray(value)) {
      if (value.every((v) => typeof v === "string")) continue;
      if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
        if ((value as Evidence[]).every(validEvidence)) continue;
      }
      return false;
    }
    if (typeof value === "object" && validEvidence(value as Evidence)) continue;
    return false;
  }
  return true;
}

// --- runner --------------------------------------------------------------------------------------

export const DEFAULT_CHECK_TIMEOUT_MS = 2000;

export interface Checker {
  id: string;
  scope: Scope;
  timeoutMs?: number;
  check: (signal: AbortSignal) => Promise<CheckOutcome> | CheckOutcome;
}

export interface RunOptions {
  project: ProjectInfo;
  scopes?: Scope[];
  strict?: boolean;
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
}

function normalizedFailure(checker: Checker, summary: string, code: string): CheckResult {
  return {
    id: checker.id,
    scope: checker.scope,
    status: "fail",
    summary,
    evidence: { errorCode: code },
    remediation: { description: "Review the affected subsystem and rerun knowns doctor." },
  };
}

function normalizeResult(checker: Checker, outcome: CheckOutcome): CheckResult {
  const result: CheckResult = { id: checker.id, scope: checker.scope, ...outcome };
  if (!isStatus(result.status)) {
    return normalizedFailure(checker, "Check returned an invalid status", "invalid_status");
  }
  if (!validEvidence(result.evidence)) {
    return normalizedFailure(checker, "Check produced unsafe evidence", "unsafe_evidence");
  }
  if (result.summary === "") result.summary = "Check completed";
  if (result.status === "skip" && (result.skipReason ?? "") === "") {
    result.skipReason = "not_applicable";
  }
  if ((result.status === "warn" || result.status === "fail") && !result.remediation) {
    result.remediation = {
      description:
        "Review this diagnostic and resolve the reported condition, then rerun knowns doctor.",
    };
  }
  return result;
}

async function runChecker(
  checker: Checker,
  fallbackMs: number,
  parent: AbortSignal | undefined,
): Promise<CheckResult> {
  const ms = checker.timeoutMs && checker.timeoutMs > 0 ? checker.timeoutMs : fallbackMs;
  const controller = new AbortController();
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, ms);
  });
  try {
    const run = (async () => checker.check(controller.signal))();
    // A rejection after the timeout won must not become an unhandled rejection.
    run.catch(() => undefined);
    const won = await Promise.race([
      run.then(
        (r) => ({ r }),
        (e: unknown) => ({ e }),
      ),
      timedOut,
    ]);
    if (won === "timeout") return normalizedFailure(checker, "Check timed out", "checker_timeout");
    if ("e" in won) return normalizedFailure(checker, "Check could not complete", "checker_error");
    return normalizeResult(checker, won.r);
  } finally {
    if (timer) clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

function validateRegistry(checkers: Checker[]): void {
  const seen = new Set<string>();
  for (const c of checkers) {
    if (c.id === "") throw new Error("doctor checker ID is required");
    if (!isScope(c.scope)) {
      throw new Error(
        `doctor checker ${JSON.stringify(c.id)} has invalid scope ${JSON.stringify(c.scope)}`,
      );
    }
    if (seen.has(c.id)) throw new Error(`duplicate doctor checker ID ${JSON.stringify(c.id)}`);
    seen.add(c.id);
  }
}

export async function run(opts: RunOptions, checkers: Checker[]): Promise<Result> {
  const wanted = new Set(opts.scopes ?? []);
  for (const s of wanted) {
    if (!isScope(s)) throw new Error(`unknown doctor scope ${JSON.stringify(s)}`);
  }
  validateRegistry(checkers);

  const selected = checkers.filter((c) => wanted.size === 0 || wanted.has(c.scope));
  // Stable sort: scope order, then ID (byte order, as Go compares strings).
  selected.sort((a, b) => {
    if (SCOPE_ORDER[a.scope] !== SCOPE_ORDER[b.scope])
      return SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const result: Result = {
    schemaVersion: SCHEMA_VERSION,
    verdict: "healthy",
    strict: opts.strict ?? false,
    project:
      opts.project.knownsVersion === ""
        ? { ...opts.project, knownsVersion: VERSION }
        : opts.project,
    summary: { pass: 0, warn: 0, fail: 0, skip: 0 },
    checks: [],
  };
  const fallback =
    opts.defaultTimeoutMs && opts.defaultTimeoutMs > 0
      ? opts.defaultTimeoutMs
      : DEFAULT_CHECK_TIMEOUT_MS;
  for (const checker of selected) {
    if (opts.signal?.aborted) throw new Error("context canceled");
    const r = await runChecker(checker, fallback, opts.signal);
    result.checks.push(r);
    result.summary[r.status]++;
  }
  result.verdict = deriveVerdict(result.summary);
  return result;
}
