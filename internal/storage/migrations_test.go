package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func legacyLocalProject() *models.Project {
	return &models.Project{
		Name: "legacy",
		ID:   "legacy",
		Settings: models.ProjectSettings{
			DefaultPriority: "medium",
			Statuses:        []string{"todo", "done"},
			SemanticSearch: &models.SemanticSearchSettings{
				Enabled:       true,
				Provider:      "local",
				Model:         "multilingual-e5-small",
				HuggingFaceID: "Xenova/multilingual-e5-small",
				Dimensions:    384,
				MaxTokens:     512,
			},
		},
	}
}

// TestApplyMigrationsRewritesLocalProviderConfig covers AC-29 and the D9
// half of AC-22: the resolved model must come from the D2 registry, not
// whatever dimensions/model the legacy file happened to carry, and
// huggingFaceId — meaningless once provider is ollama — must be dropped.
func TestApplyMigrationsRewritesLocalProviderConfig(t *testing.T) {
	project := legacyLocalProject()
	result := ApplyMigrations(project)

	ss := project.Settings.SemanticSearch
	if ss.Provider != OllamaProviderID {
		t.Fatalf("Provider = %q, want %q", ss.Provider, OllamaProviderID)
	}
	if ss.Model != D2DefaultModelID {
		t.Fatalf("Model = %q, want D2 default %q", ss.Model, D2DefaultModelID)
	}
	if ss.Dimensions != 1024 {
		t.Fatalf("Dimensions = %d, want 1024 (D2 default)", ss.Dimensions)
	}
	if ss.HuggingFaceID != "" {
		t.Fatalf("HuggingFaceID = %q, want removed", ss.HuggingFaceID)
	}
	if project.SchemaVersion != CurrentSchemaVersion() {
		t.Fatalf("SchemaVersion = %d, want %d", project.SchemaVersion, CurrentSchemaVersion())
	}
	if !result.Pending() {
		t.Fatal("result reports nothing applied")
	}
	if len(result.Changes) == 0 {
		t.Fatal("result reports no changes")
	}
	foundHFDrop := false
	for _, c := range result.Changes {
		if strings.Contains(c, "huggingFaceId") && strings.Contains(c, "removed") {
			foundHFDrop = true
		}
	}
	if !foundHFDrop {
		t.Fatalf("changes do not mention huggingFaceId removal: %v", result.Changes)
	}
}

// TestApplyMigrationsIndependentOfMachineState is AC-22/D9: the migration's
// output must depend only on the file it reads, never on what happens to be
// installed or configured as a "default" on the machine running it. There is
// no machine-state input to the function at all, so calling it against
// different starting configs and a global settings state (irrelevant here,
// since ApplyMigrations takes no such parameter) always yields the same D2
// default.
func TestApplyMigrationsIndependentOfMachineState(t *testing.T) {
	a := legacyLocalProject()
	a.Settings.SemanticSearch.Model = "some-other-model-the-user-has-pulled"
	a.Settings.SemanticSearch.Dimensions = 4096

	b := legacyLocalProject()

	ApplyMigrations(a)
	ApplyMigrations(b)

	if a.Settings.SemanticSearch.Model != b.Settings.SemanticSearch.Model {
		t.Fatalf("migration output depends on prior state: %q vs %q", a.Settings.SemanticSearch.Model, b.Settings.SemanticSearch.Model)
	}
	if a.Settings.SemanticSearch.Model != D2DefaultModelID {
		t.Fatalf("Model = %q, want D2 default %q", a.Settings.SemanticSearch.Model, D2DefaultModelID)
	}
}

// TestApplyMigrationsTwiceIsNoOp is AC-27: running migrations twice changes
// nothing the second time.
func TestApplyMigrationsTwiceIsNoOp(t *testing.T) {
	project := legacyLocalProject()
	first := ApplyMigrations(project)
	if !first.Pending() {
		t.Fatal("first run applied nothing")
	}
	afterFirst := *project.Settings.SemanticSearch

	second := ApplyMigrations(project)
	if second.Pending() {
		t.Fatalf("second run applied migrations again: %+v", second)
	}
	if len(second.Changes) != 0 {
		t.Fatalf("second run reported changes: %v", second.Changes)
	}
	if *project.Settings.SemanticSearch != afterFirst {
		t.Fatalf("second run mutated settings: before=%+v after=%+v", afterFirst, *project.Settings.SemanticSearch)
	}
	if second.FromVersion != CurrentSchemaVersion() || second.ToVersion != CurrentSchemaVersion() {
		t.Fatalf("second run version = %+v, want no-op at %d", second, CurrentSchemaVersion())
	}
}

// TestPreviewMigrationsWritesNothing is AC-26 (the preview half): it must
// report the same changes ApplyMigrations would make, without mutating the
// caller's project.
func TestPreviewMigrationsWritesNothing(t *testing.T) {
	project := legacyLocalProject()
	before := *project.Settings.SemanticSearch

	preview, err := PreviewMigrations(project)
	if err != nil {
		t.Fatalf("PreviewMigrations: %v", err)
	}
	if !preview.Pending() {
		t.Fatal("preview reports nothing pending for a legacy local-provider project")
	}
	if len(preview.Changes) == 0 {
		t.Fatal("preview reports no changes")
	}
	if *project.Settings.SemanticSearch != before {
		t.Fatalf("PreviewMigrations mutated the project: before=%+v after=%+v", before, *project.Settings.SemanticSearch)
	}
	if project.SchemaVersion != 0 {
		t.Fatalf("PreviewMigrations stamped SchemaVersion: %d", project.SchemaVersion)
	}
}

// TestConfigStorePreviewThenSaveLeavesFileUnchanged proves PreviewMigrations
// composed with a real ConfigStore round trip never touches disk (AC-26).
func TestConfigStorePreviewThenSaveLeavesFileUnchanged(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile before: %v", err)
	}

	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, err := PreviewMigrations(project); err != nil {
		t.Fatalf("PreviewMigrations: %v", err)
	}

	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("preview touched disk:\nbefore=%s\nafter=%s", before, after)
	}
}

// TestPendingMigrationsRunsEveryInterveningVersionInOrder is AC-28: a
// project several versions behind must run every intervening migration, in
// ascending order. It exercises a synthetic registry, since the real
// registry has one entry today; the ordering/gating logic under test is the
// same code path PendingMigrations/ApplyMigrations use in production.
func TestPendingMigrationsRunsEveryInterveningVersionInOrder(t *testing.T) {
	var ranOrder []int
	fake := []Migration{
		// Registered out of version order on purpose, to prove sorting
		// doesn't depend on registration order.
		{Version: 3, Description: "third", Apply: func(p *models.Project) []string {
			ranOrder = append(ranOrder, 3)
			return []string{"three"}
		}},
		{Version: 1, Description: "first", Apply: func(p *models.Project) []string {
			ranOrder = append(ranOrder, 1)
			return []string{"one"}
		}},
		{Version: 2, Description: "second", Apply: func(p *models.Project) []string {
			ranOrder = append(ranOrder, 2)
			return []string{"two"}
		}},
	}

	pending := pendingMigrations(fake, 0)
	if len(pending) != 3 || pending[0].Version != 1 || pending[1].Version != 2 || pending[2].Version != 3 {
		t.Fatalf("pendingMigrations order = %+v, want [1,2,3]", pending)
	}

	project := &models.Project{Name: "behind", SchemaVersion: 0}
	result := applyMigrationsWith(fake, project)

	if len(ranOrder) != 3 || ranOrder[0] != 1 || ranOrder[1] != 2 || ranOrder[2] != 3 {
		t.Fatalf("migrations ran out of order: %v", ranOrder)
	}
	if len(result.Applied) != 3 || result.Applied[0] != 1 || result.Applied[1] != 2 || result.Applied[2] != 3 {
		t.Fatalf("result.Applied = %v, want [1,2,3]", result.Applied)
	}
	if project.SchemaVersion != 3 {
		t.Fatalf("SchemaVersion = %d, want 3", project.SchemaVersion)
	}
	if result.FromVersion != 0 || result.ToVersion != 3 {
		t.Fatalf("result versions = %+v, want From=0 To=3", result)
	}
}

// TestPendingMigrationsSkipsAlreadyCurrentProject is the other half of
// AC-28: a project already at the current schema version runs nothing.
func TestPendingMigrationsSkipsAlreadyCurrentProject(t *testing.T) {
	fake := []Migration{
		{Version: 1, Description: "first", Apply: func(p *models.Project) []string {
			t.Fatal("migration ran against an already-current project")
			return nil
		}},
	}
	project := &models.Project{Name: "current", SchemaVersion: 1}
	result := applyMigrationsWith(fake, project)
	if result.Pending() {
		t.Fatalf("result reports migrations applied: %+v", result)
	}
	if project.SchemaVersion != 1 {
		t.Fatalf("SchemaVersion changed: %d", project.SchemaVersion)
	}
}

func TestNeedsMigration(t *testing.T) {
	if NeedsMigration(nil) {
		t.Fatal("nil project should never need migration")
	}
	unmigrated := &models.Project{SchemaVersion: 0}
	if !NeedsMigration(unmigrated) {
		t.Fatal("legacy project (schemaVersion 0) should need migration")
	}
	current := &models.Project{SchemaVersion: CurrentSchemaVersion()}
	if NeedsMigration(current) {
		t.Fatal("project at CurrentSchemaVersion should not need migration")
	}
}

// TestApplyMigrationsSkipsNonLocalProvider proves the migration only
// touches provider: local (or empty) configs, per D1 — a project already on
// ollama or api is left alone besides the version stamp.
func TestApplyMigrationsSkipsNonLocalProvider(t *testing.T) {
	project := legacyLocalProject()
	project.Settings.SemanticSearch.Provider = "api"
	project.Settings.SemanticSearch.Model = "text-embedding-3-small"
	project.Settings.SemanticSearch.Dimensions = 1536
	before := *project.Settings.SemanticSearch

	result := ApplyMigrations(project)

	if *project.Settings.SemanticSearch != before {
		t.Fatalf("migration touched an api-provider config: before=%+v after=%+v", before, *project.Settings.SemanticSearch)
	}
	if project.SchemaVersion != CurrentSchemaVersion() {
		t.Fatalf("SchemaVersion = %d, want stamped to %d even with nothing to change", project.SchemaVersion, CurrentSchemaVersion())
	}
	if !result.Pending() {
		t.Fatal("expected the migration to still run (and stamp the version) even though it made no field changes")
	}
	if len(result.Changes) != 0 {
		t.Fatalf("expected no change lines for an already-ollama-shaped provider, got %v", result.Changes)
	}
}
