package storage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

// A doc body written with surrounding whitespace must not strand its history:
// the file round-trip trims the body, so a head hash covering the untrimmed
// body would reject every later write.
func TestDocContentWhitespaceKeepsHistoryWritable(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-content-canonical"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	created := &models.Doc{Path: "specs/canonical", Title: "Canonical", Content: "\n# Body\n\nline\n"}
	if err := store.MutateDocWithHistory(ctx, nil, created, DocMutationOptions{}); err != nil {
		t.Fatalf("create: %v", err)
	}

	onDisk, err := store.Docs.Get("specs/canonical")
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.Content != "# Body\n\nline" {
		t.Fatalf("disk content=%q, want canonical body", onDisk.Content)
	}
	if hashDoc(onDisk) != hashDoc(created) {
		t.Fatalf("disk hash=%s, in-memory hash=%s: content canonicalisation is asymmetric", hashDoc(onDisk), hashDoc(created))
	}

	next := *onDisk
	next.Tags = []string{"approved"}
	if err := store.MutateDocWithHistory(ctx, onDisk, &next, DocMutationOptions{}); err != nil {
		t.Fatalf("follow-up write rejected: %v", err)
	}
	if _, err := store.Docs.Get("specs/canonical"); err != nil {
		t.Fatal(err)
	}
}

// Chains recorded before content canonicalisation carry a head hash over the
// untrimmed body. They must stay writable instead of reading as corrupt.
func TestDocHistoryWithLegacyUntrimmedHeadHashStaysWritable(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-legacy-head"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	created := &models.Doc{Path: "specs/legacy", Title: "Legacy", Content: "# Body\n\nline"}
	if err := store.MutateDocWithHistory(ctx, nil, created, DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	doc, err := store.Docs.Get("specs/legacy")
	if err != nil {
		t.Fatal(err)
	}

	// Rewrite the head the way the pre-fix writer would have recorded it.
	legacyState := *doc
	legacyState.Content = doc.Content + "\n"
	rewriteHistoryHead(t, store, doc.ID, func(record *models.HistoryRecord) {
		record.NewHash = hashSnapshot(rawDocSnapshot(&legacyState))
		if record.CheckpointPayload != nil {
			record.CheckpointPayload["content"] = legacyState.Content
		}
		for i, change := range record.DocChanges {
			if change.Field == "content" {
				record.DocChanges[i].NewValue = legacyState.Content
			}
		}
	})

	next := *doc
	next.Tags = []string{"approved"}
	if err := store.MutateDocWithHistory(ctx, doc, &next, DocMutationOptions{}); err != nil {
		t.Fatalf("write against legacy head rejected: %v", err)
	}
}

func rewriteHistoryHead(t *testing.T, store *Store, docID string, mutate func(*models.HistoryRecord)) {
	t.Helper()
	path := store.Versions.historyStore().EntityPath("doc", docID)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) == 0 || lines[0] == "" {
		t.Fatalf("history %s is empty", path)
	}
	var record models.HistoryRecord
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &record); err != nil {
		t.Fatal(err)
	}
	mutate(&record)
	record.RecordHash = ""
	record.RecordHash = historyRecordHash(record)
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	lines[len(lines)-1] = string(encoded)
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The watcher-startup reconcile must not diverge from the write that preceded
// it. A divergent head strands the doc: later writes compare the file against a
// head that no longer describes it, and no caller-supplied expected hash can
// resolve that.
func TestWatcherStartupReconcileKeepsDocWritable(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("watcher-startup"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	created := &models.Doc{Path: "specs/watched", Title: "Watched", Content: "# Spec\n\nbody\n", Tags: []string{"spec"}}
	if err := store.MutateDocWithHistory(ctx, nil, created, DocMutationOptions{Actor: "mcp", Source: "mcp"}); err != nil {
		t.Fatalf("create: %v", err)
	}

	reconciler, err := NewFilesystemReconciler(store.Root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.ReconcileLifecycleWithOptions(ctx, true, LifecycleOptions{Source: "watcher-startup", Wait: true}); err != nil {
		t.Fatalf("watcher-startup reconcile: %v", err)
	}

	history, err := store.Versions.GetDocHistory("specs/watched")
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Versions) != 1 {
		t.Fatalf("revisions=%d, want 1: the reconcile recorded a revision the write already covered", len(history.Versions))
	}

	disk, err := store.Docs.Get("specs/watched")
	if err != nil {
		t.Fatal(err)
	}
	tagged := *disk
	tagged.Tags = []string{"spec", "approved"}
	if err := store.MutateDocWithHistory(ctx, disk, &tagged, DocMutationOptions{Actor: "mcp", Source: "mcp"}); err != nil {
		t.Fatalf("tags write refused after reconcile: %v", err)
	}
}

// Heads recorded with the store-relative file path instead of the canonical Doc
// path replay into a state that disagrees with the file on every field-level
// comparison. Those chains must repair themselves rather than stay stranded.
func TestDocHistoryWithStoreRelativeHeadPathHeals(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-path-heal"); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	created := &models.Doc{Path: "specs/watched", Title: "Watched", Content: "# Spec\n\nbody", Tags: []string{"spec"}}
	if err := store.MutateDocWithHistory(ctx, nil, created, DocMutationOptions{Actor: "mcp", Source: "mcp"}); err != nil {
		t.Fatal(err)
	}
	doc, err := store.Docs.Get("specs/watched")
	if err != nil {
		t.Fatal(err)
	}

	rewriteHistoryHead(t, store, doc.ID, func(record *models.HistoryRecord) {
		record.CurrentPath = "docs/specs/watched.md"
	})

	tagged := *doc
	tagged.Tags = []string{"spec", "approved"}
	if err := store.MutateDocWithHistory(ctx, doc, &tagged, DocMutationOptions{Actor: "mcp", Source: "mcp"}); err != nil {
		t.Fatalf("write against store-relative head path refused: %v", err)
	}
	after, err := store.Docs.Get("specs/watched")
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Tags) != 2 {
		t.Fatalf("tags=%v, want the approved tag applied", after.Tags)
	}
}

// Reports any doc whose canonical file state disagrees with its reconstructed
// history head, i.e. any doc a write would still be refused on.
func TestScanStuckDocs(t *testing.T) {
	root := os.Getenv("SCAN_ROOT")
	if root == "" {
		t.Skip("SCAN_ROOT unset")
	}
	store := NewStore(root)
	docs, err := store.Docs.List()
	if err != nil {
		t.Fatal(err)
	}
	stuck, noHistory := 0, 0
	for _, doc := range docs {
		history, err := store.Versions.GetDocHistory(doc.Path)
		if err != nil {
			t.Errorf("UNREADABLE %s: %v", doc.Path, err)
			stuck++
			continue
		}
		if len(history.Versions) == 0 {
			noHistory++
			continue
		}
		head := history.Versions[len(history.Versions)-1]
		headState, err := resolveDocStateFromHistory(history, head.ID)
		if err != nil {
			t.Errorf("UNRESOLVABLE %s: %v", doc.Path, err)
			stuck++
			continue
		}
		if hashDoc(doc) != hashDoc(headState) {
			t.Errorf("STUCK %s: disk=%.10s head=%.10s headPath=%q diskPath=%q", doc.Path, hashDoc(doc), hashDoc(headState), headState.Path, doc.Path)
			stuck++
		}
	}
	t.Logf("scanned=%d stuck=%d withoutHistory=%d", len(docs), stuck, noHistory)
}
