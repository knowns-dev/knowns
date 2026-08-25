package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func newMigrateTestCmd(write bool) *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().Bool("write", write, "")
	cmd.Flags().Bool("json", false, "")
	cmd.Flags().Bool("plain", false, "")
	return cmd
}

// setupUnmigratedCLIProject writes a project whose config.json declares
// provider: local — a legacy, unmigrated config (schemaVersion 0) — and
// returns the project root. Chdir into it before calling a migrate RunE
// function directly, the same pattern TestRunDecisionMigrationCommands uses.
func setupUnmigratedCLIProject(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	knownsDir := filepath.Join(projectRoot, ".knowns")
	if err := os.MkdirAll(knownsDir, 0o755); err != nil {
		t.Fatalf("mkdir .knowns: %v", err)
	}
	configPath := filepath.Join(knownsDir, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}
	return projectRoot
}

func chdirForTest(t *testing.T, dir string) {
	t.Helper()
	orig, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(orig) })
}

// TestRunMigratePreviewWritesNothing is AC-26 (preview half): no flags
// leaves config.json unchanged and reports the pending migration.
func TestRunMigratePreviewWritesNothing(t *testing.T) {
	projectRoot := setupUnmigratedCLIProject(t)
	chdirForTest(t, projectRoot)
	configPath := filepath.Join(projectRoot, ".knowns", "config.json")
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read before: %v", err)
	}

	output := captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(false), nil); err != nil {
			t.Fatalf("runMigrate preview: %v", err)
		}
	})

	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("preview rewrote config.json:\nbefore=%s\nafter=%s", before, after)
	}
	if !strings.Contains(output, "pending migration") {
		t.Fatalf("preview output does not report pending migrations: %q", output)
	}
	if !strings.Contains(output, "knowns migrate --write") {
		t.Fatalf("preview output does not name knowns migrate --write: %q", output)
	}
}

// TestRunMigratePreviewNamesEachPendingMigration covers the half of AC-26
// that a bare count does not satisfy: "reports the pending migrations". A
// migration can be pending and still change no fields — a project with no
// semanticSearch block gives the v1 migration nothing to rewrite, so only the
// schema version advances. Before this was fixed the preview printed a count
// and a colon followed by nothing at all, which reads as broken output and
// never tells the user which migration is pending.
func TestRunMigratePreviewNamesEachPendingMigration(t *testing.T) {
	projectRoot := setupUnmigratedCLIProject(t)
	chdirForTest(t, projectRoot)

	output := captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(false), nil); err != nil {
			t.Fatalf("runMigrate preview: %v", err)
		}
	})

	for _, m := range storage.PendingMigrations(0) {
		if !strings.Contains(output, m.Description) {
			t.Fatalf("preview does not name pending migration v%d (%q):\n%s", m.Version, m.Description, output)
		}
	}
}

// TestRunMigrateWriteAppliesAndStampsVersion is AC-26 (write half): --write
// applies pending migrations, stamps the schema version, and reports what
// changed.
func TestRunMigrateWriteAppliesAndStampsVersion(t *testing.T) {
	projectRoot := setupUnmigratedCLIProject(t)
	chdirForTest(t, projectRoot)

	output := captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(true), nil); err != nil {
			t.Fatalf("runMigrate --write: %v", err)
		}
	})

	if !strings.Contains(output, "Applied") {
		t.Fatalf("write output does not report what was applied: %q", output)
	}
	// AC-4: knowns migrate itself names installing Ollama, pulling the
	// model, and running a reindex.
	for _, want := range []string{"Install Ollama", "Pull the model", "Reindex"} {
		if !strings.Contains(output, want) {
			t.Fatalf("write output missing %q: %q", want, output)
		}
	}

	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load migrated config: %v", err)
	}
	if project.SchemaVersion != storage.CurrentSchemaVersion() {
		t.Fatalf("SchemaVersion = %d, want %d", project.SchemaVersion, storage.CurrentSchemaVersion())
	}
	ss := project.Settings.SemanticSearch
	if ss == nil || ss.Provider != storage.OllamaProviderID || ss.Model != storage.D2DefaultModelID {
		t.Fatalf("semantic settings not migrated: %#v", ss)
	}
	if ss.HuggingFaceID != "" {
		t.Fatalf("huggingFaceId not dropped: %q", ss.HuggingFaceID)
	}

	data, err := os.ReadFile(filepath.Join(projectRoot, ".knowns", "config.json"))
	if err != nil {
		t.Fatalf("read config.json: %v", err)
	}
	if strings.Contains(string(data), "huggingFaceId") {
		t.Fatalf("config.json still carries huggingFaceId after migration:\n%s", data)
	}
}

// TestRunMigrateWriteTwiceIsNoOp is AC-27: running --write twice changes
// nothing the second time and reports nothing pending.
func TestRunMigrateWriteTwiceIsNoOp(t *testing.T) {
	projectRoot := setupUnmigratedCLIProject(t)
	chdirForTest(t, projectRoot)

	captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(true), nil); err != nil {
			t.Fatalf("first runMigrate --write: %v", err)
		}
	})
	configPath := filepath.Join(projectRoot, ".knowns", "config.json")
	afterFirst, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after first write: %v", err)
	}

	secondOutput := captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(true), nil); err != nil {
			t.Fatalf("second runMigrate --write: %v", err)
		}
	})

	afterSecond, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read after second write: %v", err)
	}
	if string(afterSecond) != string(afterFirst) {
		t.Fatalf("second --write changed config.json:\nfirst=%s\nsecond=%s", afterFirst, afterSecond)
	}
	if !strings.Contains(secondOutput, "Nothing to migrate") {
		t.Fatalf("second --write output does not report nothing pending: %q", secondOutput)
	}
}

// TestRunMigrateWriteIgnoresMachineDefaultEmbeddingModel is AC-22/D9: on a
// machine that has pulled and set a different embedding model as its own
// global default (~/.knowns/settings.json defaultEmbeddingModel), `knowns
// migrate --write` still resolves to the D2 default, not the machine's.
// Migration's output must depend only on the project file it reads.
func TestRunMigrateWriteIgnoresMachineDefaultEmbeddingModel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	knownsHome := filepath.Join(home, ".knowns")
	if err := os.MkdirAll(knownsHome, 0o755); err != nil {
		t.Fatalf("mkdir home .knowns: %v", err)
	}
	globalSettings := `{"defaultEmbeddingModel":"nomic-embed-text"}`
	if err := os.WriteFile(filepath.Join(knownsHome, "settings.json"), []byte(globalSettings), 0o644); err != nil {
		t.Fatalf("write global settings: %v", err)
	}

	projectRoot := t.TempDir()
	dotKnowns := filepath.Join(projectRoot, ".knowns")
	if err := os.MkdirAll(dotKnowns, 0o755); err != nil {
		t.Fatalf("mkdir .knowns: %v", err)
	}
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(filepath.Join(dotKnowns, "config.json"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}
	chdirForTest(t, projectRoot)

	if err := runMigrate(newMigrateTestCmd(true), nil); err != nil {
		t.Fatalf("runMigrate --write: %v", err)
	}

	store := storage.NewStore(dotKnowns)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load migrated config: %v", err)
	}
	ss := project.Settings.SemanticSearch
	if ss == nil || ss.Model != storage.D2DefaultModelID {
		t.Fatalf("migrated model = %#v, want D2 default %q (machine's own default must be ignored)", ss, storage.D2DefaultModelID)
	}
	if ss.Model == "nomic-embed-text" {
		t.Fatal("migration used the machine's global defaultEmbeddingModel instead of the D2 default")
	}
}

// TestRunMigrateOnCurrentProjectDoesNothing is the other half of AC-28: a
// project already at the current schema version (e.g. freshly initialized)
// runs no migration.
func TestRunMigrateOnCurrentProjectDoesNothing(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("current-project"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	chdirForTest(t, filepath.Dir(root))

	output := captureMemoryStdout(t, func() {
		if err := runMigrate(newMigrateTestCmd(true), nil); err != nil {
			t.Fatalf("runMigrate --write: %v", err)
		}
	})
	if !strings.Contains(output, "Nothing to migrate") {
		t.Fatalf("expected nothing-pending output for a freshly initialized project, got %q", output)
	}
}
