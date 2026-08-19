package storage

import (
	"path/filepath"
	"testing"
)

func TestUserPrefsStoreLoadEmpty(t *testing.T) {
	t.Parallel()
	store := NewUserPrefsStoreWithPath(filepath.Join(t.TempDir(), "prefs.json"))
	if _, err := store.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}
}

func TestUserPrefsStoreSaveAndLoad(t *testing.T) {
	t.Parallel()
	store := NewUserPrefsStoreWithPath(filepath.Join(t.TempDir(), "prefs.json"))

	if err := store.Save(&UserPrefs{}); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	if _, err := store.Load(); err != nil {
		t.Fatalf("Load failed: %v", err)
	}
}
