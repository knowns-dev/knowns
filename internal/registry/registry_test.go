package registry

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// canonicalTempDir returns t.TempDir() spelled the way the OS itself reports
// it. The Windows runners hand tests a TMP path holding the 8.3 short name
// RUNNER~1, which is an alias rather than the directory's real name, so a test
// comparing against the raw value asserts against exactly the spelling
// CanonicalPath exists to collapse. EvalSymlinks reads the real name from the
// OS, independently of the code under test.
func canonicalTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return dir
	}
	return resolved
}

// helper creates a temp dir with a .knowns/config.json to simulate an initialized project.
func createFakeProject(t *testing.T, parent, name string) string {
	t.Helper()
	dir := filepath.Join(parent, name)
	os.MkdirAll(filepath.Join(dir, ".knowns"), 0755)
	os.WriteFile(filepath.Join(dir, ".knowns", "config.json"), []byte(`{"name":"`+name+`"}`), 0644)
	return dir
}

func TestRegistryAddAndLoad(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "my-project")

	r := NewRegistryWithPath(regFile)
	if err := r.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	p, err := r.Add(projDir)
	if err != nil {
		t.Fatalf("Add failed: %v", err)
	}
	if p.Name != "my-project" {
		t.Fatalf("Name = %q, want %q", p.Name, "my-project")
	}
	if p.Path != projDir {
		t.Fatalf("Path = %q, want %q", p.Path, projDir)
	}

	// Reload and verify persistence
	r2 := NewRegistryWithPath(regFile)
	if err := r2.Load(); err != nil {
		t.Fatalf("Reload failed: %v", err)
	}
	if len(r2.Projects) != 1 {
		t.Fatalf("expected 1 project after reload, got %d", len(r2.Projects))
	}
	if r2.Projects[0].ID != p.ID {
		t.Fatalf("ID mismatch after reload")
	}
}

func TestRegistryRemove(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "to-remove")

	r := NewRegistryWithPath(regFile)
	r.Load()
	p, _ := r.Add(projDir)

	if err := r.Remove(p.ID); err != nil {
		t.Fatalf("Remove failed: %v", err)
	}
	if len(r.Projects) != 0 {
		t.Fatalf("expected 0 projects after remove, got %d", len(r.Projects))
	}
}

func TestRegistrySetActiveAndGetActive(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	proj1 := createFakeProject(t, tmpDir, "proj-a")
	proj2 := createFakeProject(t, tmpDir, "proj-b")

	r := NewRegistryWithPath(regFile)
	r.Load()
	p1, _ := r.Add(proj1)
	time.Sleep(10 * time.Millisecond)
	p2, _ := r.Add(proj2)

	// p2 was added last, so it should be active
	active := r.GetActive()
	if active.ID != p2.ID {
		t.Fatalf("expected p2 to be active, got %s", active.ID)
	}

	// Set p1 as active
	r.SetActive(p1.ID)
	active = r.GetActive()
	if active.ID != p1.ID {
		t.Fatalf("expected p1 to be active after SetActive, got %s", active.ID)
	}
}

func TestRegistryAddDeduplicate(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "dup-project")

	r := NewRegistryWithPath(regFile)
	r.Load()
	p1, _ := r.Add(projDir)
	p2, _ := r.Add(projDir) // same path again

	if p1.ID != p2.ID {
		t.Fatalf("expected same ID for duplicate add, got %s vs %s", p1.ID, p2.ID)
	}
	if len(r.Projects) != 1 {
		t.Fatalf("expected 1 project after duplicate add, got %d", len(r.Projects))
	}
}

func TestRegistryScan(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")

	// Create a parent dir with 3 subdirs, 2 of which have .knowns/
	scanDir := filepath.Join(tmpDir, "projects")
	createFakeProject(t, scanDir, "repo-a")
	createFakeProject(t, scanDir, "repo-b")
	os.MkdirAll(filepath.Join(scanDir, "not-a-repo"), 0755) // no .knowns/

	r := NewRegistryWithPath(regFile)
	r.Load()

	added, err := r.Scan([]string{scanDir})
	if err != nil {
		t.Fatalf("Scan failed: %v", err)
	}
	if len(added) != 2 {
		t.Fatalf("expected 2 discovered projects, got %d", len(added))
	}
	if len(r.Projects) != 2 {
		t.Fatalf("expected 2 total projects, got %d", len(r.Projects))
	}

	// Scan again — should find 0 new
	added2, _ := r.Scan([]string{scanDir})
	if len(added2) != 0 {
		t.Fatalf("expected 0 new projects on rescan, got %d", len(added2))
	}
}

func TestRegistryFindByPath(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "findme")

	r := NewRegistryWithPath(regFile)
	r.Load()
	r.Add(projDir)

	found := r.FindByPath(projDir)
	if found == nil {
		t.Fatal("FindByPath returned nil for registered project")
	}
	if found.Name != "findme" {
		t.Fatalf("FindByPath Name = %q, want %q", found.Name, "findme")
	}

	notFound := r.FindByPath("/nonexistent/path")
	if notFound != nil {
		t.Fatal("FindByPath should return nil for unregistered path")
	}
}

func TestRegistryGetActiveEmpty(t *testing.T) {
	r := NewRegistryWithPath("/tmp/empty-reg.json")
	r.Load()
	if r.GetActive() != nil {
		t.Fatal("GetActive should return nil for empty registry")
	}
}

// caseInsensitiveFS reports whether dir lives on a filesystem that treats two
// spellings of one name as the same entry.
func caseInsensitiveFS(t *testing.T, dir string) bool {
	t.Helper()
	probe := filepath.Join(dir, "CaseProbe")
	if err := os.Mkdir(probe, 0755); err != nil {
		t.Fatalf("create probe dir: %v", err)
	}
	defer os.RemoveAll(probe)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

func TestRegistryAddCollapsesCaseVariantPaths(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "Casing")

	r := NewRegistryWithPath(regFile)
	if err := r.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	first, err := r.Add(projDir)
	if err != nil {
		t.Fatalf("Add failed: %v", err)
	}
	second, err := r.Add(strings.ToLower(projDir))
	if err != nil {
		t.Fatalf("Add with lowercased path failed: %v", err)
	}

	if len(r.Projects) != 1 {
		t.Fatalf("expected 1 project for one folder, got %d", len(r.Projects))
	}
	if second.ID != first.ID {
		t.Fatalf("ID = %q, want the already registered %q", second.ID, first.ID)
	}
	if second.Path != projDir {
		t.Fatalf("Path = %q, want the on-disk spelling %q", second.Path, projDir)
	}
	if second.Name != "Casing" {
		t.Fatalf("Name = %q, want %q", second.Name, "Casing")
	}
}

func TestRegistryAddKeepsDistinctCaseSensitiveDirectories(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	if caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-insensitive; both spellings name one folder")
	}
	regFile := filepath.Join(tmpDir, "registry.json")
	upper := createFakeProject(t, tmpDir, "Casing")
	lower := createFakeProject(t, tmpDir, "casing")

	r := NewRegistryWithPath(regFile)
	r.Load()
	if _, err := r.Add(upper); err != nil {
		t.Fatalf("Add(%q) failed: %v", upper, err)
	}
	if _, err := r.Add(lower); err != nil {
		t.Fatalf("Add(%q) failed: %v", lower, err)
	}

	if len(r.Projects) != 2 {
		t.Fatalf("expected 2 projects for 2 distinct folders, got %d", len(r.Projects))
	}
}

func TestRegistryLoadCollapsesCaseDuplicateRows(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "Casing")

	// A registry written before paths were canonicalized: one folder, two rows,
	// disagreeing about both path spelling and name.
	stale := `[
	  {"id":"aaaaaa","name":"Casing","path":` + strconv.Quote(projDir) + `,"lastUsed":"2026-01-01T00:00:00Z"},
	  {"id":"bbbbbb","name":"casing","path":` + strconv.Quote(strings.ToLower(projDir)) + `,"lastUsed":"2026-01-02T00:00:00Z"}
	]`
	if err := os.WriteFile(regFile, []byte(stale), 0644); err != nil {
		t.Fatalf("write registry: %v", err)
	}

	r := NewRegistryWithPath(regFile)
	if err := r.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if len(r.Projects) != 1 {
		t.Fatalf("expected duplicates to collapse to 1 project, got %d", len(r.Projects))
	}
	if r.Projects[0].Path != projDir {
		t.Fatalf("Path = %q, want the on-disk spelling %q", r.Projects[0].Path, projDir)
	}
	if r.Projects[0].Name != "Casing" {
		t.Fatalf("Name = %q, want %q", r.Projects[0].Name, "Casing")
	}

	// The collapse is persisted, so the duplicates do not come back on reload.
	reloaded := NewRegistryWithPath(regFile)
	if err := reloaded.Load(); err != nil {
		t.Fatalf("Reload failed: %v", err)
	}
	if len(reloaded.Projects) != 1 {
		t.Fatalf("expected 1 project after reload, got %d", len(reloaded.Projects))
	}
}

func TestRegistryLoadKeepsMissingPathsDistinct(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	regFile := filepath.Join(tmpDir, "registry.json")
	gone := filepath.Join(tmpDir, "Deleted")

	stale := `[
	  {"id":"aaaaaa","name":"Deleted","path":` + strconv.Quote(gone) + `,"lastUsed":"2026-01-01T00:00:00Z"},
	  {"id":"bbbbbb","name":"deleted","path":` + strconv.Quote(strings.ToLower(gone)) + `,"lastUsed":"2026-01-02T00:00:00Z"}
	]`
	if err := os.WriteFile(regFile, []byte(stale), 0644); err != nil {
		t.Fatalf("write registry: %v", err)
	}

	r := NewRegistryWithPath(regFile)
	if err := r.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	// Neither path exists, so nothing proves they name one folder.
	if len(r.Projects) != 2 {
		t.Fatalf("expected unresolvable paths to stay distinct, got %d", len(r.Projects))
	}
}

func TestRegistryFindByPathIgnoresCasing(t *testing.T) {
	tmpDir := canonicalTempDir(t)
	if !caseInsensitiveFS(t, tmpDir) {
		t.Skip("filesystem is case-sensitive; the two spellings are different folders")
	}
	regFile := filepath.Join(tmpDir, "registry.json")
	projDir := createFakeProject(t, tmpDir, "Casing")

	r := NewRegistryWithPath(regFile)
	r.Load()
	added, err := r.Add(projDir)
	if err != nil {
		t.Fatalf("Add failed: %v", err)
	}

	found := r.FindByPath(strings.ToLower(projDir))
	if found == nil {
		t.Fatal("FindByPath with a differently cased path found nothing")
	}
	if found.ID != added.ID {
		t.Fatalf("ID = %q, want %q", found.ID, added.ID)
	}
}
