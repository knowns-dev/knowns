package memoryreview

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestAddNoMatchCreatesProposedMemory(t *testing.T) {
	store := newReviewTestStore(t)
	result, err := New(store).Add(&models.MemoryEntry{
		Title:    "Unique Memory",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Use review gates for new project memories.",
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultCreated || result.Memory == nil {
		t.Fatalf("result = %+v, want created memory", result)
	}
	if result.Memory.Status != models.MemoryStatusProposed {
		t.Fatalf("memory status = %q, want %q", result.Memory.Status, models.MemoryStatusProposed)
	}
	if result.Memory.CurrentForDefaultRetrieval() {
		t.Fatal("proposed memory should be excluded from default retrieval")
	}
}

func TestAddDuplicateReturnsReviewRequiredAndDoesNotWrite(t *testing.T) {
	store := newReviewTestStore(t)
	createReviewMemory(t, store, &models.MemoryEntry{
		ID:       "active1",
		Title:    "Default vector database",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Use Qdrant as the default vector database.",
		Status:   models.MemoryStatusActive,
	})

	before := countReviewMemories(t, store)
	result, err := New(store).Add(&models.MemoryEntry{
		Title:    "Default vector database",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Use Qdrant as the default vector database.",
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultReviewRequired {
		t.Fatalf("status = %q, want %q", result.Status, ResultReviewRequired)
	}
	if len(result.Matches) != 1 || result.Matches[0].ID != "active1" {
		t.Fatalf("matches = %+v, want active1", result.Matches)
	}
	if after := countReviewMemories(t, store); after != before {
		t.Fatalf("memory count changed on review: before=%d after=%d", before, after)
	}
}

func TestResolveUpdateExistingRecordsVerification(t *testing.T) {
	store := newReviewTestStore(t)
	fixed := time.Date(2026, 6, 18, 5, 0, 0, 0, time.UTC)
	createReviewMemory(t, store, &models.MemoryEntry{
		ID:       "target1",
		Title:    "Old guidance",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Old content.",
		Status:   models.MemoryStatusActive,
	})

	svc := New(store)
	svc.Now = func() time.Time { return fixed }
	result, err := svc.Resolve(&models.MemoryEntry{
		Title:    "Updated guidance",
		Category: "decision",
		Content:  "Updated content.",
		Sources:  []string{"@doc/specs/memory"},
	}, ResolveOptions{Resolution: ResolutionUpdateExisting, TargetID: "target1"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if result.Status != ResultResolved || result.Memory.ID != "target1" {
		t.Fatalf("result = %+v", result)
	}
	updated, err := store.Memory.Get("target1")
	if err != nil {
		t.Fatalf("get updated: %v", err)
	}
	if updated.Title != "Updated guidance" || updated.Content != "Updated content." {
		t.Fatalf("updated memory = %+v", updated)
	}
	if !updated.LastVerified.Equal(fixed) {
		t.Fatalf("LastVerified = %s, want %s", updated.LastVerified, fixed)
	}
	if len(updated.Sources) != 1 || updated.Sources[0] != "@doc/specs/memory" {
		t.Fatalf("Sources = %#v", updated.Sources)
	}
}

func TestResolveArchiveCreateMergeAndReject(t *testing.T) {
	store := newReviewTestStore(t)
	createReviewMemory(t, store, &models.MemoryEntry{
		ID:       "old1",
		Title:    "Old vector DB",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Use Chroma as the vector database.",
		Status:   models.MemoryStatusActive,
	})

	svc := New(store)
	archiveResult, err := svc.Resolve(&models.MemoryEntry{
		Title:    "New vector DB",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Use Qdrant as the vector database.",
	}, ResolveOptions{Resolution: ResolutionArchiveExistingCreateNew, TargetID: "old1", Status: models.MemoryStatusActive})
	if err != nil {
		t.Fatalf("archive resolve: %v", err)
	}
	old, err := store.Memory.Get("old1")
	if err != nil {
		t.Fatalf("get old: %v", err)
	}
	if old.Status != models.MemoryStatusArchived {
		t.Fatalf("old status = %q, want archived", old.Status)
	}
	if archiveResult.Memory == nil || archiveResult.Memory.Status != models.MemoryStatusActive {
		t.Fatalf("replacement = %+v, want active memory", archiveResult.Memory)
	}

	mergeResult, err := svc.Resolve(&models.MemoryEntry{
		Title:    "Duplicate vector DB",
		Layer:    models.MemoryLayerProject,
		Category: "decision",
		Content:  "Duplicate guidance.",
	}, ResolveOptions{Resolution: ResolutionMergeExisting, TargetID: archiveResult.Memory.ID})
	if err != nil {
		t.Fatalf("merge resolve: %v", err)
	}
	if mergeResult.Memory.Status != models.MemoryStatusMerged || mergeResult.Memory.MergedInto != archiveResult.Memory.ID {
		t.Fatalf("merge tombstone = %+v", mergeResult.Memory)
	}
	if mergeResult.Memory.CurrentForDefaultRetrieval() {
		t.Fatal("merged tombstone should be excluded from default retrieval")
	}

	rejectResult, err := svc.Resolve(&models.MemoryEntry{
		Title:   "Rejected duplicate",
		Layer:   models.MemoryLayerProject,
		Content: "Not useful.",
	}, ResolveOptions{Resolution: ResolutionRejectNew, RejectedReason: "duplicate"})
	if err != nil {
		t.Fatalf("reject resolve: %v", err)
	}
	if rejectResult.Memory.Status != models.MemoryStatusRejected || rejectResult.Memory.RejectedReason != "duplicate" {
		t.Fatalf("rejected memory = %+v", rejectResult.Memory)
	}
}

func TestArchiveCreateValidatesReplacementBeforeArchivingExisting(t *testing.T) {
	store := newReviewTestStore(t)
	createReviewMemory(t, store, &models.MemoryEntry{
		ID:      "active1",
		Title:   "Active memory",
		Layer:   models.MemoryLayerProject,
		Content: "Active content.",
		Status:  models.MemoryStatusActive,
	})

	_, err := New(store).Resolve(&models.MemoryEntry{
		Title: "Invalid replacement",
		Layer: "invalid",
	}, ResolveOptions{Resolution: ResolutionArchiveExistingCreateNew, TargetID: "active1"})
	if err == nil {
		t.Fatal("expected invalid replacement error")
	}
	existing, getErr := store.Memory.Get("active1")
	if getErr != nil {
		t.Fatalf("get existing: %v", getErr)
	}
	if existing.Status != models.MemoryStatusActive {
		t.Fatalf("existing status = %q, want active after failed replacement validation", existing.Status)
	}
}

func TestSemanticReviewUsesRuntimeSearchPath(t *testing.T) {
	calls := reviewSelectorCalls(t)
	if calls["search.InitSemantic"] {
		t.Fatal("memory review must not initialize semantic providers inline")
	}
	if !calls["search.SearchWithRuntime"] {
		t.Fatal("memory review should route semantic matching through search.SearchWithRuntime")
	}
}

func newReviewTestStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("memory-review-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func createReviewMemory(t *testing.T, store *storage.Store, entry *models.MemoryEntry) {
	t.Helper()
	if entry.Layer == "" {
		entry.Layer = models.MemoryLayerProject
	}
	if entry.Status == "" {
		entry.Status = models.MemoryStatusActive
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory %q: %v", entry.ID, err)
	}
}

func countReviewMemories(t *testing.T, store *storage.Store) int {
	t.Helper()
	entries, err := store.Memory.ListPersistent("")
	if err != nil {
		t.Fatalf("list memories: %v", err)
	}
	return len(entries)
}

func reviewSelectorCalls(t *testing.T) map[string]bool {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "review.go", nil, 0)
	if err != nil {
		t.Fatalf("parse review.go: %v", err)
	}
	calls := make(map[string]bool)
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		ident, ok := selector.X.(*ast.Ident)
		if !ok {
			return true
		}
		calls[ident.Name+"."+selector.Sel.Name] = true
		return true
	})
	return calls
}
