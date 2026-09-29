package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/registry"
)

// A repository linked to a store that still carries an un-migrated .knowns/
// resolves to the store, and the command warns naming the ignored directory.
func TestCommandsUseStoreAndWarnAboutIgnoredInRepoKnowns(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	code := filepath.Join(home, "work", "shop-api")
	if err := os.MkdirAll(filepath.Join(code, ".knowns"), 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(code, ".knowns", "config.json"), []byte(`{"name":"old"}`), 0o644)

	reg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	reg.Load()
	folder := filepath.Join(reg.StoresRoot(), "team", "shop-api")
	os.MkdirAll(folder, 0o755)
	os.WriteFile(filepath.Join(folder, "config.json"), []byte(`{"name":"shop-api"}`), 0o644)
	if _, err := reg.AddStoreLinked(code, registry.StoreMapping{Name: "team", Project: "shop-api"}); err != nil {
		t.Fatal(err)
	}
	chdirForTest(t, code)

	var storeRoot, projectRoot string
	stderr := captureStderr(t, func() {
		store, err := getStoreErr()
		if err != nil {
			t.Fatalf("getStoreErr: %v", err)
		}
		storeRoot, projectRoot = store.Root, store.ProjectRoot
	})

	if filepath.Base(storeRoot) != "shop-api" || !strings.Contains(storeRoot, filepath.Join("stores", "team")) {
		t.Fatalf("command resolved knowledge at %q, want the store folder", storeRoot)
	}
	if resolved, _ := filepath.EvalSymlinks(projectRoot); resolved != mustEval(t, code) {
		t.Fatalf("project root = %q, want %q", projectRoot, code)
	}
	if !strings.Contains(stderr, "Warning:") || !strings.Contains(stderr, ".knowns") || !strings.Contains(stderr, "team") {
		t.Fatalf("expected a warning naming the ignored .knowns/ and the store, got %q", stderr)
	}
}

func mustEval(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
