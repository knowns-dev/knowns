package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestReconcileSchedulerQuietCeilingAndHashCoalescing(t *testing.T) {
	clock := time.Unix(0, 0)
	var emitted []ReconcileHint
	s := NewReconcileScheduler(func(h []ReconcileHint) { emitted = append(emitted, h...) }, func() time.Time { return clock })
	for i := 0; i < 50; i++ {
		s.Offer("task-a", "hash-a", ".knowns/tasks/a.md")
	}
	if s.Pending() != 1 {
		t.Fatalf("pending=%d, want 1", s.Pending())
	}
	clock = clock.Add(ReconcileQuietWindow - time.Millisecond)
	s.Tick()
	if len(emitted) != 0 {
		t.Fatal("flushed before quiet window")
	}
	clock = clock.Add(time.Millisecond)
	s.Tick()
	if len(emitted) != 1 {
		t.Fatalf("emitted=%d, want 1", len(emitted))
	}
	// Intermediate hashes are replaced by the final stable identity hint.
	s.Offer("task-b", "a", ".knowns/tasks/b.md")
	s.Offer("task-b", "b", ".knowns/tasks/b.md")
	s.Offer("task-b", "a", ".knowns/tasks/b.md")
	clock = clock.Add(ReconcileQuietWindow)
	s.Tick()
	if len(emitted) != 2 || emitted[1].Path != ".knowns/tasks/b.md" {
		t.Fatalf("A/B/A emitted=%+v", emitted)
	}
	for i := 0; i < 5; i++ {
		s.Offer("task-a", "hash-b", ".knowns/tasks/a.md")
		// Continuous activity for the same identity/hash must be bounded by
		// the ceiling rather than flushed once per quiet interval.
		if i < 4 {
			clock = clock.Add(2 * time.Second)
			s.Tick()
		}
	}
	clock = clock.Add(ReconcileFlushCeiling)
	s.Tick()
	if len(emitted) != 3 {
		t.Fatalf("ceiling emitted=%d, want 3", len(emitted))
	}
}

func TestResolveHintsGroupsRepeatedPathByFinalStableIdentityAndHash(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := filepath.Join(root, "tasks", "a.md")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\nid: task-a\ntitle: Final\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	hints, diagnostics := r.ResolveHints(context.Background(), []ReconcileHint{{Path: path}, {Path: path}, {Path: path}})
	if len(diagnostics) != 0 || len(hints) != 1 {
		t.Fatalf("resolved hints=%+v diagnostics=%+v", hints, diagnostics)
	}
	if hints[0].EntityType != "task" || hints[0].EntityID != "task-a" || hints[0].Hash == "" {
		t.Fatalf("hint identity=%+v", hints[0])
	}
}

func TestFilesystemReconcilePreviewExecuteAndSelfWrite(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	taskPath := filepath.Join(root, "tasks", "a.md")
	docPath := filepath.Join(root, "docs", "d.md")
	if err := os.WriteFile(taskPath, []byte("---\nid: task-a\ntitle: A\nstatus: todo\npriority: medium\nlabels: []\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(docPath, []byte("---\nid: doc-a\ntitle: D\ntags: []\n---\n\n# D\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := r.Reconcile(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(preview) != 2 {
		t.Fatalf("preview=%d, want 2", len(preview))
	}
	if _, err := os.Stat(filepath.Join(root, "history")); !os.IsNotExist(err) {
		t.Fatal("preview wrote history")
	}
	if _, err := r.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) != 1 {
		t.Fatalf("self/restart records=%d, want 1", len(stream.Records))
	}
	if err := os.WriteFile(taskPath, []byte("---\nid: task-a\ntitle: B\nstatus: todo\npriority: medium\nlabels: []\n---\n\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err = r.history.Read(context.Background(), "task", "task-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) != 2 || stream.Records[1].Source != "filesystem" {
		t.Fatalf("records=%d/source=%q", len(stream.Records), stream.Records[1].Source)
	}
	if stream.Records[1].Checkpoint || len(stream.Records[1].TaskChanges) != 1 || stream.Records[1].TaskChanges[0].Field != "title" {
		t.Fatalf("filesystem update should be delta-only: %+v", stream.Records[1])
	}
	if _, err := os.Stat(filepath.Join(root, "history", "state", "manifest.json")); err != nil {
		t.Fatal("manifest missing")
	}
}

func TestFilesystemReconcileFailsClosedForOutsideSymlinkAndDuplicate(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	valid := []byte("---\nid: doc-a\ntitle: D\ntags: []\n---\n\nD\n")
	if err := os.WriteFile(filepath.Join(root, "docs", "a.md"), valid, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "b.md"), valid, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	results, err := r.Reconcile(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	for _, result := range results {
		if result.Diagnostic == "" {
			t.Fatalf("duplicate path %s was accepted", result.Path)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "history")); !os.IsNotExist(err) {
		t.Fatal("duplicate input wrote history")
	}
}

func TestFilesystemReconcileRetriesIndexHandoffBeforeManifest(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "tasks", "a.md")
	if err := os.WriteFile(path, []byte("---\nid: task-a\ntitle: A\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	first, err := NewFilesystemReconciler(root, func(ReconcileResult) error { return os.ErrPermission })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "history", "state", "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("failed handoff advanced manifest")
	}
	var calls int
	second, err := NewFilesystemReconciler(root, func(ReconcileResult) error { calls++; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := second.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("handoff calls=%d, want retry once", calls)
	}
	if _, err := os.Stat(filepath.Join(root, "history", "state", "manifest.json")); err != nil {
		t.Fatal("successful handoff did not advance manifest")
	}
}

func TestFilesystemReconcileLegacyTaskDoesNotOrphanRevisionOne(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "versions"), 0o755); err != nil {
		t.Fatal(err)
	}
	old := map[string]any{"id": "legacy-task", "title": "Old", "status": "todo", "priority": "medium", "timeSpent": 0, "archived": false}
	legacy := &models.TaskVersionHistory{TaskID: "legacy-task", CurrentVersion: 7, Versions: []models.TaskVersion{{ID: "v7", Version: 7, Snapshot: old, NewHash: taskCanonicalHash(old)}}}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "versions", "task-legacy-task.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "tasks", "legacy.md")
	if err := os.WriteFile(path, []byte("---\nid: legacy-task\ntitle: New\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "task", "legacy-task")
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) < 2 || stream.Records[len(stream.Records)-1].Revision <= 1 {
		t.Fatalf("legacy continuity records=%+v", stream.Records)
	}
}

func TestFilesystemReconcileLegacyDocPreservesLogicalRevision(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	path := "guide/a"
	if err := os.MkdirAll(filepath.Join(root, "docs", "guide"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "versions"), 0o755); err != nil {
		t.Fatal(err)
	}
	docID := legacyDocID(path)
	old := map[string]any{"path": path, "id": docID, "title": "Old", "content": "old"}
	legacy := &models.DocVersionHistory{DocID: docID, DocPath: path, CurrentPath: path, CurrentVersion: 4, Versions: []models.DocVersion{{ID: "v4", DocID: docID, DocPath: path, CurrentPath: path, Version: 4, Snapshot: old, NewHash: hashSnapshot(old)}}}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.Versions.legacyDocVersionPath(path), data, 0o644); err != nil {
		t.Fatal(err)
	}
	canonical := "---\nid: " + docID + "\ntitle: New\ntags: []\n---\n\nnew\n"
	if err := os.WriteFile(filepath.Join(root, "docs", "guide", "a.md"), []byte(canonical), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	stream, err := r.history.Read(context.Background(), "doc", docID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) < 2 || stream.Records[len(stream.Records)-1].Revision <= 1 || stream.Records[len(stream.Records)-1].Source != "filesystem" {
		t.Fatalf("legacy Doc continuity records=%+v", stream.Records)
	}
}

func TestReconcileManifestConcurrentMergePreservesEntries(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			key := fmt.Sprintf("task:t%d", i)
			if err := r.writeManifest(reconcileManifest{SchemaVersion: 1, Entries: map[string]manifestEntry{key: {EntityType: "task", EntityID: fmt.Sprintf("t%d", i), Hash: fmt.Sprintf("h%d", i)}}}); err != nil {
				t.Errorf("manifest write: %v", err)
			}
		}()
	}
	wg.Wait()
	manifest, err := r.readManifest()
	if err != nil {
		t.Fatal(err)
	}
	if len(manifest.Entries) != 8 {
		t.Fatalf("merged manifest entries=%d, want 8", len(manifest.Entries))
	}
}

func TestReconcileManifestStaleSnapshotDoesNotReplaceNewerEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	initial := reconcileManifest{SchemaVersion: 1, Entries: map[string]manifestEntry{
		"task:a": {EntityType: "task", EntityID: "a", Hash: "a1", Revision: 1},
		"task:b": {EntityType: "task", EntityID: "b", Hash: "b1", Revision: 1},
	}}
	if err := r.writeManifest(initial); err != nil {
		t.Fatal(err)
	}
	stale := initial
	stale.Entries = map[string]manifestEntry{}
	for key, entry := range initial.Entries {
		stale.Entries[key] = entry
	}
	newer := reconcileManifest{SchemaVersion: 1, Entries: map[string]manifestEntry{
		"task:b": {EntityType: "task", EntityID: "b", Hash: "b2", Revision: 2},
	}}
	if err := r.writeManifest(newer); err != nil {
		t.Fatal(err)
	}
	stale.Entries["task:a"] = manifestEntry{EntityType: "task", EntityID: "a", Hash: "a2", Revision: 2}
	if err := r.writeManifest(stale); err != nil {
		t.Fatal(err)
	}
	got, err := r.readManifest()
	if err != nil {
		t.Fatal(err)
	}
	if got.Entries["task:a"].Hash != "a2" || got.Entries["task:b"].Hash != "b2" {
		t.Fatalf("stale snapshot overwrote newer entry: %+v", got.Entries)
	}
}

func TestReconcileCorruptManifestFailsClosed(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := filepath.Join(root, "history", "state", "manifest.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), true); err == nil {
		t.Fatal("corrupt manifest was silently skipped")
	}
}

func TestFilesystemReconcileRejectsDirectStableIDMove(t *testing.T) {
	for _, changed := range []bool{false, true} {
		for _, hints := range []bool{false, true} {
			name := fmt.Sprintf("changed=%t/hints=%t", changed, hints)
			t.Run(name, func(t *testing.T) {
				root := filepath.Join(t.TempDir(), ".knowns")
				tasks := filepath.Join(root, "tasks")
				if err := os.MkdirAll(tasks, 0o755); err != nil {
					t.Fatal(err)
				}
				oldPath := filepath.Join(tasks, "a.md")
				if err := os.WriteFile(oldPath, []byte("---\nid: moved-task\ntitle: Old\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				calls := 0
				r, err := NewFilesystemReconciler(root, func(ReconcileResult) error { calls++; return nil })
				if err != nil {
					t.Fatal(err)
				}
				if _, err := r.Reconcile(context.Background(), true); err != nil {
					t.Fatal(err)
				}
				streamBefore, err := r.history.Read(context.Background(), "task", "moved-task")
				if err != nil || len(streamBefore.Records) != 1 {
					t.Fatalf("initial history=%+v err=%v", streamBefore.Records, err)
				}
				manifestBefore, err := r.readManifest()
				if err != nil {
					t.Fatal(err)
				}
				calls = 0
				newPath := filepath.Join(tasks, "b.md")
				if err := os.Rename(oldPath, newPath); err != nil {
					t.Fatal(err)
				}
				if changed {
					if err := os.WriteFile(newPath, []byte("---\nid: moved-task\ntitle: Changed\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				var results []ReconcileResult
				if hints {
					results, err = r.ReconcileHints(context.Background(), []ReconcileHint{{Path: newPath}}, true)
				} else {
					results, err = r.Reconcile(context.Background(), true)
				}
				if err != nil {
					t.Fatal(err)
				}
				if len(results) == 0 || results[len(results)-1].Diagnostic == "" {
					t.Fatalf("move was accepted: %+v", results)
				}
				streamAfter, err := r.history.Read(context.Background(), "task", "moved-task")
				if err != nil {
					t.Fatal(err)
				}
				if len(streamAfter.Records) != len(streamBefore.Records) || streamAfter.Records[len(streamAfter.Records)-1].RecordHash != streamBefore.Records[len(streamBefore.Records)-1].RecordHash {
					t.Fatalf("move changed history: before=%+v after=%+v", streamBefore.Records, streamAfter.Records)
				}
				manifestAfter, err := r.readManifest()
				if err != nil {
					t.Fatal(err)
				}
				key := manifestKey("task", "moved-task")
				if manifestAfter.Entries[key].Path != manifestBefore.Entries[key].Path {
					t.Fatalf("manifest path changed from %q to %q", manifestBefore.Entries[key].Path, manifestAfter.Entries[key].Path)
				}
				if calls != 0 {
					t.Fatalf("index handoff calls=%d, want 0", calls)
				}
			})
		}
	}
}

func TestFilesystemReconcilePreviewUsesLegacyTaskRevisionWithoutWriting(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	if err := os.MkdirAll(filepath.Join(root, "tasks"), 0o755); err != nil {
		t.Fatal(err)
	}
	taskPath := filepath.Join(root, "tasks", "legacy.md")
	oldContent := "---\nid: legacy-preview-task\ntitle: Old\nstatus: todo\npriority: medium\nlabels: []\n---\n"
	if err := os.WriteFile(taskPath, []byte(oldContent), 0o644); err != nil {
		t.Fatal(err)
	}
	task, err := parseTaskContent(oldContent)
	if err != nil {
		t.Fatal(err)
	}
	legacy := &models.TaskVersionHistory{TaskID: task.ID, CurrentVersion: 7, Versions: []models.TaskVersion{{ID: "v7", TaskID: task.ID, Version: 7, Snapshot: TaskToSnapshot(task), NewHash: CanonicalTaskHash(task)}}}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "versions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "versions", "task-"+task.ID+".json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := r.Reconcile(context.Background(), false)
	if err != nil || len(preview) != 1 {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	if preview[0].Changed || preview[0].Revision != 7 {
		t.Fatalf("unchanged legacy preview=%+v, want current v7", preview[0])
	}
	if _, err := os.Stat(filepath.Join(root, "history")); !os.IsNotExist(err) {
		t.Fatalf("preview wrote history: %v", err)
	}
	if err := os.WriteFile(taskPath, []byte("---\nid: legacy-preview-task\ntitle: New\nstatus: todo\npriority: medium\nlabels: []\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	preview, err = r.Reconcile(context.Background(), false)
	if err != nil || len(preview) != 1 || !preview[0].Changed || preview[0].Revision != 8 {
		t.Fatalf("changed legacy preview=%+v err=%v, want next v8", preview, err)
	}
}

func TestFilesystemReconcilePreviewUsesLegacyDocRevisionWithoutWriting(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	path := "guide/legacy-preview"
	canonicalPath := filepath.Join(root, "docs", "guide", "legacy-preview.md")
	if err := os.MkdirAll(filepath.Dir(canonicalPath), 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\nid: legacy-preview-doc\ntitle: Old\ntags: []\n---\n\nold\n"
	if err := os.WriteFile(canonicalPath, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	doc, err := parseDocContent(content, path, "guide", false, "")
	if err != nil {
		t.Fatal(err)
	}
	legacy := &models.DocVersionHistory{DocID: doc.ID, DocPath: path, CurrentPath: path, CurrentVersion: 4, Versions: []models.DocVersion{{ID: "v4", DocID: doc.ID, DocPath: path, CurrentPath: path, Version: 4, Snapshot: DocToSnapshot(doc), NewHash: CanonicalDocHash(doc)}}}
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	store := NewStore(root)
	if err := os.MkdirAll(filepath.Join(root, "versions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.Versions.legacyDocVersionPath(path), data, 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := NewFilesystemReconciler(root)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := r.Reconcile(context.Background(), false)
	if err != nil || len(preview) != 1 || preview[0].Changed || preview[0].Revision != 4 {
		t.Fatalf("unchanged legacy Doc preview=%+v err=%v", preview, err)
	}
	if _, err := os.Stat(filepath.Join(root, "history")); !os.IsNotExist(err) {
		t.Fatalf("preview wrote history: %v", err)
	}
	if err := os.WriteFile(canonicalPath, []byte("---\nid: legacy-preview-doc\ntitle: New\ntags: []\n---\n\nnew\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	preview, err = r.Reconcile(context.Background(), false)
	if err != nil || len(preview) != 1 || !preview[0].Changed || preview[0].Revision != 5 {
		t.Fatalf("changed legacy Doc preview=%+v err=%v, want next v5", preview, err)
	}
}
