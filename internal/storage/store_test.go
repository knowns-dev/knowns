package storage

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/testutil"
)

func TestGlobalRootPathPrefersHOMEOverride(t *testing.T) {
	home := t.TempDir()
	testutil.SetHome(t, home)

	got := GlobalRootPath()
	want := filepath.Join(home, ".knowns")
	if got != want {
		t.Fatalf("GlobalRootPath() = %q, want %q", got, want)
	}
}

func TestSemanticDBWritableOpensExistingIndex(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, ".search"), 0o755); err != nil {
		t.Fatalf("mkdir search dir: %v", err)
	}
	indexPath := filepath.Join(root, ".search", "index.db")
	if err := os.WriteFile(indexPath, []byte{}, 0o644); err != nil {
		t.Fatalf("create index file: %v", err)
	}

	store := NewStore(root)
	db := store.SemanticDBWritable()
	if db == nil {
		t.Fatal("expected writable semantic db")
	}
	defer db.Close()

	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS test_writes (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatalf("expected writable db exec to succeed: %v", err)
	}
}
