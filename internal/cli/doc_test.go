package cli

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestRenderSmartDocSummary(t *testing.T) {
	doc := &models.Doc{
		Title:   "Test Doc",
		Content: "# Overview\n\n## Details",
	}

	got := renderSmartDocSummary(doc)

	wantParts := []string{
		"Document: Test Doc\n==================================================\n\n",
		"Size: 22 chars (~7 tokens)\n",
		"Headings: 2\n\n",
		"Table of Contents:\n--------------------------------------------------\n",
		"  1. Overview\n",
		"    2. Details\n",
		"\nDocument is large. Use --section <number> to read a specific section.\n",
	}

	for _, want := range wantParts {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got:\n%s", want, got)
		}
	}
}

func TestFormatWithCommas(t *testing.T) {
	if got := formatWithCommas(8529); got != "8,529" {
		t.Fatalf("expected comma-formatted number, got %q", got)
	}
}

func TestCLIDocDeleteRejectsStaleExpectedHashWithoutSideEffects(t *testing.T) {
	projectRoot := t.TempDir()
	t.Chdir(projectRoot)
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("cli-doc-delete"); err != nil {
		t.Fatal(err)
	}
	created := &models.Doc{Path: "cli-delete", Title: "CLI delete", Content: "safe content"}
	if err := store.MutateDocWithHistory(context.Background(), nil, created, storage.DocMutationOptions{Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	base, err := store.Docs.Get(created.Path)
	if err != nil {
		t.Fatal(err)
	}
	baseHash := base.CanonicalHash
	if err := store.MutateDocWithHistory(context.Background(), base, &models.Doc{Path: base.Path, ID: base.ID, Title: "cli-delete-secret-title", Content: "cli-delete-secret-content", UpdatedAt: base.UpdatedAt}, storage.DocMutationOptions{ExpectedHash: baseHash}); err != nil {
		t.Fatal(err)
	}
	historyBefore, err := store.Versions.GetDocHistory(base.Path)
	if err != nil {
		t.Fatal(err)
	}
	_ = docDeleteCmd.Flags().Set("force", "true")
	_ = docDeleteCmd.Flags().Set("dry-run", "false")
	_ = docDeleteCmd.Flags().Set("expected-hash", baseHash)
	t.Cleanup(func() {
		_ = docDeleteCmd.Flags().Set("force", "false")
		_ = docDeleteCmd.Flags().Set("dry-run", "false")
		_ = docDeleteCmd.Flags().Set("expected-hash", "")
	})
	err = docDeleteCmd.RunE(docDeleteCmd, []string{base.Path})
	if err == nil || !errors.Is(err, storage.ErrHistoryConflict) {
		t.Fatalf("stale CLI delete error = %v, want conflict", err)
	}
	if strings.Contains(err.Error(), "cli-delete-secret-title") || strings.Contains(err.Error(), "cli-delete-secret-content") {
		t.Fatalf("stale CLI delete leaked document content: %v", err)
	}
	if _, err := store.Docs.Get(base.Path); err != nil {
		t.Fatalf("stale CLI delete removed canonical doc: %v", err)
	}
	historyAfter, err := store.Versions.GetDocHistory(base.Path)
	if err != nil || len(historyAfter.Versions) != len(historyBefore.Versions) {
		t.Fatalf("stale CLI delete changed history: before=%d after=%d err=%v", len(historyBefore.Versions), len(historyAfter.Versions), err)
	}
}

func TestCLIDocHardDeleteIsSeparateAuthorizedPurge(t *testing.T) {
	projectRoot := t.TempDir()
	t.Chdir(projectRoot)
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("cli-doc-hard-delete"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "cli-hard-delete", Title: "private", Content: "secret"}
	if err := store.MutateDocWithHistory(context.Background(), nil, doc, storage.DocMutationOptions{Actor: "test", Source: "test"}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	set := func(name, value string) { _ = docHardDeleteCmd.Flags().Set(name, value) }
	set("allow-hard-delete", "true")
	set("yes", "true")
	set("reason", "privacy request")
	set("expected-hash", current.CanonicalHash)
	t.Cleanup(func() {
		set("allow-hard-delete", "false")
		set("yes", "false")
		set("reason", "")
		set("expected-hash", "")
	})
	if err := docHardDeleteCmd.RunE(docHardDeleteCmd, []string{doc.Path}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Docs.Get(doc.Path); err == nil {
		t.Fatal("hard-deleted doc remains")
	}
	if history, err := store.Versions.GetDocHistory(doc.Path); err == nil && len(history.Versions) != 0 {
		t.Fatalf("hard-deleted doc history remains: %d", len(history.Versions))
	}
}
