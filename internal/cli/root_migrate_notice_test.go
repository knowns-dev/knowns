package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
)

func captureStderr(t *testing.T, fn func()) string {
	t.Helper()
	orig := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stderr = w
	fn()
	_ = w.Close()
	os.Stderr = orig
	var out bytes.Buffer
	_, _ = out.ReadFrom(r)
	return out.String()
}

// TestMaybeWarnUnmigratedConfigNamesMigrateOnce is FR-4/AC-4 (the "one
// command" half): an unmigrated project prints exactly one line naming
// `knowns migrate`.
func TestMaybeWarnUnmigratedConfigNamesMigrateOnce(t *testing.T) {
	projectRoot := setupUnmigratedCLIProject(t)
	chdirForTest(t, projectRoot)

	output := captureStderr(t, maybeWarnUnmigratedConfig)

	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected exactly one warning line, got %d: %q", len(lines), output)
	}
	if !strings.Contains(output, "knowns migrate") {
		t.Fatalf("warning does not name knowns migrate: %q", output)
	}
}

// TestMaybeWarnUnmigratedConfigSilentWhenCurrent proves a project already at
// the current schema version (e.g. freshly initialized) gets no notice.
func TestMaybeWarnUnmigratedConfigSilentWhenCurrent(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("current-project"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	chdirForTest(t, filepath.Dir(root))

	output := captureStderr(t, maybeWarnUnmigratedConfig)
	if output != "" {
		t.Fatalf("expected no warning for a migrated project, got %q", output)
	}
}

// TestMaybeWarnUnmigratedConfigSilentOutsideProject proves the notice does
// not attempt to read a nonexistent config.json outside a Knowns project.
func TestMaybeWarnUnmigratedConfigSilentOutsideProject(t *testing.T) {
	chdirForTest(t, t.TempDir())
	output := captureStderr(t, maybeWarnUnmigratedConfig)
	if output != "" {
		t.Fatalf("expected no warning outside a project, got %q", output)
	}
}
