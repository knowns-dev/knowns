package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestDocStoreRejectsTraversalAndSymlinkEscape(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	base := t.TempDir()
	store := NewStore(filepath.Join(base, ".knowns"))
	if err := store.Init("doc-path-security"); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(base, "outside.md")
	if err := os.WriteFile(outside, []byte("outside"), 0644); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"../outside", `..\outside`, "/tmp/outside", `C:\outside`} {
		if err := store.Docs.Create(&models.Doc{Path: path, Title: "Unsafe"}); err == nil {
			t.Errorf("Create(%q) succeeded, want containment error", path)
		}
		if _, err := store.Docs.Get(path); err == nil {
			t.Errorf("Get(%q) succeeded, want containment error", path)
		}
		if err := store.Docs.Delete(path); err == nil {
			t.Errorf("Delete(%q) succeeded, want containment error", path)
		}
	}

	link := filepath.Join(store.Root, "docs", "linked")
	outsideDir := filepath.Join(base, "outside-dir")
	if err := os.MkdirAll(outsideDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, link); err == nil {
		if err := store.Docs.Create(&models.Doc{Path: "linked/escape", Title: "Unsafe"}); err == nil {
			t.Fatal("Create through escaping symlink succeeded")
		}
		if _, err := os.Stat(filepath.Join(outsideDir, "escape.md")); !os.IsNotExist(err) {
			t.Fatalf("doc escaped through symlink: %v", err)
		}
	}

	if got, err := os.ReadFile(outside); err != nil || string(got) != "outside" {
		t.Fatalf("outside file changed: content=%q err=%v", got, err)
	}
}

func TestDocStoreAllowsNestedRelativePath(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-path-security"); err != nil {
		t.Fatal(err)
	}
	doc := &models.Doc{Path: "guides/setup", Title: "Setup", Content: "safe"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("Create nested doc: %v", err)
	}
	got, err := store.Docs.Get(doc.Path)
	if err != nil || got.Content != "safe" {
		t.Fatalf("Get nested doc: doc=%+v err=%v", got, err)
	}
}

func TestDocStoreRenameAndRewriteDocReferences(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("doc-rename-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()
	oldDoc := &models.Doc{
		Path:      "guides/old",
		Title:     "Old",
		Content:   "Old content",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.Docs.Create(oldDoc); err != nil {
		t.Fatalf("create old doc: %v", err)
	}
	if err := store.Docs.Create(&models.Doc{
		Path:      "guides/consumer",
		Title:     "Consumer",
		Content:   "See @doc/guides/old:10-20{implements} and @doc/guides/old#overview.",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create consumer doc: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:                  "rag001",
		Title:               "Task",
		Description:         "Desc @doc/guides/old{related}",
		ImplementationPlan:  "Plan @doc/guides/old:3",
		ImplementationNotes: "Notes @doc/guides/old#intro",
		Status:              "todo",
		Priority:            "medium",
		CreatedAt:           now,
		UpdatedAt:           now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "mem001",
		Title:     "Memory",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Remember @doc/guides/old{implements}",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	renamed := *oldDoc
	renamed.Path = "guides/new"
	renamed.UpdatedAt = time.Now().UTC()

	if err := store.Docs.Rename(oldDoc.Path, &renamed); err != nil {
		t.Fatalf("rename doc: %v", err)
	}
	if err := store.Docs.RewriteDocReferences(oldDoc.Path, renamed.Path, store.Tasks, store.Memory); err != nil {
		t.Fatalf("rewrite doc refs: %v", err)
	}

	if _, err := store.Docs.Get("guides/old"); err == nil {
		t.Fatal("expected old doc path to be removed after rename")
	}
	if _, err := store.Docs.Get("guides/new"); err != nil {
		t.Fatalf("expected renamed doc at new path: %v", err)
	}

	consumer, err := store.Docs.Get("guides/consumer")
	if err != nil {
		t.Fatalf("get consumer doc: %v", err)
	}
	wantConsumer := "See @doc/guides/new:10-20{implements} and @doc/guides/new#overview."
	if consumer.Content != wantConsumer {
		t.Fatalf("consumer doc content = %q, want %q", consumer.Content, wantConsumer)
	}

	task, err := store.Tasks.Get("rag001")
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if task.Description != "Desc @doc/guides/new{related}" {
		t.Fatalf("task description = %q", task.Description)
	}
	if task.ImplementationPlan != "Plan @doc/guides/new:3" {
		t.Fatalf("task plan = %q", task.ImplementationPlan)
	}
	if task.ImplementationNotes != "Notes @doc/guides/new#intro" {
		t.Fatalf("task notes = %q", task.ImplementationNotes)
	}

	memory, err := store.Memory.Get("mem001")
	if err != nil {
		t.Fatalf("get memory: %v", err)
	}
	if memory.Content != "Remember @doc/guides/new{implements}" {
		t.Fatalf("memory content = %q", memory.Content)
	}
}

func TestDocStoreApprovedLockedDecisionEditRequiresReview(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("spec-review-gate-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	doc := &models.Doc{
		Path: "specs/example", Title: "Example", Tags: []string{"spec", "approved"}, CreatedAt: now, UpdatedAt: now,
		Content: "## Locked Decisions\n\n- D1: Keep the stable rule.\n\n## Task Links\n\nNone.",
	}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create spec: %v", err)
	}

	nonDecisionEdit := *doc
	nonDecisionEdit.Content = "## Locked Decisions\n\n- D1: Keep the stable rule.\n\n## Task Links\n\n- @task-abc123"
	if err := store.Docs.Update(&nonDecisionEdit); err != nil {
		t.Fatalf("update task links: %v", err)
	}
	if !docHasTag(nonDecisionEdit.Tags, "approved") {
		t.Fatalf("non-decision edit removed approval: %#v", nonDecisionEdit.Tags)
	}

	decisionEdit := nonDecisionEdit
	decisionEdit.Content = "## Locked Decisions\n\n- D1: Use the replacement rule.\n\n## Task Links\n\n- @task-abc123"
	if err := store.Docs.Update(&decisionEdit); err != nil {
		t.Fatalf("update locked decision: %v", err)
	}
	if docHasTag(decisionEdit.Tags, "approved") || !docHasTag(decisionEdit.Tags, "draft") || !docHasTag(decisionEdit.Tags, "review-required") {
		t.Fatalf("locked decision edit tags = %#v, want draft review-required without approved", decisionEdit.Tags)
	}
}
