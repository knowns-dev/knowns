package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemplateStoreRejectsUnsafeNames(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	store := NewStore(filepath.Join(base, ".knowns"))
	if err := store.Init("template-name-security"); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"../escape", `..\escape`, "/tmp/escape", `C:\escape`, "import/../../escape"} {
		if err := store.Templates.Create(name, "unsafe"); err == nil {
			t.Errorf("Create(%q) succeeded, want containment error", name)
		}
		if _, err := store.Templates.Get(name); err == nil {
			t.Errorf("Get(%q) succeeded, want containment error", name)
		}
	}
	if _, err := os.Stat(filepath.Join(base, "escape")); !os.IsNotExist(err) {
		t.Fatalf("unsafe template escaped root: %v", err)
	}

	if err := store.Templates.Create("safe", "safe"); err != nil {
		t.Fatalf("Create safe template: %v", err)
	}
	if _, err := store.Templates.Get("safe"); err != nil {
		t.Fatalf("Get safe template: %v", err)
	}
}
