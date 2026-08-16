package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestLegacyDocMigrationReconcilesImmediately(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	doc := &models.Doc{Path: "guide/reconcile", Title: "Current", Content: "current"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatal(err)
	}
	legacyPath := store.Versions.legacyDocVersionPath(doc.Path)
	legacy := &models.DocVersionHistory{DocPath: doc.Path, Versions: []models.DocVersion{{ID: "v7", DocPath: doc.Path, Version: 7, Snapshot: map[string]any{"path": doc.Path, "title": "Old", "content": "old"}, NewHash: "not-the-snapshot-hash", Timestamp: time.Unix(7, 0).UTC()}}}
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	legacyBefore, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Versions.MigrateLegacyDocHistory(context.Background(), doc.Path); err != nil {
		t.Fatal(err)
	}
	stream, err := store.Versions.historyStore().Read(context.Background(), "doc", legacyDocID(doc.Path))
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) != 2 || stream.Records[1].Source != "migration-reconcile" || !stream.Records[1].Checkpoint {
		t.Fatalf("stream=%#v", stream.Records)
	}
	h, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if h.CurrentVersion != 8 || h.Versions[0].Version != 7 || h.Versions[len(h.Versions)-1].Version != 8 || h.Versions[len(h.Versions)-1].Snapshot["content"] != "current" {
		t.Fatalf("history=%#v", h)
	}
	// A direct retry reconstructs the same logical history. Its newly generated
	// reconcile wall-clock timestamp is tolerated, while all state, hashes,
	// provenance, and legacy metadata remain equivalent.
	if err := store.Versions.historyStore().MigrateLegacyDocWithCurrent(context.Background(), legacyPath, legacyDocID(doc.Path), doc.Path, legacy, DocToSnapshot(doc)); err != nil {
		t.Fatalf("idempotent migration retry: %v", err)
	}
	updated := *doc
	updated.Content = "next"
	if err := store.Versions.SaveDocRevision(doc, &updated); err != nil {
		t.Fatal(err)
	}
	h, err = store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if h.CurrentVersion != 9 || len(h.Versions) != 3 || h.Versions[2].Version != 9 {
		t.Fatalf("logical versions after write=%#v", h.Versions)
	}
	legacyAfter, _ := os.ReadFile(legacyPath)
	if string(legacyBefore) != string(legacyAfter) {
		t.Fatal("legacy file changed during migration")
	}
}

func TestLegacyDocIncompleteRootStillActivatesReconcile(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	doc := &models.Doc{Path: "guide/incomplete", Title: "Now", Content: "now"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatal(err)
	}
	legacyPath := store.Versions.legacyDocVersionPath(doc.Path)
	legacy := &models.DocVersionHistory{DocPath: doc.Path, Versions: []models.DocVersion{{ID: "v1", Version: 1, DocPath: doc.Path, Changes: []models.DocChange{{Field: "title", NewValue: "unknown"}}}, {ID: "v2", Version: 2, DocPath: doc.Path, Snapshot: map[string]any{"path": doc.Path, "title": "partial"}}}}
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	if err := store.Versions.MigrateLegacyDocHistory(context.Background(), doc.Path); err != nil {
		t.Fatal(err)
	}
	stream, err := store.Versions.historyStore().Read(context.Background(), "doc", legacyDocID(doc.Path))
	if err != nil {
		t.Fatal(err)
	}
	if len(stream.Records) != 3 || stream.Records[2].Source != "migration-reconcile" {
		t.Fatalf("records=%#v", stream.Records)
	}
}

func TestSingleUnverifiedLegacyRecordCannotActivateWithoutReconcile(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	legacy := &models.DocVersionHistory{DocPath: "single", Versions: []models.DocVersion{{Version: 1, Snapshot: map[string]any{"path": "single", "title": "old"}, NewHash: "wrong"}}}
	err := history.MigrateLegacyDoc(context.Background(), filepath.Join(root, "versions", "doc-single.json"), legacyDocID("single"), "single", legacy)
	if err == nil {
		t.Fatal("unverified migration without canonical reconcile unexpectedly succeeded")
	}
	if _, statErr := os.Stat(history.EntityPath("doc", legacyDocID("single"))); !os.IsNotExist(statErr) {
		t.Fatal("unverified migration activated JSONL")
	}
}

func TestLegacyMigrationRejectsCallerPayloadDifferentFromProvenanceBytes(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	legacyPath := filepath.Join(root, "versions", "task-exact.json")
	onDisk := &models.TaskVersionHistory{TaskID: "exact", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "disk"}}}}
	if err := writeJSON(legacyPath, onDisk); err != nil {
		t.Fatal(err)
	}
	caller := &models.TaskVersionHistory{TaskID: "exact", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "caller"}}}}
	if err := history.MigrateLegacyTask(context.Background(), legacyPath, "exact", caller); err == nil {
		t.Fatal("caller-supplied history unrelated to provenance bytes was accepted")
	}
	if _, err := os.Stat(history.EntityPath("task", "exact")); !os.IsNotExist(err) {
		t.Fatal("mismatched provenance migration activated JSONL")
	}
}

func TestHistoryRetentionRollbackOnAtomicSwapFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	base := NewHistoryStore(root)
	baseHash := ""
	for i := 0; i < 5; i++ {
		newHash := taskCanonicalHash(map[string]any{"title": string(rune('a' + i))})
		if err := base.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "retain", BaseHash: baseHash, Checkpoint: true, CheckpointPayload: map[string]any{"title": string(rune('a' + i))}, NewHash: newHash, Timestamp: time.Unix(int64(i), 0).UTC()}); err != nil {
			t.Fatal(err)
		}
		baseHash = newHash
	}
	before, err := os.ReadFile(base.EntityPath("task", "retain"))
	if err != nil {
		t.Fatal(err)
	}
	failing := NewHistoryStore(root, HistoryStoreOptions{Rename: func(string, string) error { return errors.New("injected swap") }})
	if err := failing.Compact(context.Background(), "task", "retain", HistoryRetentionPolicy{MaxDetailedRevisions: 1, MaxDetailedAge: time.Hour, Now: time.Unix(10, 0).UTC()}); err == nil {
		t.Fatal("expected injected swap failure")
	}
	after, err := os.ReadFile(base.EntityPath("task", "retain"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("failed compaction changed durable history")
	}
}

func TestHistoryRetentionKeepsBoundaryDeltaState(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	state := map[string]any{"title": "a"}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "delta", Checkpoint: true, CheckpointPayload: cloneMap(state), NewHash: taskCanonicalHash(state), Timestamp: time.Unix(0, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	for i, title := range []string{"b", "c", "d"} {
		oldHash := taskCanonicalHash(state)
		state = map[string]any{"title": title}
		if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "delta", BaseHash: oldHash, NewHash: taskCanonicalHash(state), TaskChanges: []models.TaskChange{{Field: "title", OldValue: string(rune('a' + i)), NewValue: title}}, Timestamp: time.Unix(int64(i+1), 0).UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	before, err := history.Read(context.Background(), "task", "delta")
	if err != nil {
		t.Fatal(err)
	}
	want := before.Records[len(before.Records)-1].NewHash
	if err := history.Compact(context.Background(), "task", "delta", HistoryRetentionPolicy{MaxDetailedRevisions: 1, MaxDetailedAge: time.Hour, Now: time.Unix(10, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	after, err := history.Read(context.Background(), "task", "delta")
	if err != nil {
		t.Fatal(err)
	}
	if got := after.Records[len(after.Records)-1].NewHash; got != want {
		t.Fatalf("current hash changed by compaction: got %q want %q", got, want)
	}
	replayed, err := taskHistoryFromRecords("delta", after.Records)
	if err != nil {
		t.Fatal(err)
	}
	if len(replayed.Versions) == 0 || replayed.Versions[len(replayed.Versions)-1].Snapshot["title"] != "d" {
		t.Fatalf("replayed=%#v", replayed)
	}
}

func TestCompactionRejectsSemanticallyCorruptRecordWithoutChangingBytes(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	first := map[string]any{"title": "first"}
	second := map[string]any{"title": "second"}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "compact-corrupt", Checkpoint: true, CheckpointPayload: first, NewHash: taskCanonicalHash(first)}); err != nil {
		t.Fatal(err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "compact-corrupt", BaseHash: taskCanonicalHash(first), TaskChanges: []models.TaskChange{{Field: "title", NewValue: "second"}}, NewHash: taskCanonicalHash(second)}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("task", "compact-corrupt")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(data, []byte("\n"))
	var corrupt models.HistoryRecord
	if err := json.Unmarshal(lines[1], &corrupt); err != nil {
		t.Fatal(err)
	}
	corrupt.NewHash = "valid-envelope-but-wrong-canonical-hash"
	corrupt.RecordHash = historyRecordHash(corrupt)
	encoded, err := json.Marshal(corrupt)
	if err != nil {
		t.Fatal(err)
	}
	lines[1] = encoded
	corruptData := bytes.Join(lines, []byte("\n"))
	if err := os.WriteFile(path, corruptData, 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := history.Compact(context.Background(), "task", "compact-corrupt", HistoryRetentionPolicy{MaxDetailedRevisions: 1, MaxDetailedAge: time.Hour, Now: time.Now().UTC()}); err == nil {
		t.Fatal("semantic corruption was compacted")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("failed semantic validation changed active history bytes")
	}
}

func TestDefaultRetentionBoundsDetailedHistoryAndReportsGap(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	state := map[string]any{"title": "0"}
	previous := ""
	for i := 0; i < 205; i++ {
		state = map[string]any{"title": string(rune('a' + (i % 26)))}
		newHash := taskCanonicalHash(state)
		if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "task", EntityID: "default-retain", BaseHash: previous, NewHash: newHash, Checkpoint: i == 0, CheckpointPayload: cloneMap(state), TaskChanges: []models.TaskChange{{Field: "title", NewValue: state["title"]}}, Timestamp: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
		previous = newHash
	}
	if err := history.Compact(context.Background(), "task", "default-retain", HistoryRetentionPolicy{}); err != nil {
		t.Fatal(err)
	}
	result, err := history.Read(context.Background(), "task", "default-retain")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Records) > DefaultHistoryMaxDetailedRevisions {
		t.Fatalf("retained %d records, want <= %d", len(result.Records), DefaultHistoryMaxDetailedRevisions)
	}
	if len(result.Records[0].RetentionGaps) != 1 || result.Records[0].RetentionGaps[0].Count == 0 {
		t.Fatalf("retention gap metadata=%#v", result.Records[0].RetentionGaps)
	}
	if result.Records[len(result.Records)-1].NewHash != previous {
		t.Fatal("current hash changed")
	}
}

func TestDocRetentionReplaysSectionDeltaWithoutLosingOtherSections(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	oldContent := "# A\nold\n\n# B\nkeep"
	newContent := "# A\nnew\n\n# B\nkeep"
	oldSnapshot := map[string]any{"path": "section", "title": "Section", "content": oldContent}
	newSnapshot := map[string]any{"path": "section", "title": "Section", "content": newContent}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: "section", Checkpoint: true, CheckpointPayload: oldSnapshot, NewHash: hashSnapshot(oldSnapshot), CurrentPath: "section"}); err != nil {
		t.Fatal(err)
	}
	if err := history.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: "section", BaseHash: hashSnapshot(oldSnapshot), NewHash: hashSnapshot(newSnapshot), CurrentPath: "section", DocChanges: []models.DocChange{{Field: "content", OldValue: "# A\nold", NewValue: "# A\nnew"}}, ChangedScopes: []models.DocChangeScope{{Type: "section", Field: "content", Section: "A"}}}); err != nil {
		t.Fatal(err)
	}
	if err := history.Compact(context.Background(), "doc", "section", HistoryRetentionPolicy{MaxDetailedRevisions: 1, MaxDetailedAge: time.Hour, Now: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	result, err := history.Read(context.Background(), "doc", "section")
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := docHistoryFromRecords("section", result.Records)
	if err != nil {
		t.Fatal(err)
	}
	state, err := resolveDocStateFromHistory(replayed, "")
	if err != nil {
		t.Fatal(err)
	}
	if state.Content != newContent {
		t.Fatalf("section replay content=%q want %q", state.Content, newContent)
	}
}

func TestLegacyCleanupRequiresManagedVerifiedSuccessor(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	legacy := filepath.Join(root, "versions", "task-clean.json")
	if err := os.MkdirAll(filepath.Dir(legacy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(legacy, &models.TaskVersionHistory{TaskID: "clean", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "x"}}}}); err != nil {
		t.Fatal(err)
	}
	legacyHistory := &models.TaskVersionHistory{TaskID: "clean", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "x"}}}}
	if err := history.MigrateLegacyTask(context.Background(), legacy, "clean", legacyHistory); err != nil {
		t.Fatal(err)
	}
	if err := history.ConfirmLegacyCleanup(context.Background(), LegacyCleanupTarget{EntityType: "task", EntityID: "clean", LegacyPath: filepath.Join(root, "..", "victim")}, true); err == nil {
		t.Fatal("unmanaged cleanup path was accepted")
	}
	report := history.PreviewLegacyCleanup("task", "clean", legacy)
	if len(report.Targets) != 1 || !report.Targets[0].Verified {
		t.Fatalf("cleanup preview=%#v", report)
	}
	if err := history.ConfirmLegacyCleanup(context.Background(), report.Targets[0], true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatal("verified legacy file was not removed")
	}

	// A path-keyed Doc from another entity must not become deletable merely
	// because its payload claims the target stable ID.
	docID := legacyDocID("guide/a")
	docLegacy := filepath.Join(root, "versions", "doc-guide--b.json")
	if err := writeJSON(docLegacy, &models.DocVersionHistory{DocID: docID, DocPath: "guide/a", CurrentPath: "guide/a", Versions: []models.DocVersion{{Version: 1, Snapshot: map[string]any{"path": "guide/a", "title": "a"}}}}); err != nil {
		t.Fatal(err)
	}
	docHistory := NewHistoryStore(root)
	checkpoint := map[string]any{"path": "guide/a", "title": "a"}
	if err := docHistory.Append(context.Background(), models.HistoryRecord{EntityType: "doc", EntityID: docID, Checkpoint: true, CheckpointPayload: checkpoint, NewHash: hashSnapshot(checkpoint), CurrentPath: "guide/a"}); err != nil {
		t.Fatal(err)
	}
	if err := docHistory.ConfirmLegacyCleanup(context.Background(), LegacyCleanupTarget{EntityType: "doc", EntityID: docID, LegacyPath: docLegacy}, true); err == nil {
		t.Fatal("cross-Doc legacy path was accepted for cleanup")
	}
}

func TestLegacyCleanupRejectsModifiedLegacyAndUnrelatedActiveSuccessor(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	legacyPath := filepath.Join(root, "versions", "task-provenance.json")
	legacy := &models.TaskVersionHistory{TaskID: "provenance", Versions: []models.TaskVersion{{ID: "v1", Version: 1, Snapshot: map[string]any{"title": "original"}}}}
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	if err := history.MigrateLegacyTask(context.Background(), legacyPath, "provenance", legacy); err != nil {
		t.Fatal(err)
	}
	report := history.PreviewLegacyCleanup("task", "provenance", legacyPath)
	if len(report.Targets) != 1 || !report.Targets[0].Verified {
		t.Fatalf("initial cleanup preview=%#v", report)
	}
	// The preview token binds the exact legacy bytes. Replacing the legacy
	// JSON, even with valid content for the same entity, must invalidate it.
	modified := &models.TaskVersionHistory{TaskID: "provenance", Versions: []models.TaskVersion{{ID: "v1", Version: 1, Snapshot: map[string]any{"title": "modified"}}}}
	if err := writeJSON(legacyPath, modified); err != nil {
		t.Fatal(err)
	}
	if err := history.ConfirmLegacyCleanup(context.Background(), report.Targets[0], true); err == nil {
		t.Fatal("modified legacy bytes were accepted by stale cleanup confirmation")
	}
	if _, err := os.Stat(legacyPath); err != nil {
		t.Fatalf("modified legacy file was removed: %v", err)
	}

	// Restore the original bytes, then replace the active stream with a valid
	// same-entity stream carrying different immutable provenance. Path/ID alone
	// must not authorize deletion of the restored legacy file.
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	activePath := history.EntityPath("task", "provenance")
	unrelated := models.HistoryRecord{EntityType: "task", EntityID: "provenance", Checkpoint: true, CheckpointPayload: map[string]any{"title": "other"}, NewHash: taskCanonicalHash(map[string]any{"title": "other"}), Legacy: true, LegacyPath: filepath.Join(root, "versions", "task-other.json"), LegacyDigest: "other-digest"}
	data, _, err := marshalReplacementRecords([]models.HistoryRecord{unrelated}, "task", "provenance")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activePath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := history.ConfirmLegacyCleanup(context.Background(), report.Targets[0], true); err == nil {
		t.Fatal("unrelated valid active successor was accepted")
	}
	if _, err := os.Stat(legacyPath); err != nil {
		t.Fatalf("legacy file was removed after unrelated successor: %v", err)
	}
}

func TestReplaceRecordsRejectsExistingTruncatedOrCorruptActive(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	history := NewHistoryStore(root)
	legacyPath := filepath.Join(root, "versions", "task-replace.json")
	legacy := &models.TaskVersionHistory{TaskID: "replace", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "legacy"}}}}
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	if err := history.MigrateLegacyTask(context.Background(), legacyPath, "replace", legacy); err != nil {
		t.Fatal(err)
	}
	activePath := history.EntityPath("task", "replace")
	data, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activePath, append(data, []byte(`{"truncated"}`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := history.MigrateLegacyTask(context.Background(), legacyPath, "replace", legacy); err == nil {
		t.Fatal("truncated active stream was accepted as idempotent")
	}
	if _, err := os.Stat(legacyPath); err != nil {
		t.Fatalf("legacy fallback lost after truncated active: %v", err)
	}

	// A complete, hash-valid envelope that does not semantically replay is also
	// rejected before any replacement/cleanup can proceed.
	bad := models.HistoryRecord{EntityType: "task", EntityID: "replace", Checkpoint: true, CheckpointPayload: map[string]any{"title": "bad"}, NewHash: "not-the-payload-hash", Legacy: true, LegacyPath: legacyPath, LegacyDigest: legacyBytesDigest(data)}
	badData, _, err := marshalReplacementRecords([]models.HistoryRecord{bad}, "task", "replace")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(activePath, badData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := history.MigrateLegacyTask(context.Background(), legacyPath, "replace", legacy); err == nil {
		t.Fatal("semantically corrupt active stream was accepted")
	}
}

func TestCompactionExistingActiveFailureKeepsOldHeadReadable(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	base := NewHistoryStore(root)
	previous := ""
	for i := 0; i < 4; i++ {
		state := map[string]any{"title": string(rune('a' + i))}
		hash := taskCanonicalHash(state)
		record := models.HistoryRecord{EntityType: "task", EntityID: "active-rollback", BaseHash: previous, NewHash: hash, Checkpoint: true, CheckpointPayload: state, Timestamp: time.Unix(int64(i), 0).UTC()}
		if err := base.Append(context.Background(), record); err != nil {
			t.Fatal(err)
		}
		previous = hash
	}
	activePath := base.EntityPath("task", "active-rollback")
	before, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	failing := NewHistoryStore(root, HistoryStoreOptions{SyncDirectory: func(string) error {
		calls++
		if calls >= 3 { // staging dir, durable backup dir, post-rename dir
			return errors.New("injected post-rename sync")
		}
		return nil
	}})
	if err := failing.Compact(context.Background(), "task", "active-rollback", HistoryRetentionPolicy{MaxDetailedRevisions: 1, MaxDetailedAge: time.Hour, Now: time.Unix(10, 0).UTC()}); err == nil {
		t.Fatal("expected post-rename directory sync failure")
	}
	after, err := os.ReadFile(activePath)
	if err != nil || string(after) != string(before) {
		t.Fatalf("old active head not restored: err=%v equal=%v", err, string(after) == string(before))
	}
	if _, err := base.Read(context.Background(), "task", "active-rollback"); err != nil {
		t.Fatalf("restored active head is unreadable: %v", err)
	}
}

func TestLegacyTaskMigrationPreservesVersionMetadata(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	timestamp := time.Unix(123, 0).UTC()
	legacyPath := store.Versions.versionPath("taskmeta")
	legacy := &models.TaskVersionHistory{TaskID: "taskmeta", CurrentVersion: 7, Versions: []models.TaskVersion{{ID: "v7", TaskID: "taskmeta", Version: 7, Timestamp: timestamp, Author: "alice", LifecycleEventID: "life-1", Source: "mcp", SessionID: "session-1", BatchID: "batch-1", Snapshot: map[string]any{"title": "old"}}}}
	if err := writeJSON(legacyPath, legacy); err != nil {
		t.Fatal(err)
	}
	if err := store.Versions.MigrateLegacyTaskHistory(context.Background(), "taskmeta"); err != nil {
		t.Fatal(err)
	}
	h, err := store.Versions.GetHistory("taskmeta")
	if err != nil {
		t.Fatal(err)
	}
	if h.CurrentVersion != 7 || len(h.Versions) != 1 || h.Versions[0].Version != 7 || h.Versions[0].Timestamp != timestamp || h.Versions[0].Author != "alice" || h.Versions[0].LifecycleEventID != "life-1" || h.Versions[0].Source != "mcp" || h.Versions[0].SessionID != "session-1" || h.Versions[0].BatchID != "batch-1" {
		t.Fatalf("history=%#v", h)
	}
	if err := store.Versions.SaveVersion("taskmeta", models.TaskVersion{Snapshot: map[string]any{"title": "next"}, Changes: []models.TaskChange{{Field: "title", OldValue: "old", NewValue: "next"}}}); err != nil {
		t.Fatal(err)
	}
	h, err = store.Versions.GetHistory("taskmeta")
	if err != nil {
		t.Fatal(err)
	}
	if h.CurrentVersion != 8 || len(h.Versions) != 2 || h.Versions[1].Version != 8 || h.Versions[1].ID != "v8" {
		t.Fatalf("continued logical history=%#v", h)
	}
}

func TestLegacyMigrationFailuresLeaveLegacyAuthoritative(t *testing.T) {
	for name, opts := range map[string]HistoryStoreOptions{
		"append":   {Append: func(*os.File, []byte) (int, error) { return 0, errors.New("injected append") }},
		"sync":     {Sync: func(*os.File) error { return errors.New("injected fsync") }},
		"validate": {Validate: func([]models.HistoryRecord) error { return errors.New("injected validation") }},
		"rename":   {Rename: func(string, string) error { return errors.New("injected swap") }},
	} {
		t.Run(name, func(t *testing.T) {
			root := filepath.Join(t.TempDir(), ".knowns")
			store := NewStore(root)
			legacyPath := store.Versions.versionPath("failure")
			if err := writeJSON(legacyPath, &models.TaskVersionHistory{TaskID: "failure", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "legacy"}}}}); err != nil {
				t.Fatal(err)
			}
			store.Versions.history = NewHistoryStore(root, opts)
			if err := store.Versions.MigrateLegacyTaskHistory(context.Background(), "failure"); err == nil {
				t.Fatal("expected injected failure")
			}
			if _, err := os.Stat(store.Versions.historyStore().EntityPath("task", "failure")); !os.IsNotExist(err) {
				t.Fatal("failed migration activated JSONL")
			}
			if _, err := os.Stat(legacyPath); err != nil {
				t.Fatal("legacy fallback was lost")
			}
		})
	}
}

func TestLegacyMigrationPostRenameDirectoryFailureRollsBackAndRetries(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	legacyPath := store.Versions.versionPath("postdir")
	if err := writeJSON(legacyPath, &models.TaskVersionHistory{TaskID: "postdir", Versions: []models.TaskVersion{{Version: 1, Snapshot: map[string]any{"title": "legacy"}}}}); err != nil {
		t.Fatal(err)
	}
	calls := 0
	store.Versions.history = NewHistoryStore(root, HistoryStoreOptions{SyncDirectory: func(string) error {
		calls++
		if calls >= 2 {
			return errors.New("injected post-rename directory sync")
		}
		return nil
	}})
	if err := store.Versions.MigrateLegacyTaskHistory(context.Background(), "postdir"); err == nil {
		t.Fatal("expected post-rename failure")
	}
	if _, err := os.Stat(store.Versions.historyStore().EntityPath("task", "postdir")); !os.IsNotExist(err) {
		t.Fatal("rollback left active JSONL")
	}
	store.Versions.history = NewHistoryStore(root)
	if err := store.Versions.MigrateLegacyTaskHistory(context.Background(), "postdir"); err != nil {
		t.Fatal("retry migration: ", err)
	}
	if _, err := os.Stat(store.Versions.historyStore().EntityPath("task", "postdir")); err != nil {
		t.Fatal("retry did not activate JSONL: ", err)
	}
}
