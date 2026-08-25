package storage

import (
	"encoding/json"
	"fmt"
	"sort"

	"github.com/howznguyen/knowns/internal/models"
)

// Migration is one registered project-config schema migration (spec
// ollama-only-embedding D10/FR-18). Version is the schema version this
// migration upgrades a project TO. Apply must be idempotent: running it
// against a project that already satisfies Version must produce no changes.
// Apply's output must depend only on the project it is given, never on
// machine state (D9) — a migration rewrites a file the rest of the team will
// pull, so two developers on different machines must produce the same
// result.
type Migration struct {
	Version     int
	Description string
	// Apply mutates project in place, upgrading it to Version, and returns a
	// human-readable line per actual change made (empty/nil if nothing
	// changed).
	Apply func(project *models.Project) []string
}

// migrations is the registry, D10's "registry [that] will outgrow config"
// (D11). Order here does not matter; PendingMigrations/ApplyMigrations
// always sort by Version.
var migrations = []Migration{
	{
		Version:     1,
		Description: "resolve provider: local to the Ollama D2 default model and drop huggingFaceId",
		Apply:       migrateLocalProviderToOllama,
	},
}

// migrateLocalProviderToOllama is migration v1: the FR-3/D1 resolution,
// persisted. It reuses ResolveSemanticSearch — the same function that
// resolves provider: local in memory on every read — so the persisted
// result can never drift from what in-memory resolution already computes.
func migrateLocalProviderToOllama(project *models.Project) []string {
	if project == nil || project.Settings.SemanticSearch == nil {
		return nil
	}
	ss := project.Settings.SemanticSearch
	resolved := ResolveSemanticSearch(ss)
	if resolved == nil || *resolved == *ss {
		return nil
	}

	var changes []string
	if resolved.Provider != ss.Provider {
		from := ss.Provider
		if from == "" {
			from = "(empty)"
		}
		changes = append(changes, fmt.Sprintf("settings.semanticSearch.provider: %q -> %q", from, resolved.Provider))
	}
	if resolved.Model != ss.Model {
		changes = append(changes, fmt.Sprintf("settings.semanticSearch.model: %q -> %q", ss.Model, resolved.Model))
	}
	if resolved.Dimensions != ss.Dimensions {
		changes = append(changes, fmt.Sprintf("settings.semanticSearch.dimensions: %d -> %d", ss.Dimensions, resolved.Dimensions))
	}
	if resolved.MaxTokens != ss.MaxTokens {
		changes = append(changes, fmt.Sprintf("settings.semanticSearch.maxTokens: %d -> %d", ss.MaxTokens, resolved.MaxTokens))
	}
	if resolved.HuggingFaceID != ss.HuggingFaceID {
		changes = append(changes, fmt.Sprintf("settings.semanticSearch.huggingFaceId: %q -> (removed)", ss.HuggingFaceID))
	}

	*ss = *resolved
	return changes
}

// CurrentSchemaVersion is the schema version a fully migrated project
// carries: the highest version among registered migrations. A project with
// no registered migrations (should not happen once v1 above exists) is
// current at version 0.
func CurrentSchemaVersion() int {
	return currentSchemaVersion(migrations)
}

func currentSchemaVersion(registry []Migration) int {
	max := 0
	for _, m := range registry {
		if m.Version > max {
			max = m.Version
		}
	}
	return max
}

// PendingMigrations returns the registered migrations above currentVersion,
// in ascending version order — every migration a project several versions
// behind must run, in order (AC-28).
func PendingMigrations(currentVersion int) []Migration {
	return pendingMigrations(migrations, currentVersion)
}

func pendingMigrations(registry []Migration, currentVersion int) []Migration {
	pending := make([]Migration, 0, len(registry))
	for _, m := range registry {
		if m.Version > currentVersion {
			pending = append(pending, m)
		}
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].Version < pending[j].Version })
	return pending
}

// NeedsMigration reports whether project carries a config schema version
// older than CurrentSchemaVersion() (FR-4/FR-21). A nil project needs no
// migration since there is nothing to migrate.
func NeedsMigration(project *models.Project) bool {
	if project == nil {
		return false
	}
	return project.SchemaVersion < CurrentSchemaVersion()
}

// MigrationResult describes the outcome of running pending migrations
// against a project.
type MigrationResult struct {
	// FromVersion is the schema version the project carried before this run.
	FromVersion int
	// ToVersion is the schema version after this run (unchanged from
	// FromVersion when nothing was pending).
	ToVersion int
	// Applied lists the migration versions that ran, in the order they ran.
	Applied []int
	// Changes lists every human-readable change line every applied
	// migration reported, in order.
	Changes []string
}

// Pending reports whether this result represents at least one migration
// that ran (or, for a preview, would run).
func (r MigrationResult) Pending() bool {
	return len(r.Applied) > 0
}

// ApplyMigrations runs every pending migration against project, in
// ascending version order, mutating it in place, and stamps
// project.SchemaVersion to CurrentSchemaVersion() when any migration ran
// (FR-18). Every migration in the registry is idempotent (FR-20): calling
// ApplyMigrations again on an already-migrated project is a no-op and
// returns an empty result (AC-27).
func ApplyMigrations(project *models.Project) MigrationResult {
	return applyMigrationsWith(migrations, project)
}

func applyMigrationsWith(registry []Migration, project *models.Project) MigrationResult {
	result := MigrationResult{FromVersion: project.SchemaVersion, ToVersion: project.SchemaVersion}
	pending := pendingMigrations(registry, project.SchemaVersion)
	if len(pending) == 0 {
		return result
	}
	for _, m := range pending {
		changes := m.Apply(project)
		result.Applied = append(result.Applied, m.Version)
		result.Changes = append(result.Changes, changes...)
		project.SchemaVersion = m.Version
	}
	result.ToVersion = project.SchemaVersion
	return result
}

// PreviewMigrations reports what ApplyMigrations would do without mutating
// project or touching disk (FR-19/AC-26): it runs the same migrations
// against a deep clone. project itself, and any file backing it, is left
// exactly as it was.
func PreviewMigrations(project *models.Project) (MigrationResult, error) {
	return previewMigrationsWith(migrations, project)
}

func previewMigrationsWith(registry []Migration, project *models.Project) (MigrationResult, error) {
	clone, err := cloneProject(project)
	if err != nil {
		return MigrationResult{}, fmt.Errorf("clone project for migration preview: %w", err)
	}
	return applyMigrationsWith(registry, clone), nil
}

// cloneProject deep-copies a project via a JSON round trip, so preview code
// can run real migrations against the clone without any risk of a pointer
// field (SemanticSearch, VectorStore, ...) aliasing back into the caller's
// project — including for migrations registered later that touch fields
// this package does not enumerate today.
func cloneProject(project *models.Project) (*models.Project, error) {
	if project == nil {
		return nil, nil
	}
	data, err := json.Marshal(project)
	if err != nil {
		return nil, err
	}
	var clone models.Project
	if err := json.Unmarshal(data, &clone); err != nil {
		return nil, err
	}
	return &clone, nil
}
