/**
 * Retrieval evaluation (internal/search/evaluation.go, evaluation_report.go, evaluation_gate.go,
 * evaluation_runtime.go and the parts of benchmark.go they use): a versioned fixture of ranked
 * queries, metrics over what retrieval returned, a reviewed baseline and the gate between them.
 * Interfaces mirror Go's structs; property order is Go's field order, undefined is omitempty.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextItem, RetrievalResponse } from "../../models/search.ts";
import { goFsError } from "../../platform/goerror.ts";
import { GoJsonError, scanFirstValue } from "../../server/gojson.ts";
import { D2_MODELS } from "../../storage/stores/embedding-registry-defaults.ts";
import { formatFloat } from "../codegen/gofmt.ts";
import { CANONICAL_BASELINE_JSON, CANONICAL_FIXTURE_JSON } from "./canonical-data.ts";

export const EVALUATION_FIXTURE_SCHEMA_VERSION = 1;
export const EVALUATION_BASELINE_SCHEMA_VERSION = 1;
export const EVALUATION_REPORT_SCHEMA_VERSION = 1;

export const CANONICAL_EVALUATION_BASELINE_PATH =
  "internal/search/testdata/retrieval_evaluation_baseline.json";

export const OUTCOME_PASS = "pass";
export const OUTCOME_GATED_FAILURE = "gated-failure";
export const OUTCOME_HARD_INVARIANT = "hard-invariant-failure";
export const OUTCOME_READINESS = "readiness-failure";
export const OUTCOME_VALIDATION = "validation-failure";
export const OUTCOME_REPORT_ONLY = "report-only";

export const MOCK_EVALUATION_RUNTIME_IDENTITY = "mock/mock-deterministic@32";

const MODES = new Set(["keyword", "semantic", "hybrid"]);
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface EvaluationQrel {
  source: string;
  relevance: number;
}

export interface EvaluationCase {
  id: string;
  category: string;
  query: string;
  qrels: EvaluationQrel[] | null;
  expectedCitations?: string[];
  forbiddenSources?: string[];
  modes: string[] | null;
  limit?: number;
  sourceTypes?: string[];
  expandReferences?: boolean;
  includeHistorical?: boolean;
  notes?: string;
}

export interface EvaluationFixture {
  schemaVersion: number;
  cases: EvaluationCase[] | null;
}

export interface EvaluationMetrics {
  ndcgAt10: number;
  mrrAt10: number;
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  successAtK: number;
}

export interface EvaluationBaselineCase {
  id: string;
  metrics: EvaluationMetrics;
  candidateRanking: string[] | null;
  contextPackItems: string[] | null;
}

export interface EvaluationBaseline {
  schemaVersion: number;
  fixtureSchemaVersion: number;
  fixtureDigest: string;
  mode: string;
  runtimeIdentity: string;
  reason: string;
  tolerances: Record<string, number> | null;
  aggregate: EvaluationMetrics;
  cases: EvaluationBaselineCase[] | null;
}

export interface BenchmarkSummary {
  total: number;
  pass: number;
  partial: number;
  fail: number;
  skipped: number;
  topKUsed: number;
}

export interface ExpectedRank {
  source: string;
  relevance: number;
  candidateRank?: number;
  contextRank?: number;
}

export interface StageLatency {
  retrievalMillis: number;
  evaluationMillis: number;
  totalMillis: number;
}

export interface CaseReport {
  id: string;
  category: string;
  query: string;
  verdict: string;
  why: string;
  metrics: EvaluationMetrics;
  candidateRecall: number;
  contextPackRecall: number;
  candidateRanking: string[];
  contextPackItems: string[];
  expectedRanks: ExpectedRank[];
  relevantLost: string[];
  expectedCitations?: string[];
  observedCitations?: string[];
  forbiddenSourcesObserved?: string[];
  contextBytes: number;
  contextTokens: number;
  redundantItems?: string[];
  latency: StageLatency;
  notes?: string;
}

export interface EvaluationFailure {
  kind: string;
  caseId?: string;
  metric?: string;
  baseline?: number;
  observed?: number;
  delta?: number;
  tolerance?: number;
  message: string;
}

export interface EvaluationReport {
  schemaVersion: number;
  fixtureSchemaVersion: number;
  fixtureDigest: string;
  mode: string;
  runtimeIdentity: string;
  scope: string;
  reportOnly: boolean;
  outcome: string;
  summary: BenchmarkSummary;
  aggregate: EvaluationMetrics;
  latency: { p50Millis: number; p95Millis: number };
  cases: CaseReport[];
  failures: EvaluationFailure[];
}

/** An error that carries Go's os.ErrNotExist meaning (errors.Is(err, os.ErrNotExist)). */
export class NotExistError extends Error {}

/** Go's %q. */
function q(s: string): string {
  return JSON.stringify(s);
}

function goTrimSpace(s: string): string {
  return s.replace(/^[\s\u0085]+|[\s\u0085]+$/gu, "");
}

// --- strict decoding (json.Decoder with DisallowUnknownFields) -----------------------------------

type Spec =
  | { kind: "int" | "string" | "bool" | "float" }
  | { kind: "array"; elem: Spec; goName: string }
  | { kind: "map"; elem: Spec; goName: string }
  | { kind: "struct"; name: string; fields: Record<string, Spec> };

const INT: Spec = { kind: "int" };
const STR: Spec = { kind: "string" };
const BOOL: Spec = { kind: "bool" };
const FLOAT: Spec = { kind: "float" };
const strings: Spec = { kind: "array", elem: STR, goName: "[]string" };

const METRICS_SPEC: Spec = {
  kind: "struct",
  name: "EvaluationMetrics",
  fields: {
    ndcgAt10: FLOAT,
    mrrAt10: FLOAT,
    recallAt5: FLOAT,
    recallAt10: FLOAT,
    recallAt20: FLOAT,
    successAtK: FLOAT,
  },
};

const FIXTURE_SPEC: Spec = {
  kind: "struct",
  name: "RetrievalEvaluationFixture",
  fields: {
    schemaVersion: INT,
    cases: {
      kind: "array",
      goName: "[]search.RetrievalEvaluationCase",
      elem: {
        kind: "struct",
        name: "RetrievalEvaluationCase",
        fields: {
          id: STR,
          category: STR,
          query: STR,
          qrels: {
            kind: "array",
            goName: "[]search.EvaluationQrel",
            elem: {
              kind: "struct",
              name: "EvaluationQrel",
              fields: { source: STR, relevance: INT },
            },
          },
          expectedCitations: strings,
          forbiddenSources: strings,
          modes: strings,
          limit: INT,
          sourceTypes: strings,
          expandReferences: BOOL,
          includeHistorical: BOOL,
          notes: STR,
        },
      },
    },
  },
};

const BASELINE_SPEC: Spec = {
  kind: "struct",
  name: "RetrievalEvaluationBaseline",
  fields: {
    schemaVersion: INT,
    fixtureSchemaVersion: INT,
    fixtureDigest: STR,
    mode: STR,
    runtimeIdentity: STR,
    reason: STR,
    tolerances: { kind: "map", elem: FLOAT, goName: "map[string]float64" },
    aggregate: METRICS_SPEC,
    cases: {
      kind: "array",
      goName: "[]search.EvaluationBaselineCase",
      elem: {
        kind: "struct",
        name: "EvaluationBaselineCase",
        fields: {
          id: STR,
          metrics: METRICS_SPEC,
          candidateRanking: strings,
          contextPackItems: strings,
        },
      },
    },
  },
};

function goTypeOf(spec: Spec): string {
  switch (spec.kind) {
    case "int":
      return "int";
    case "string":
      return "string";
    case "bool":
      return "bool";
    case "float":
      return "float64";
    case "array":
    case "map":
      return spec.goName;
    case "struct":
      return `search.${spec.name}`;
  }
}

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  return "object";
}

function zero(spec: Spec): unknown {
  switch (spec.kind) {
    case "int":
    case "float":
      return 0;
    case "string":
      return "";
    case "bool":
      return false;
    case "array":
    case "map":
      return null;
    case "struct": {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(spec.fields)) out[k] = zero(s);
      return out;
    }
  }
}

/** Decodes into the zero value of `spec`, recording Go's first error (document order). */
class Decoder {
  err: string | undefined;

  private save(msg: string): void {
    if (this.err === undefined) this.err = msg;
  }

  private typeError(v: unknown, spec: Spec, struct: string | undefined, path: string[]): void {
    const k = kindOf(v);
    const shown = k === "number" && spec.kind === "int" ? `number ${String(v)}` : k;
    if (struct === undefined) {
      this.save(`json: cannot unmarshal ${shown} into Go value of type ${goTypeOf(spec)}`);
    } else {
      this.save(
        `json: cannot unmarshal ${shown} into Go struct field ${struct}.${path.join(".")} of type ${goTypeOf(spec)}`,
      );
    }
  }

  decode(v: unknown, spec: Spec, struct: string | undefined, path: string[]): unknown {
    if (v === null) return zero(spec);
    switch (spec.kind) {
      case "int":
        if (typeof v === "number" && Number.isInteger(v)) return v;
        this.typeError(v, spec, struct, path);
        return 0;
      case "float":
        if (typeof v === "number") return v;
        this.typeError(v, spec, struct, path);
        return 0;
      case "string":
        if (typeof v === "string") return v;
        this.typeError(v, spec, struct, path);
        return "";
      case "bool":
        if (typeof v === "boolean") return v;
        this.typeError(v, spec, struct, path);
        return false;
      case "array": {
        if (!Array.isArray(v)) {
          this.typeError(v, spec, struct, path);
          return null;
        }
        return v.map((e) => this.decode(e, spec.elem, struct, path));
      }
      case "map": {
        if (kindOf(v) !== "object") {
          this.typeError(v, spec, struct, path);
          return null;
        }
        const out: Record<string, unknown> = {};
        for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
          out[k] = this.decode(e, spec.elem, struct, path);
        }
        return out;
      }
      case "struct": {
        if (kindOf(v) !== "object") {
          this.typeError(v, spec, struct, path);
          return zero(spec);
        }
        const out = zero(spec) as Record<string, unknown>;
        const lower = new Map(Object.keys(spec.fields).map((f) => [f.toLowerCase(), f]));
        for (const [key, e] of Object.entries(v as Record<string, unknown>)) {
          const field = key in spec.fields ? key : lower.get(key.toLowerCase());
          if (field === undefined) {
            this.save(`json: unknown field ${q(key)}`);
            continue;
          }
          out[field] = this.decode(e, spec.fields[field] as Spec, spec.name, [...path, field]);
        }
        return out;
      }
    }
  }
}

/** One json.Decoder.Decode, the DisallowUnknownFields check and the trailing-data rule. */
function decodeStrict(text: string, spec: Spec, entity: string): unknown {
  let start: number;
  let end: number;
  try {
    [start, end] = scanFirstValue(text);
  } catch (e) {
    throw new Error(`decode evaluation ${entity}: ${(e as Error).message}`);
  }
  const d = new Decoder();
  const value = d.decode(JSON.parse(text.slice(start, end)), spec, undefined, []);
  if (d.err !== undefined) throw new Error(`decode evaluation ${entity}: ${d.err}`);
  const rest = text.slice(end);
  if (rest.trim() !== "") {
    try {
      scanFirstValue(rest);
    } catch (e) {
      if (e instanceof GoJsonError && e.message !== "EOF") {
        throw new Error(`decode evaluation ${entity} trailing data: ${e.message}`);
      }
      return value;
    }
    throw new Error(`decode evaluation ${entity}: multiple JSON values are not allowed`);
  }
  return value;
}

/** Normalizes the decoded shape to the interfaces (Go's omitempty fields become optional). */
function fixtureFrom(raw: Record<string, unknown>): EvaluationFixture {
  const cases = raw.cases as Record<string, unknown>[] | null;
  return {
    schemaVersion: raw.schemaVersion as number,
    cases:
      cases === null
        ? null
        : cases.map((c) => ({
            id: c.id as string,
            category: c.category as string,
            query: c.query as string,
            qrels: c.qrels as EvaluationQrel[] | null,
            expectedCitations: (c.expectedCitations as string[] | null) ?? undefined,
            forbiddenSources: (c.forbiddenSources as string[] | null) ?? undefined,
            modes: c.modes as string[] | null,
            limit: c.limit as number,
            sourceTypes: (c.sourceTypes as string[] | null) ?? undefined,
            expandReferences: c.expandReferences as boolean,
            includeHistorical: c.includeHistorical as boolean,
            notes: c.notes as string,
          })),
  };
}

export function decodeEvaluationFixture(text: string): EvaluationFixture {
  const fixture = fixtureFrom(
    decodeStrict(text, FIXTURE_SPEC, "fixture") as Record<string, unknown>,
  );
  validateEvaluationFixture(fixture);
  return fixture;
}

export function decodeEvaluationBaseline(text: string): EvaluationBaseline {
  const baseline = decodeStrict(text, BASELINE_SPEC, "baseline") as EvaluationBaseline;
  if (baseline.schemaVersion !== EVALUATION_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `baseline.schemaVersion: unsupported value ${baseline.schemaVersion} (expected ${EVALUATION_BASELINE_SCHEMA_VERSION})`,
    );
  }
  return baseline;
}

export function loadCanonicalEvaluationFixture(): EvaluationFixture {
  return decodeEvaluationFixture(CANONICAL_FIXTURE_JSON);
}

export function loadCanonicalEvaluationBaseline(): EvaluationBaseline {
  return decodeEvaluationBaseline(CANONICAL_BASELINE_JSON);
}

function readFileGo(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    const msg = `read evaluation ${what} ${q(path)}: ${goFsError("open", path, e).message}`;
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new NotExistError(msg);
    throw new Error(msg);
  }
}

export function loadEvaluationFixtureFile(path: string): EvaluationFixture {
  return decodeEvaluationFixture(readFileGo(path, "fixture"));
}

export function loadEvaluationBaselineFile(path: string): EvaluationBaseline {
  return decodeEvaluationBaseline(readFileGo(path, "baseline"));
}

// --- validation ----------------------------------------------------------------------------------

export function validateEvaluationFixture(fixture: EvaluationFixture | undefined): void {
  if (!fixture) throw new Error("fixture: required");
  if (fixture.schemaVersion !== EVALUATION_FIXTURE_SCHEMA_VERSION) {
    throw new Error(
      `fixture.schemaVersion: unsupported value ${fixture.schemaVersion} (expected ${EVALUATION_FIXTURE_SCHEMA_VERSION})`,
    );
  }
  const cases = fixture.cases ?? [];
  if (cases.length === 0) throw new Error("fixture.cases: at least one case is required");
  const ids = new Set<string>();
  cases.forEach((tc, i) => {
    const field = `cases[${i}]`;
    if (tc.id === "") throw new Error(`${field}.id: required`);
    if (!CASE_ID.test(tc.id)) throw new Error(`${field}.id: ${q(tc.id)} is not a stable case ID`);
    if (ids.has(tc.id)) throw new Error(`${field}.id: duplicate case ID ${q(tc.id)}`);
    ids.add(tc.id);
    if (goTrimSpace(tc.category) === "") throw new Error(`case ${q(tc.id)} category: required`);
    if (goTrimSpace(tc.query) === "") throw new Error(`case ${q(tc.id)} query: required`);
    if ((tc.limit ?? 0) < 0) throw new Error(`case ${q(tc.id)} limit: must be non-negative`);
    validateCaseModes(tc);
    validateCaseQrels(tc);
    validateUniqueStrings(tc.id, "expectedCitations", tc.expectedCitations ?? []);
    validateUniqueStrings(tc.id, "forbiddenSources", tc.forbiddenSources ?? []);
    for (const citation of tc.expectedCitations ?? []) {
      if ((tc.forbiddenSources ?? []).includes(citation)) {
        throw new Error(`case ${q(tc.id)} expectedCitations: ${q(citation)} is also forbidden`);
      }
    }
  });
}

function validateCaseModes(tc: EvaluationCase): void {
  const modes = tc.modes ?? [];
  if (modes.length === 0) throw new Error(`case ${q(tc.id)} modes: at least one mode is required`);
  const seen = new Set<string>();
  modes.forEach((mode, i) => {
    if (!MODES.has(mode))
      throw new Error(`case ${q(tc.id)} modes[${i}]: unsupported mode ${q(mode)}`);
    if (seen.has(mode)) throw new Error(`case ${q(tc.id)} modes[${i}]: duplicate mode ${q(mode)}`);
    seen.add(mode);
  });
}

function validateCaseQrels(tc: EvaluationCase): void {
  const qrels = tc.qrels ?? [];
  if (qrels.length === 0) throw new Error(`case ${q(tc.id)} qrels: at least one qrel is required`);
  const seen = new Set<string>();
  let relevant = 0;
  qrels.forEach((qrel, i) => {
    if (goTrimSpace(qrel.source) === "") {
      throw new Error(`case ${q(tc.id)} qrels[${i}].source: required`);
    }
    if (seen.has(qrel.source)) {
      throw new Error(`case ${q(tc.id)} qrels[${i}].source: duplicate source ${q(qrel.source)}`);
    }
    seen.add(qrel.source);
    if (qrel.relevance < 0 || qrel.relevance > 3) {
      throw new Error(
        `case ${q(tc.id)} qrels[${i}].relevance: got ${qrel.relevance}, expected 0..3`,
      );
    }
    if (qrel.relevance > 0) relevant++;
  });
  if (relevant === 0) {
    throw new Error(`case ${q(tc.id)} qrels: at least one source must have relevance > 0`);
  }
}

function validateUniqueStrings(caseId: string, field: string, values: string[]): void {
  const seen = new Set<string>();
  values.forEach((value, i) => {
    if (goTrimSpace(value) === "") throw new Error(`case ${q(caseId)} ${field}[${i}]: required`);
    if (seen.has(value)) {
      throw new Error(`case ${q(caseId)} ${field}[${i}]: duplicate value ${q(value)}`);
    }
    seen.add(value);
  });
}

const METRIC_NAMES = [
  "ndcgAt10",
  "mrrAt10",
  "recallAt5",
  "recallAt10",
  "recallAt20",
  "successAtK",
] as const;

function metricValue(m: EvaluationMetrics, name: string): number | undefined {
  return (METRIC_NAMES as readonly string[]).includes(name)
    ? m[name as keyof EvaluationMetrics]
    : undefined;
}

export function validateEvaluationBaseline(
  fixture: EvaluationFixture,
  baseline: EvaluationBaseline | undefined,
  mode: string,
  runtimeIdentityIn: string,
): void {
  validateEvaluationFixture(fixture);
  if (!baseline) {
    throw new Error("baseline: required; run an explicit baseline update with a review reason");
  }
  if (baseline.schemaVersion !== EVALUATION_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `baseline.schemaVersion: unsupported value ${baseline.schemaVersion} (expected ${EVALUATION_BASELINE_SCHEMA_VERSION})`,
    );
  }
  if (baseline.fixtureSchemaVersion !== fixture.schemaVersion) {
    throw new Error(
      `baseline.fixtureSchemaVersion: got ${baseline.fixtureSchemaVersion}, fixture uses ${fixture.schemaVersion}`,
    );
  }
  if (!MODES.has(mode)) throw new Error(`mode: unsupported evaluation mode ${q(mode)}`);
  if (baseline.mode !== mode)
    throw new Error(`baseline.mode: got ${q(baseline.mode)}, expected ${q(mode)}`);
  if (goTrimSpace(baseline.reason) === "") throw new Error("baseline.reason: required");
  let runtimeIdentity = runtimeIdentityIn;
  if (goTrimSpace(runtimeIdentity) === "") {
    if (mode === "keyword") runtimeIdentity = "keyword";
    else throw new Error(`runtimeIdentity: required for ${mode} evaluation`);
  }
  if (baseline.runtimeIdentity !== runtimeIdentity) {
    throw new Error(
      `baseline.runtimeIdentity: got ${q(baseline.runtimeIdentity)}, pinned runtime is ${q(runtimeIdentity)}`,
    );
  }
  if (baseline.fixtureDigest !== evaluationFixtureDigest(fixture)) {
    throw new Error(
      "baseline.fixtureDigest: fixture changed; run an explicit baseline update with a review reason",
    );
  }
  const tolerances = Object.entries(baseline.tolerances ?? {});
  if (tolerances.length === 0) {
    throw new Error("baseline.tolerances: at least one gated metric is required");
  }
  // Go ranges over a map here (unordered); the first failing entry is reported.
  for (const [name, tolerance] of tolerances) {
    if (metricValue(baseline.aggregate, name) === undefined) {
      throw new Error(`baseline.tolerances.${name}: unsupported metric`);
    }
    if (tolerance < 0 || tolerance > 1) {
      throw new Error(`baseline.tolerances.${name}: must be between 0 and 1`);
    }
  }
  const baselineCases = new Set<string>();
  (baseline.cases ?? []).forEach((tc, i) => {
    if (tc.id === "") throw new Error(`baseline.cases[${i}].id: required`);
    if (baselineCases.has(tc.id)) {
      throw new Error(`baseline.cases[${i}].id: duplicate case ID ${q(tc.id)}`);
    }
    baselineCases.add(tc.id);
  });
  for (const tc of fixture.cases ?? []) {
    if (!baselineCases.has(tc.id)) {
      throw new Error(
        `baseline.cases: canonical case ${q(tc.id)} has no baseline; run an explicit baseline update with a review reason`,
      );
    }
  }
  const fixtureIds = new Set((fixture.cases ?? []).map((c) => c.id));
  for (const id of baselineCases) {
    if (!fixtureIds.has(id))
      throw new Error(`baseline.cases: case ${q(id)} is not present in the fixture`);
  }
}

// --- digest (json.Marshal of the fixture) --------------------------------------------------------

/** Go's encoding/json string encoding. */
function goJSONString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || ch === "<" || ch === ">" || ch === "&" || c === 0x2028 || c === 0x2029) {
      out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return `${out}"`;
}

function strArray(xs: string[] | null | undefined): string {
  if (xs === null || xs === undefined) return "null";
  return `[${xs.map(goJSONString).join(",")}]`;
}

export function marshalFixture(fixture: EvaluationFixture): string {
  const cases =
    fixture.cases === null
      ? "null"
      : `[${fixture.cases
          .map((c) => {
            const parts = [
              `"id":${goJSONString(c.id)}`,
              `"category":${goJSONString(c.category)}`,
              `"query":${goJSONString(c.query)}`,
              `"qrels":${
                c.qrels === null
                  ? "null"
                  : `[${c.qrels.map((r) => `{"source":${goJSONString(r.source)},"relevance":${r.relevance}}`).join(",")}]`
              }`,
            ];
            if (c.expectedCitations && c.expectedCitations.length > 0) {
              parts.push(`"expectedCitations":${strArray(c.expectedCitations)}`);
            }
            if (c.forbiddenSources && c.forbiddenSources.length > 0) {
              parts.push(`"forbiddenSources":${strArray(c.forbiddenSources)}`);
            }
            parts.push(`"modes":${strArray(c.modes)}`);
            if (c.limit) parts.push(`"limit":${c.limit}`);
            if (c.sourceTypes && c.sourceTypes.length > 0) {
              parts.push(`"sourceTypes":${strArray(c.sourceTypes)}`);
            }
            if (c.expandReferences) parts.push('"expandReferences":true');
            if (c.includeHistorical) parts.push('"includeHistorical":true');
            if (c.notes) parts.push(`"notes":${goJSONString(c.notes)}`);
            return `{${parts.join(",")}}`;
          })
          .join(",")}]`;
  return `{"schemaVersion":${fixture.schemaVersion},"cases":${cases}}`;
}

export function evaluationFixtureDigest(fixture: EvaluationFixture): string {
  validateEvaluationFixture(fixture);
  return createHash("sha256").update(marshalFixture(fixture), "utf8").digest("hex");
}

// --- metrics -------------------------------------------------------------------------------------

/** Go's math.Log2: exact for powers of two, else Log(frac)/Ln2 + exp. */
function goLog2(x: number): number {
  let exp = Math.floor(Math.log2(x)) + 1;
  let frac = x / 2 ** exp;
  // Normalize to [0.5, 1) as math.Frexp does.
  while (frac >= 1) {
    frac /= 2;
    exp++;
  }
  while (frac < 0.5) {
    frac *= 2;
    exp--;
  }
  if (frac === 0.5) return exp - 1;
  return Math.log(frac) * (1 / Math.LN2) + exp;
}

const zeroMetrics = (): EvaluationMetrics => ({
  ndcgAt10: 0,
  mrrAt10: 0,
  recallAt5: 0,
  recallAt10: 0,
  recallAt20: 0,
  successAtK: 0,
});

export function evaluateRankingMetrics(
  qrels: EvaluationQrel[],
  observed: string[],
  successKIn: number,
): EvaluationMetrics {
  const successK = successKIn <= 0 ? 10 : successKIn;
  const relevance = new Map<string, number>();
  let relevantCount = 0;
  const ideal: number[] = [];
  for (const qrel of qrels) {
    relevance.set(qrel.source, qrel.relevance);
    if (qrel.relevance > 0) {
      relevantCount++;
      ideal.push(qrel.relevance);
    }
  }
  ideal.sort((a, b) => b - a);

  const relevantAt = (limitIn: number): number => {
    const limit = Math.min(limitIn, observed.length);
    const seen = new Set<string>();
    let count = 0;
    for (const source of observed.slice(0, limit)) {
      if (seen.has(source)) continue;
      seen.add(source);
      if ((relevance.get(source) ?? 0) > 0) count++;
    }
    return count;
  };
  const recall = (limit: number): number =>
    relevantCount === 0 ? 0 : relevantAt(limit) / relevantCount;

  let dcg = 0;
  let firstRelevantRank = 0;
  observed.slice(0, Math.min(10, observed.length)).forEach((source, i) => {
    const rel = relevance.get(source) ?? 0;
    if (rel <= 0) return;
    dcg += (2 ** rel - 1) / goLog2(i + 2);
    if (firstRelevantRank === 0) firstRelevantRank = i + 1;
  });
  let idcg = 0;
  ideal.slice(0, Math.min(10, ideal.length)).forEach((rel, i) => {
    idcg += (2 ** rel - 1) / goLog2(i + 2);
  });
  return {
    ndcgAt10: idcg > 0 ? dcg / idcg : 0,
    mrrAt10: firstRelevantRank > 0 ? 1 / firstRelevantRank : 0,
    recallAt5: recall(5),
    recallAt10: recall(10),
    recallAt20: recall(20),
    successAtK: relevantAt(successK) > 0 ? 1 : 0,
  };
}

export function aggregateEvaluationMetrics(metrics: EvaluationMetrics[]): EvaluationMetrics {
  const out = zeroMetrics();
  if (metrics.length === 0) return out;
  for (const m of metrics) for (const k of METRIC_NAMES) out[k] += m[k];
  for (const k of METRIC_NAMES) out[k] /= metrics.length;
  return out;
}

/** Nearest-rank p50 and p95 over durations in nanoseconds. */
function summarizeLatency(samplesNs: number[]): { p50Millis: number; p95Millis: number } {
  if (samplesNs.length === 0) return { p50Millis: 0, p95Millis: 0 };
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const pct = (p: number): number => {
    const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
    return (sorted[idx] as number) / 1e6;
  };
  return { p50Millis: pct(0.5), p95Millis: pct(0.95) };
}

// --- benchmark helpers (benchmark.go) ------------------------------------------------------------

interface BenchmarkHit {
  type: string;
  id: string;
}

function classifyBenchmarkCase(expected: string[], results: BenchmarkHit[]): [string, string] {
  if (results.length === 0) return ["fail", "no results"];
  const top = results.slice(0, Math.min(3, results.length));
  let matchedTop3 = 0;
  for (const e of expected) if (top.some((r) => r.id === e)) matchedTop3++;
  if (
    matchedTop3 === expected.length ||
    (expected.length > 0 && (results[0] as BenchmarkHit).id === expected[0])
  ) {
    return ["pass", "expected result is in top results"];
  }
  for (const e of expected) {
    if (results.some((r) => r.id === e)) {
      return ["partial", "expected result found but ranked below top 3"];
    }
  }
  return ["fail", "expected result missing"];
}

function rankOf(keys: string[], key: string): number {
  const i = keys.indexOf(key);
  return i === -1 ? 0 : i + 1;
}

// --- report --------------------------------------------------------------------------------------

export type RetrievalExecutor = (tc: EvaluationCase, mode: string) => Promise<RetrievalResponse>;

export interface EvaluationOptions {
  mode: string;
  runtimeIdentity: string;
  scope: string;
  reportOnly: boolean;
  /** Monotonic clock in nanoseconds (tests). */
  nowNs?: () => number;
}

function relevantQrelSources(qrels: EvaluationQrel[]): string[] {
  return qrels
    .filter((r) => r.relevance > 0)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.relevance !== b.r.relevance) return b.r.relevance - a.r.relevance;
      if (a.r.source !== b.r.source) return a.r.source < b.r.source ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.r.source);
}

function recallForAllRelevant(qrels: EvaluationQrel[], observed: string[]): number {
  const relevant = relevantQrelSources(qrels);
  if (relevant.length === 0) return 0;
  return relevant.filter((s) => observed.includes(s)).length / relevant.length;
}

function citationKey(c: { type: string; id: string; path?: string } | undefined): string {
  if (!c || c.type === "") return "";
  if (c.path) return `${c.type}:${c.path}`;
  if (c.id !== "") return `${c.type}:${c.id}`;
  return "";
}

function contextPackCitations(items: ContextItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const key = citationKey(item.citation);
    if (key !== "" && !out.includes(key)) out.push(key);
  }
  return out;
}

function observedForbiddenSources(tc: EvaluationCase, response: RetrievalResponse): string[] {
  const keys = new Set<string>();
  const add = (
    type: string,
    id: string,
    path: string | undefined,
    citation: { type: string; id: string; path?: string },
  ) => {
    if (id !== "") {
      keys.add(id);
      if (type !== "") keys.add(`${type}:${id}`);
    }
    if (path) {
      keys.add(path);
      if (type !== "") keys.add(`${type}:${path}`);
    }
    const ck = citationKey(citation);
    if (ck !== "") keys.add(ck);
  };
  for (const c of response.candidates ?? []) add(c.type, c.id, c.path, c.citation);
  for (const item of response.contextPack.items ?? []) {
    add(item.type, item.id, item.citation.path, item.citation);
  }
  return (tc.forbiddenSources ?? []).filter((f) => keys.has(f));
}

function contextPackRedundancy(items: ContextItem[]): string[] {
  const seenIds = new Set<string>();
  const owners = new Map<string, string>();
  const redundant: string[] = [];
  for (const item of items) {
    if (seenIds.has(item.id)) redundant.push(`duplicate-id:${item.id}`);
    seenIds.add(item.id);
    const content = goTrimSpace(item.content);
    if (content === "") continue;
    const digest = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    const owner = owners.get(digest);
    if (owner !== undefined && owner !== item.id) {
      redundant.push(`duplicate-content:${owner}:${item.id}`);
    } else {
      owners.set(digest, item.id);
    }
  }
  return redundant.sort();
}

function buildCaseReport(
  tc: EvaluationCase,
  response: RetrievalResponse,
): { report: CaseReport; verdict: string; failures: EvaluationFailure[] } {
  const candidates = response.candidates ?? [];
  const items = response.contextPack.items ?? [];
  const candidateRanking = candidates.map((c) => c.id);
  const contextItems = items.map((i) => i.id);
  const qrels = tc.qrels ?? [];
  const [verdict, why] = classifyBenchmarkCase(
    relevantQrelSources(qrels),
    candidates.map((c) => ({ type: c.type, id: c.id })),
  );
  const metrics = evaluateRankingMetrics(qrels, candidateRanking, 10);
  const expectedRanks: ExpectedRank[] = [];
  const relevantLost: string[] = [];
  for (const qrel of qrels) {
    if (qrel.relevance <= 0) continue;
    const candidateRank = rankOf(candidateRanking, qrel.source);
    const contextRank = rankOf(contextItems, qrel.source);
    expectedRanks.push({
      source: qrel.source,
      relevance: qrel.relevance,
      candidateRank: candidateRank || undefined,
      contextRank: contextRank || undefined,
    });
    if (candidateRank > 0 && contextRank === 0) relevantLost.push(qrel.source);
  }
  const observedCitations = contextPackCitations(items);
  const failures: EvaluationFailure[] = [];
  for (const expected of tc.expectedCitations ?? []) {
    if (!observedCitations.includes(expected)) {
      failures.push({
        kind: OUTCOME_HARD_INVARIANT,
        caseId: tc.id,
        message: `expected citation ${q(expected)} is absent from the final ContextPack`,
      });
    }
  }
  const forbidden = observedForbiddenSources(tc, response);
  for (const source of forbidden) {
    failures.push({
      kind: OUTCOME_HARD_INVARIANT,
      caseId: tc.id,
      message: `forbidden or stale source ${q(source)} was selected`,
    });
  }
  let contextBytes = 0;
  for (const item of items) contextBytes += Buffer.byteLength(item.content, "utf8");
  const redundant = contextPackRedundancy(items);
  const nonEmpty = (xs: string[] | undefined): string[] | undefined =>
    xs && xs.length > 0 ? xs : undefined;
  return {
    report: {
      id: tc.id,
      category: tc.category,
      query: tc.query,
      verdict,
      why,
      metrics,
      candidateRecall: recallForAllRelevant(qrels, candidateRanking),
      contextPackRecall: recallForAllRelevant(qrels, contextItems),
      candidateRanking,
      contextPackItems: contextItems,
      expectedRanks,
      relevantLost,
      expectedCitations: nonEmpty(tc.expectedCitations),
      observedCitations: nonEmpty(observedCitations),
      forbiddenSourcesObserved: nonEmpty(forbidden),
      contextBytes,
      contextTokens: Math.trunc((contextBytes + 3) / 4),
      redundantItems: nonEmpty(redundant),
      latency: { retrievalMillis: 0, evaluationMillis: 0, totalMillis: 0 },
      notes: tc.notes || undefined,
    },
    verdict,
    failures,
  };
}

const monoNs = (): number => Number(process.hrtime.bigint());

export async function evaluateRetrievalFixture(
  fixture: EvaluationFixture,
  execute: RetrievalExecutor,
  opts: EvaluationOptions,
): Promise<EvaluationReport> {
  validateEvaluationFixture(fixture);
  if (!MODES.has(opts.mode)) throw new Error(`mode: unsupported evaluation mode ${q(opts.mode)}`);
  const cases = fixture.cases ?? [];
  for (const tc of cases) {
    if (!(tc.modes ?? []).includes(opts.mode)) {
      throw new Error(`case ${q(tc.id)} modes: mode ${q(opts.mode)} is not supported`);
    }
  }
  const now = opts.nowNs ?? monoNs;
  const scope = goTrimSpace(opts.scope) || "canonical";
  let runtimeIdentity = goTrimSpace(opts.runtimeIdentity);
  if (runtimeIdentity === "" && opts.mode === "keyword") runtimeIdentity = "keyword";
  const report: EvaluationReport = {
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    fixtureSchemaVersion: fixture.schemaVersion,
    fixtureDigest: evaluationFixtureDigest(fixture),
    mode: opts.mode,
    runtimeIdentity,
    scope,
    reportOnly: opts.reportOnly,
    outcome: OUTCOME_PASS,
    summary: { total: 0, pass: 0, partial: 0, fail: 0, skipped: 0, topKUsed: 0 },
    aggregate: zeroMetrics(),
    latency: { p50Millis: 0, p95Millis: 0 },
    cases: [],
    failures: [],
  };
  const verdicts: string[] = [];
  const latencies: number[] = [];
  for (const tc of cases) {
    const started = now();
    let response: RetrievalResponse;
    try {
      response = await execute(tc, opts.mode);
    } catch (e) {
      throw new Error(`case ${q(tc.id)} retrieval: ${(e as Error).message}`);
    }
    const retrieved = now();
    const built = buildCaseReport(tc, response);
    const finished = now();
    built.report.latency = {
      retrievalMillis: (retrieved - started) / 1e6,
      evaluationMillis: (finished - retrieved) / 1e6,
      totalMillis: (finished - started) / 1e6,
    };
    report.cases.push(built.report);
    report.failures.push(...built.failures);
    verdicts.push(built.verdict);
    latencies.push(finished - started);
  }
  const summary: BenchmarkSummary = {
    total: verdicts.length,
    pass: 0,
    partial: 0,
    fail: 0,
    skipped: 0,
    topKUsed: 10,
  };
  for (const v of verdicts) {
    if (v === "pass") summary.pass++;
    else if (v === "partial") summary.partial++;
    else if (v === "skip") summary.skipped++;
    else summary.fail++;
  }
  report.summary = summary;
  report.aggregate = aggregateEvaluationMetrics(report.cases.map((c) => c.metrics));
  report.latency = summarizeLatency(latencies);
  if (opts.reportOnly) report.outcome = OUTCOME_REPORT_ONLY;
  else if (report.failures.some((f) => f.kind === OUTCOME_HARD_INVARIANT)) {
    report.outcome = OUTCOME_HARD_INVARIANT;
  }
  return report;
}

export function evaluationFailureReport(
  mode: string,
  runtimeIdentity: string,
  scope: string,
  reportOnly: boolean,
  outcome: string,
  err: Error | undefined,
): EvaluationReport {
  return {
    schemaVersion: EVALUATION_REPORT_SCHEMA_VERSION,
    fixtureSchemaVersion: 0,
    fixtureDigest: "",
    mode,
    runtimeIdentity,
    scope,
    reportOnly,
    outcome,
    summary: { total: 0, pass: 0, partial: 0, fail: 0, skipped: 0, topKUsed: 0 },
    aggregate: zeroMetrics(),
    latency: { p50Millis: 0, p95Millis: 0 },
    cases: [],
    failures: [{ kind: outcome, message: err ? err.message : "evaluation failed" }],
  };
}

/** The report in Go's field order with omitempty applied (for MarshalIndent). */
export function reportJSON(r: EvaluationReport): unknown {
  return {
    ...r,
    cases: r.cases.map((c) => ({
      id: c.id,
      category: c.category,
      query: c.query,
      verdict: c.verdict,
      why: c.why,
      metrics: c.metrics,
      candidateRecall: c.candidateRecall,
      contextPackRecall: c.contextPackRecall,
      candidateRanking: c.candidateRanking,
      contextPackItems: c.contextPackItems,
      expectedRanks: c.expectedRanks,
      relevantLost: c.relevantLost,
      expectedCitations: c.expectedCitations,
      observedCitations: c.observedCitations,
      forbiddenSourcesObserved: c.forbiddenSourcesObserved,
      contextBytes: c.contextBytes,
      contextTokens: c.contextTokens,
      redundantItems: c.redundantItems,
      latency: c.latency,
      notes: c.notes,
    })),
    failures: r.failures.map((f) => ({
      kind: f.kind,
      caseId: f.caseId || undefined,
      metric: f.metric || undefined,
      baseline: f.baseline || undefined,
      observed: f.observed || undefined,
      delta: f.delta || undefined,
      tolerance: f.tolerance || undefined,
      message: f.message,
    })),
  };
}

const f4 = (x: number): string => formatFloat(x, "f", 4);
const f2 = (x: number): string => formatFloat(x, "f", 2);

export function formatRetrievalEvaluationReport(r: EvaluationReport): string {
  let b = `Retrieval evaluation: ${r.outcome}\n`;
  b += `Mode: ${r.mode} (${r.runtimeIdentity})\n`;
  b += `Scope: ${r.scope}`;
  if (r.reportOnly) b += " [report-only]";
  b += "\n";
  const s = r.summary;
  b += `Cases: ${s.total} | pass=${s.pass} partial=${s.partial} fail=${s.fail} skipped=${s.skipped}\n`;
  const a = r.aggregate;
  b += `Metrics: nDCG@10=${f4(a.ndcgAt10)} MRR@10=${f4(a.mrrAt10)} Recall@5=${f4(a.recallAt5)} Recall@10=${f4(a.recallAt10)} Recall@20=${f4(a.recallAt20)} Success@K=${f4(a.successAtK)}\n`;
  b += `Latency (report-only): p50=${f2(r.latency.p50Millis)}ms p95=${f2(r.latency.p95Millis)}ms\n`;
  for (const tc of r.cases) {
    // The dash below is part of Go's output text and is kept for byte parity.
    b += `\n[${tc.verdict.toUpperCase()}] ${tc.id} \u2014 ${tc.why}\n  candidateRecall=${f4(tc.candidateRecall)} contextPackRecall=${f4(tc.contextPackRecall)} context=${tc.contextBytes}B/~${tc.contextTokens} tokens latency=${f2(tc.latency.totalMillis)}ms\n`;
    for (const e of tc.expectedRanks) {
      b += `  expected ${e.source} (rel=${e.relevance}): candidateRank=${e.candidateRank ?? 0} contextRank=${e.contextRank ?? 0}\n`;
    }
    if (tc.relevantLost.length > 0) {
      b += `  lost during ContextPack assembly: ${tc.relevantLost.join(", ")}\n`;
    }
    if (tc.redundantItems && tc.redundantItems.length > 0) {
      b += `  redundancy: ${tc.redundantItems.join(", ")}\n`;
    }
  }
  if (r.failures.length > 0) {
    b += "\nFailures:\n";
    for (const f of r.failures) {
      const label = f.caseId ? ` [${f.caseId}]` : "";
      b += `  - ${f.kind}${label}: ${f.message}\n`;
    }
  }
  return b;
}

// --- gate and baseline ---------------------------------------------------------------------------

export function defaultEvaluationTolerances(): Record<string, number> {
  return {
    ndcgAt10: 0.01,
    mrrAt10: 0.01,
    recallAt5: 0.01,
    recallAt10: 0.01,
    recallAt20: 0.01,
    successAtK: 0,
  };
}

const byteSort = (xs: string[]): string[] =>
  xs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

export function applyEvaluationBaselineGate(
  report: EvaluationReport,
  baseline: EvaluationBaseline,
): void {
  if (report.reportOnly) {
    throw new Error("report-only evaluation cannot be compared with a canonical baseline");
  }
  const baselineCases = new Map((baseline.cases ?? []).map((c) => [c.id, c]));
  const currentCases = new Map(report.cases.map((c) => [c.id, c]));
  const tolerances = baseline.tolerances ?? {};
  for (const metric of byteSort(Object.keys(tolerances))) {
    const tolerance = tolerances[metric] as number;
    const baselineValue = metricValue(baseline.aggregate, metric);
    if (baselineValue === undefined)
      throw new Error(`baseline.tolerances.${metric}: unsupported metric`);
    const observedValue = metricValue(report.aggregate, metric) ?? 0;
    const delta = observedValue - baselineValue;
    if (delta >= -tolerance) continue;
    report.failures.push({
      kind: OUTCOME_GATED_FAILURE,
      metric,
      baseline: baselineValue,
      observed: observedValue,
      delta,
      tolerance,
      message: `${metric} regressed by ${f4(-delta)} (baseline ${f4(baselineValue)}, observed ${f4(observedValue)}, tolerance ${f4(tolerance)})`,
    });
    for (const id of byteSort([...currentCases.keys()])) {
      const bc = baselineCases.get(id);
      if (!bc) continue;
      const cc = currentCases.get(id) as CaseReport;
      const caseBaseline = metricValue(bc.metrics, metric) ?? 0;
      const caseObserved = metricValue(cc.metrics, metric) ?? 0;
      const caseDelta = caseObserved - caseBaseline;
      if (caseDelta >= 0) continue;
      report.failures.push({
        kind: OUTCOME_GATED_FAILURE,
        caseId: id,
        metric,
        baseline: caseBaseline,
        observed: caseObserved,
        delta: caseDelta,
        tolerance,
        message: `${metric} contributed a ${f4(-caseDelta)} regression; expected/observed ranks are in the case report`,
      });
    }
  }
  if (report.failures.some((f) => f.kind === OUTCOME_HARD_INVARIANT)) {
    report.outcome = OUTCOME_HARD_INVARIANT;
  } else if (report.failures.some((f) => f.kind === OUTCOME_GATED_FAILURE)) {
    report.outcome = OUTCOME_GATED_FAILURE;
  } else {
    report.outcome = OUTCOME_PASS;
  }
}

export function buildEvaluationBaseline(
  fixture: EvaluationFixture,
  report: EvaluationReport,
  reason: string,
  tolerancesIn: Record<string, number>,
): EvaluationBaseline {
  validateEvaluationFixture(fixture);
  if (goTrimSpace(reason) === "") throw new Error("baseline update reason: required");
  if (report.reportOnly || report.scope !== "canonical") {
    throw new Error("project-local or report-only evaluation cannot update the canonical baseline");
  }
  if (
    report.outcome === OUTCOME_HARD_INVARIANT ||
    report.outcome === OUTCOME_READINESS ||
    report.outcome === OUTCOME_VALIDATION
  ) {
    throw new Error(`cannot update baseline from ${report.outcome}`);
  }
  const tolerances =
    Object.keys(tolerancesIn).length === 0 ? defaultEvaluationTolerances() : tolerancesIn;
  const copy: Record<string, number> = {};
  for (const [metric, tolerance] of Object.entries(tolerances)) {
    if (metricValue(report.aggregate, metric) === undefined) {
      throw new Error(`baseline tolerance ${q(metric)}: unsupported metric`);
    }
    if (tolerance < 0 || tolerance > 1) {
      throw new Error(`baseline tolerance ${q(metric)}: must be between 0 and 1`);
    }
    copy[metric] = tolerance;
  }
  const digest = evaluationFixtureDigest(fixture);
  const reportCases = new Map(report.cases.map((c) => [c.id, c]));
  const cases: EvaluationBaselineCase[] = (fixture.cases ?? []).map((fc) => {
    const rc = reportCases.get(fc.id);
    if (!rc) throw new Error(`evaluation report: missing case ${q(fc.id)}`);
    return {
      id: fc.id,
      metrics: rc.metrics,
      candidateRanking: [...rc.candidateRanking],
      contextPackItems: [...rc.contextPackItems],
    };
  });
  return {
    schemaVersion: EVALUATION_BASELINE_SCHEMA_VERSION,
    fixtureSchemaVersion: fixture.schemaVersion,
    fixtureDigest: digest,
    mode: report.mode,
    runtimeIdentity: report.runtimeIdentity,
    reason: goTrimSpace(reason),
    tolerances: copy,
    aggregate: report.aggregate,
    cases,
  };
}

/** Go's MarshalIndent sorts map keys; the tolerances map is the only map here. */
export function baselineJSON(b: EvaluationBaseline): unknown {
  const tol = b.tolerances;
  return {
    ...b,
    tolerances:
      tol === null ? null : Object.fromEntries(byteSort(Object.keys(tol)).map((k) => [k, tol[k]])),
  };
}

/** WriteEvaluationBaseline: atomic replace through a temp file in the same directory. */
export function writeEvaluationBaseline(path: string, text: string): void {
  if (goTrimSpace(path) === "") throw new Error("baseline path: required");
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch (e) {
    throw new Error(`create evaluation baseline directory: ${(e as Error).message}`);
  }
  const temp = join(dir, `.retrieval-evaluation-baseline-${process.pid}${Date.now()}`);
  try {
    writeFileSync(temp, text, { mode: 0o644 });
  } catch (e) {
    rmSync(temp, { force: true });
    throw new Error(`write temporary evaluation baseline: ${(e as Error).message}`);
  }
  try {
    renameSync(temp, path);
  } catch (e) {
    if (process.platform !== "win32") {
      rmSync(temp, { force: true });
      throw new Error(`replace evaluation baseline: ${(e as Error).message}`);
    }
    try {
      rmSync(path, { force: true });
      renameSync(temp, path);
    } catch (retry) {
      rmSync(temp, { force: true });
      throw new Error(
        `replace evaluation baseline after Windows target removal: ${(retry as Error).message}`,
      );
    }
  }
}

/** PinnedSemanticRuntimeID: the D2 default model. */
export function pinnedSemanticRuntimeId(): string {
  const m = D2_MODELS.find((d) => d.default);
  if (!m) throw new Error("search: no default model in the D2 registry");
  return `ollama/${m.id}@${m.model.dimensions}`;
}
