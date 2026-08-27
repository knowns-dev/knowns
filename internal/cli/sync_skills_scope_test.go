package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// projectSkillDirsExist reports whether sync materialized skills into the
// project. The bug this guards: sync always created these directories, so a
// user who installed skills globally got a competing project copy that
// shadowed the global one and came back on every sync.
func projectSkillDirsExist(t *testing.T, root string) bool {
	t.Helper()
	for _, dir := range []string{".claude", ".agents", ".kiro"} {
		if _, err := os.Stat(filepath.Join(root, dir, "skills")); err == nil {
			return true
		}
	}
	return false
}

func TestSyncSkillsScopeNoneLeavesProjectUntouched(t *testing.T) {
	root := t.TempDir()
	if err := runSyncSkillsForScope(root, true, []string{"claude-code"}, models.SkillsScopeNone); err != nil {
		t.Fatalf("runSyncSkillsForScope: %v", err)
	}
	if projectSkillDirsExist(t, root) {
		t.Fatal("scope \"none\" created project skill directories")
	}
}

func TestSyncSkillsScopeGlobalLeavesProjectUntouched(t *testing.T) {
	root := t.TempDir()
	t.Setenv("HOME", t.TempDir())
	if err := runSyncSkillsForScope(root, true, []string{"claude-code"}, models.SkillsScopeGlobal); err != nil {
		t.Fatalf("runSyncSkillsForScope: %v", err)
	}
	if projectSkillDirsExist(t, root) {
		t.Fatal("scope \"global\" created project skill directories, shadowing the global install")
	}
	home, _ := os.UserHomeDir()
	if _, err := os.Stat(filepath.Join(home, ".claude", "skills")); err != nil {
		t.Fatalf("scope \"global\" did not write skills to the home directory: %v", err)
	}
}

func TestSyncSkillsScopeProjectStillMaterializes(t *testing.T) {
	root := t.TempDir()
	if err := runSyncSkillsForScope(root, true, []string{"claude-code"}, models.SkillsScopeProject); err != nil {
		t.Fatalf("runSyncSkillsForScope: %v", err)
	}
	if !projectSkillDirsExist(t, root) {
		t.Fatal("scope \"project\" must keep materializing skills, so a fresh clone still works")
	}
}

func TestUnsetSkillsScopeResolvesToProject(t *testing.T) {
	var settings models.ProjectSettings
	if got := settings.SkillsScopeOrDefault(); got != models.SkillsScopeProject {
		t.Fatalf("unset scope = %q, want %q so existing projects are unaffected", got, models.SkillsScopeProject)
	}
	settings.SkillsScope = "GLOBAL "
	if got := settings.SkillsScopeOrDefault(); got != models.SkillsScopeGlobal {
		t.Fatalf("scope %q resolved to %q", settings.SkillsScope, got)
	}
	settings.SkillsScope = "nonsense"
	if err := settings.Normalize(); err == nil {
		t.Fatal("Normalize accepted an unknown skills scope")
	}
}

func TestGlobalDefaultAppliesToProjectsThatNeverSetTheScope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".knowns"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store := storage.NewEmbeddingSettingsStore()
	settings, err := store.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if settings.ProjectDefaults == nil {
		settings.ProjectDefaults = &storage.ProjectDefaults{}
	}
	settings.ProjectDefaults.Settings.SkillsScope = models.SkillsScopeGlobal
	if err := store.Save(settings); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// A project that never set the scope must inherit the global default,
	// which is what makes existing repositories pick the fix up untouched.
	if got := resolveSkillsScope(models.ProjectSettings{}); got != models.SkillsScopeGlobal {
		t.Fatalf("unset project scope = %q, want the global default %q", got, models.SkillsScopeGlobal)
	}

	// An explicit project setting still wins over the global default.
	explicit := models.ProjectSettings{SkillsScope: models.SkillsScopeProject}
	if got := resolveSkillsScope(explicit); got != models.SkillsScopeProject {
		t.Fatalf("explicit project scope = %q, want %q", got, models.SkillsScopeProject)
	}
}

func TestNoGlobalDefaultStillMeansProject(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := resolveSkillsScope(models.ProjectSettings{}); got != models.SkillsScopeProject {
		t.Fatalf("with no global default, scope = %q, want %q", got, models.SkillsScopeProject)
	}
}

// TestEmptyScopeStaysEmpty guards the TUI trap: the settings form offers an
// "inherit" option that maps to the empty string, and an empty string must
// survive Normalize so stepping through the form never stamps an explicit
// scope over the global default the user just set.
func TestEmptyScopeStaysEmpty(t *testing.T) {
	settings := models.ProjectSettings{SkillsScope: ""}
	if err := settings.Normalize(); err != nil {
		t.Fatalf("Normalize: %v", err)
	}
	if settings.SkillsScope != "" {
		t.Fatalf("empty scope became %q; an unset scope must stay unset", settings.SkillsScope)
	}
	scope, err := models.NormalizeSkillsScope("")
	if err != nil || scope != "" {
		t.Fatalf("NormalizeSkillsScope(\"\") = %q, %v; want \"\", nil", scope, err)
	}
}
