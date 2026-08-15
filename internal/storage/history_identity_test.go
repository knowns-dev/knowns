package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestDocStableIDRoundTripBackfillAndRename(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("identity"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "guides/identity", Title: "Identity", Content: "body"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	if doc.ID == "" || doc.CanonicalHash == "" {
		t.Fatalf("created Doc identity/hash = %q/%q", doc.ID, doc.CanonicalHash)
	}
	loaded, err := store.Docs.Get(doc.Path)
	if err != nil || loaded.ID != doc.ID {
		t.Fatalf("round-trip Doc = %#v, err=%v", loaded, err)
	}
	rename := *loaded
	rename.Path = "guides/renamed"
	if err := store.MutateDocWithHistory(context.Background(), loaded, &rename, DocMutationOptions{ExpectedHash: loaded.CanonicalHash}); err != nil {
		t.Fatal(err)
	}
	history, err := store.Versions.GetDocHistory(rename.Path)
	if err != nil || history.DocID != doc.ID || history.CurrentPath != rename.Path {
		t.Fatalf("renamed history = %#v, err=%v", history, err)
	}
	if _, err := store.Docs.Get(doc.Path); err == nil {
		t.Fatal("old Doc path still exists after rename")
	}
}

func TestDocDuplicateStableIDFailsClosed(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("duplicate"); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"a", "b"} {
		if err := os.WriteFile(filepath.Join(root, "docs", path+".md"), []byte("---\nid: duplicate\ntitle: "+path+"\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.Docs.List(); err == nil || !strings.Contains(err.Error(), "ambiguous Doc stable ID") {
		t.Fatalf("List duplicate error = %v", err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, &models.Doc{Path: "c", ID: "duplicate", Title: "c"}, DocMutationOptions{}); err == nil {
		t.Fatal("duplicate Doc mutation unexpectedly succeeded")
	}
}

func TestDocStableIDIsImmutableAndLegacyBackfillChains(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("legacy-id"); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(root, "docs", "legacy")
	legacy := &models.Doc{Path: "legacy/page"}
	if err := os.MkdirAll(legacyPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacyPath, "page.md"), []byte("---\ntitle: Legacy\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A passive read of a legacy file must not add frontmatter identity.
	legacyRead, err := store.Docs.Get(legacy.Path)
	if err != nil || legacyRead.ID != "" {
		t.Fatalf("legacy passive read ID=%q err=%v", legacyRead.ID, err)
	}
	if err := store.MutateDocWithHistory(context.Background(), nil, &models.Doc{Path: "legacy/page", Title: "Legacy", Content: "body"}, DocMutationOptions{}); err == nil {
		// Existing canonical data must be updated through the old/new path, not
		// treated as a create. This branch documents the expected conflict.
		t.Fatal("legacy create unexpectedly replaced canonical file")
	}
	current, err := store.Docs.Get(legacy.Path)
	if err != nil {
		t.Fatal(err)
	}
	updated := *current
	updated.Title = "Backfilled"
	if err := store.MutateDocWithHistory(context.Background(), current, &updated, DocMutationOptions{ExpectedHash: current.CanonicalHash}); err != nil {
		t.Fatal(err)
	}
	if updated.ID == "" {
		t.Fatal("legacy canonical mutation did not backfill ID")
	}
	history, err := store.Versions.GetDocHistory(updated.Path)
	if err != nil || len(history.Versions) == 0 {
		t.Fatalf("backfill history=%#v err=%v", history, err)
	}
	head := history.Versions[len(history.Versions)-1]
	if head.NewHash != updated.CanonicalHash {
		t.Fatalf("backfill head hash=%q canonical=%q", head.NewHash, updated.CanonicalHash)
	}
	bad := updated
	bad.ID = "other-id"
	if err := store.MutateDocWithHistory(context.Background(), &updated, &bad, DocMutationOptions{ExpectedHash: updated.CanonicalHash}); err == nil || !errors.Is(err, ErrHistoryConflict) || strings.Contains(err.Error(), bad.Content) {
		t.Fatalf("immutable ID error=%v", err)
	}
}

func TestTaskAndDocConflictsExposeOnlyHashes(t *testing.T) {
	taskConflict := &MutationConflictError{EntityType: "task", EntityID: "task-1", ExpectedHash: "old", CurrentHash: "new"}
	if !errors.Is(taskConflict, ErrHistoryConflict) || strings.Contains(taskConflict.Error(), "secret") {
		t.Fatalf("task conflict = %v", taskConflict)
	}
	docConflict := &MutationConflictError{EntityType: "doc", EntityID: "doc-1", ExpectedHash: "old", CurrentHash: "new"}
	if !errors.Is(docConflict, ErrHistoryConflict) || strings.Contains(docConflict.Error(), "content") {
		t.Fatalf("doc conflict = %v", docConflict)
	}
}

func TestDeleteDocRequiresObservedHashAtStorageBoundary(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-delete-hash"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "delete-hash", Title: "Delete hash", Content: "secret delete content"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	observed, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	current := *observed
	current.Title = "newer delete title"
	if err := store.MutateDocWithHistory(context.Background(), observed, &current, DocMutationOptions{ExpectedHash: observed.CanonicalHash}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteDocWithExpectedHash(context.Background(), doc.Path, DocDeleteOptions{}); err == nil || !strings.Contains(err.Error(), "expected canonical hash is required") {
		t.Fatalf("empty delete hash error = %v", err)
	}
	if err := store.DeleteDocWithExpectedHash(context.Background(), doc.Path, DocDeleteOptions{ExpectedHash: observed.CanonicalHash}); err == nil || !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("stale delete error = %v, want conflict", err)
	}
	if _, err := store.Docs.Get(doc.Path); err != nil {
		t.Fatalf("failed deletes removed canonical doc: %v", err)
	}
}
