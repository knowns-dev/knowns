// The project config schema versions, in a layer both core (which stamps new projects) and the
// migration registry (stores/migrations.ts, which implements each step) can import. Adding a
// migration means adding its version here; stores/migrations.ts refuses to load when the two
// lists disagree, so the stamped version can never drift from the registry.

/** Every registered config schema version, ascending. Go's internal/storage/migrations.go. */
export const SCHEMA_VERSIONS: readonly number[] = [1];

/** The version a fresh project is stamped with: the highest registered migration. */
export const CURRENT_SCHEMA_VERSION: number = Math.max(0, ...SCHEMA_VERSIONS);
