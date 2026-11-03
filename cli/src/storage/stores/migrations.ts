// Port of internal/storage/migrations.go: versioned, idempotent project-config schema migrations
// (spec ollama-only-embedding D10/FR-18). `knowns migrate` runs these.
import type { Project } from "../../models/config.ts";
import { SCHEMA_VERSIONS } from "../../models/schema-version.ts";
import { resolveSemanticSearch } from "./embedding-registry-defaults.ts";

export interface Migration {
  /** The schema version this migration upgrades a project TO. */
  version: number;
  description: string;
  /** Mutates project in place; returns one human-readable line per actual change. */
  apply(project: Project): string[];
}

const q = (s: string) => JSON.stringify(s);

/** Migration v1: persist the FR-3/D1 resolution of `provider: local` to the Ollama D2 default. */
export function migrateLocalProviderToOllama(project: Project | undefined): string[] {
  const ss = project?.settings.semanticSearch;
  if (!ss) return [];
  const resolved = resolveSemanticSearch(ss);
  if (!resolved) return [];

  const same =
    (resolved.enabled ?? false) === (ss.enabled ?? false) &&
    resolved.model === ss.model &&
    (resolved.provider ?? "") === (ss.provider ?? "") &&
    (resolved.huggingFaceId ?? "") === (ss.huggingFaceId ?? "") &&
    (resolved.dimensions ?? 0) === (ss.dimensions ?? 0) &&
    (resolved.maxTokens ?? 0) === (ss.maxTokens ?? 0);
  if (same) return [];

  const changes: string[] = [];
  if ((resolved.provider ?? "") !== (ss.provider ?? "")) {
    const from = ss.provider ?? "";
    changes.push(
      `settings.semanticSearch.provider: ${q(from === "" ? "(empty)" : from)} -> ${q(resolved.provider ?? "")}`,
    );
  }
  if (resolved.model !== ss.model) {
    changes.push(`settings.semanticSearch.model: ${q(ss.model)} -> ${q(resolved.model)}`);
  }
  if ((resolved.dimensions ?? 0) !== (ss.dimensions ?? 0)) {
    changes.push(
      `settings.semanticSearch.dimensions: ${ss.dimensions ?? 0} -> ${resolved.dimensions ?? 0}`,
    );
  }
  if ((resolved.maxTokens ?? 0) !== (ss.maxTokens ?? 0)) {
    changes.push(
      `settings.semanticSearch.maxTokens: ${ss.maxTokens ?? 0} -> ${resolved.maxTokens ?? 0}`,
    );
  }
  if ((resolved.huggingFaceId ?? "") !== (ss.huggingFaceId ?? "")) {
    changes.push(
      `settings.semanticSearch.huggingFaceId: ${q(ss.huggingFaceId ?? "")} -> (removed)`,
    );
  }

  ss.provider = resolved.provider;
  ss.model = resolved.model;
  if (resolved.dimensions !== undefined) ss.dimensions = resolved.dimensions;
  if (resolved.maxTokens !== undefined) ss.maxTokens = resolved.maxTokens;
  delete ss.huggingFaceId;
  return changes;
}

/** The registry. Order does not matter; pending/apply always sort by version. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "resolve provider: local to the Ollama D2 default model and drop huggingFaceId",
    apply: migrateLocalProviderToOllama,
  },
];

// The version list in models/schema-version.ts is what core stamps onto new projects; it must be
// exactly this registry's versions.
if (
  MIGRATIONS.map((m) => m.version)
    .sort((a, b) => a - b)
    .join() !== SCHEMA_VERSIONS.join()
) {
  throw new Error("models/schema-version.ts SCHEMA_VERSIONS does not match the migration registry");
}

export function currentSchemaVersion(registry: readonly Migration[] = MIGRATIONS): number {
  return registry.reduce((max, m) => Math.max(max, m.version), 0);
}

export function pendingMigrations(
  currentVersion: number,
  registry: readonly Migration[] = MIGRATIONS,
): Migration[] {
  return registry.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
}

/** NeedsMigration: the project carries a schema version older than the current one. */
export function needsMigration(project: Project | undefined): boolean {
  return project !== undefined && (project.schemaVersion ?? 0) < currentSchemaVersion();
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  /** Versions that ran, in order. */
  applied: number[];
  changes: string[];
}

export const migrationPending = (r: MigrationResult): boolean => r.applied.length > 0;

/** The JSON `knowns migrate --json` prints: Go field names, nil slices as null. */
export function migrationResultJson(r: MigrationResult): Record<string, unknown> {
  return {
    FromVersion: r.fromVersion,
    ToVersion: r.toVersion,
    Applied: r.applied.length === 0 ? null : r.applied,
    Changes: r.changes.length === 0 ? null : r.changes,
  };
}

/** ApplyMigrations: run every pending migration in order, mutating project and its version. */
export function applyMigrations(
  project: Project,
  registry: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  const from = project.schemaVersion ?? 0;
  const result: MigrationResult = { fromVersion: from, toVersion: from, applied: [], changes: [] };
  const pending = pendingMigrations(from, registry);
  if (pending.length === 0) return result;
  for (const m of pending) {
    const changes = m.apply(project);
    result.applied.push(m.version);
    result.changes.push(...changes);
    project.schemaVersion = m.version;
  }
  result.toVersion = project.schemaVersion ?? 0;
  return result;
}

/** PreviewMigrations: the same run against a deep clone; project is left untouched. */
export function previewMigrations(
  project: Project,
  registry: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  return applyMigrations(structuredClone(project), registry);
}
