package storage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestVersionStoreHistoryMetadataPageNewestFirstAndRootIdentity(t *testing.T) {
	store := newVersionTestStore(t)
	history := store.Versions.historyStore()
	state := map[string]any{"title": "one"}
	hash := taskCanonicalHash(state)
	for i := 1; i <= 3; i++ {
		record := models.HistoryRecord{EntityType: "task", EntityID: "page-task", Checkpoint: i == 1, CheckpointPayload: cloneMapIf(i == 1, state), BaseHash: func() string {
			if i == 1 {
				return ""
			}
			return hash
		}(), NewHash: hash}
		if i > 1 {
			next := map[string]any{"title": string(rune('a' + i))}
			record.TaskChanges = []models.TaskChange{{Field: "title", OldValue: state["title"], NewValue: next["title"]}}
			record.NewHash = taskCanonicalHash(next)
			state, hash = next, record.NewHash
		}
		if err := history.Append(context.Background(), record); err != nil {
			t.Fatal(err)
		}
	}
	page, err := store.Versions.ListTaskHistoryMetadata("page-task", 0, 2)
	if err != nil {
		t.Fatal(err)
	}
	if page.EntityType != "task" || page.EntityID != "page-task" || page.CurrentVersion != 3 || len(page.Items) != 2 || page.Items[0].ID != "v3" || page.Items[1].ID != "v2" || !page.HasMore || page.NextOffset == nil || *page.NextOffset != 2 {
		t.Fatalf("metadata page = %#v", page)
	}
	if page.Items[0].NewHash == "" || page.Items[0].ID == "" {
		t.Fatalf("metadata missing identity/hash: %#v", page.Items[0])
	}
}

func TestVersionStoreHistorySurfacesTruncatedTailWithoutExposingRevision(t *testing.T) {
	store := newVersionTestStore(t)
	history := store.Versions.historyStore()
	ctx := context.Background()
	first := map[string]any{"title": "one"}
	firstHash := taskCanonicalHash(first)
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "tail-public", Checkpoint: true, NewHash: firstHash, CheckpointPayload: first}); err != nil {
		t.Fatal(err)
	}
	second := map[string]any{"title": "two"}
	if err := history.Append(ctx, models.HistoryRecord{EntityType: "task", EntityID: "tail-public", BaseHash: firstHash, NewHash: taskCanonicalHash(second), TaskChanges: []models.TaskChange{{Field: "title", OldValue: "one", NewValue: "two"}}}); err != nil {
		t.Fatal(err)
	}
	path := history.EntityPath("task", "tail-public")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data[:len(data)-1], 0o600); err != nil {
		t.Fatal(err)
	}
	full, err := store.Versions.GetHistory("tail-public")
	if err != nil {
		t.Fatal(err)
	}
	if !full.TailTruncated || full.CurrentVersion != 1 || len(full.Versions) != 1 {
		t.Fatalf("full history = %#v, want one durable revision plus tail warning", full)
	}
	page, err := store.Versions.ListTaskHistoryMetadata("tail-public", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if !page.TailTruncated || page.CurrentVersion != 1 || len(page.Items) != 1 {
		t.Fatalf("metadata page = %#v, want one durable revision plus tail warning", page)
	}
	if _, err := store.Versions.GetTaskRevisionDetail("tail-public", "v2"); err == nil {
		t.Fatal("truncated revision detail was exposed")
	}
}

func TestSaveDocRevisionCreateCheckpointMetadata(t *testing.T) {
	store := newVersionTestStore(t)
	now := time.Now().UTC()
	doc := &models.Doc{
		Path:        "guides/intro",
		Title:       "Intro",
		Description: "Getting started",
		Content:     "Welcome",
		Tags:        []string{"guide"},
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save doc revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get doc history: %v", err)
	}
	if history.DocID == "" {
		t.Fatal("expected stable doc ID")
	}
	if history.DocPath != doc.Path || history.CurrentPath != doc.Path {
		t.Fatalf("history path = (%q, %q), want %q", history.DocPath, history.CurrentPath, doc.Path)
	}
	if history.CurrentVersion != 1 || len(history.Versions) != 1 {
		t.Fatalf("history version count = (%d, %d), want (1, 1)", history.CurrentVersion, len(history.Versions))
	}

	version := history.Versions[0]
	if version.DocID != history.DocID {
		t.Fatalf("version doc ID = %q, want %q", version.DocID, history.DocID)
	}
	if !version.Checkpoint {
		t.Fatal("expected creation revision to be a checkpoint")
	}
	if version.BaseHash != "" || version.NewHash == "" {
		t.Fatalf("creation hashes = (%q, %q), want empty base and non-empty new", version.BaseHash, version.NewHash)
	}
	if version.Timestamp.IsZero() {
		t.Fatal("expected revision timestamp")
	}
	if got := version.Snapshot["path"]; got != doc.Path {
		t.Fatalf("snapshot path = %v, want %q", got, doc.Path)
	}
	if got := version.Snapshot["content"]; got != doc.Content {
		t.Fatalf("snapshot content = %v, want %q", got, doc.Content)
	}
	if !hasDocChange(version.Changes, "path") {
		t.Fatal("expected creation changes to include path")
	}
	if !hasDocScope(version.ChangedScopes, "whole_doc", "content") {
		t.Fatal("expected creation changed scope to include whole document content")
	}
	if _, err := os.Stat(store.Versions.historyStore().EntityPath("doc", history.DocID)); err != nil {
		t.Fatalf("expected JSONL doc history file: %v", err)
	}
}

func TestVersionStoreSelectsOneHistoryBackendPerEntity(t *testing.T) {
	store := newVersionTestStore(t)
	task := &models.Task{ID: "jsonl01", Title: "JSONL", Status: "todo", Priority: "medium"}
	if err := store.Versions.SaveVersion(task.ID, models.TaskVersion{Snapshot: TaskToSnapshot(task)}); err != nil {
		t.Fatal(err)
	}
	if !fileExists(store.Versions.historyStore().EntityPath("task", task.ID)) || fileExists(store.Versions.versionPath(task.ID)) {
		t.Fatal("new Task history was not JSONL-only")
	}

	doc := &models.Doc{Path: "guides/jsonl", Title: "JSONL", Content: "body"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatal(err)
	}
	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !fileExists(store.Versions.historyStore().EntityPath("doc", history.DocID)) || fileExists(store.Versions.stableDocVersionPath(history.DocID)) {
		t.Fatal("new Doc history was not JSONL-only")
	}

	legacyTask := &models.TaskVersionHistory{TaskID: "legacy01", CurrentVersion: 1, Versions: []models.TaskVersion{{ID: "v1", TaskID: "legacy01", Version: 1, Snapshot: map[string]any{"title": "legacy"}}}}
	if err := writeJSON(store.Versions.versionPath("legacy01"), legacyTask); err != nil {
		t.Fatal(err)
	}
	legacyBefore, err := os.ReadFile(store.Versions.versionPath("legacy01"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Versions.SaveVersion("legacy01", models.TaskVersion{Snapshot: map[string]any{"title": "legacy2"}, Changes: []models.TaskChange{{Field: "title", OldValue: "legacy", NewValue: "legacy2"}}}); err != nil {
		t.Fatal(err)
	}
	if !fileExists(store.Versions.historyStore().EntityPath("task", "legacy01")) {
		t.Fatal("legacy Task migration did not create JSONL successor")
	}
	legacyAfter, err := os.ReadFile(store.Versions.versionPath("legacy01"))
	if err != nil || string(legacyBefore) != string(legacyAfter) {
		t.Fatal("legacy Task JSON changed before explicit cleanup")
	}
	taskHistory, err := store.Versions.GetHistory("legacy01")
	if err != nil || len(taskHistory.Versions) != 2 || taskHistory.Versions[0].Version != 1 || taskHistory.Versions[1].Version != 2 || taskHistory.Versions[1].Snapshot["title"] != "legacy2" {
		t.Fatalf("migrated Task history=%#v err=%v", taskHistory, err)
	}
}

func TestSaveDocRevisionWholeContentUpdateMetadataNoAudit(t *testing.T) {
	store := newVersionTestStore(t)
	createdAt := time.Now().UTC()
	doc := &models.Doc{
		Path:      "guides/update",
		Title:     "Update",
		Content:   "before",
		CreatedAt: createdAt,
		UpdatedAt: createdAt,
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}

	oldDoc := *doc
	doc.Content = "after"
	doc.UpdatedAt = time.Now().UTC()
	if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
		t.Fatalf("save update revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get doc history: %v", err)
	}
	if len(history.Versions) != 2 {
		t.Fatalf("history versions = %d, want 2", len(history.Versions))
	}

	version := history.Versions[1]
	if !version.Checkpoint {
		t.Fatal("content update should be checkpointed when delta is at least full snapshot")
	}
	if version.BaseHash == "" || version.NewHash == "" || version.BaseHash == version.NewHash {
		t.Fatalf("update hashes = (%q, %q), want distinct non-empty hashes", version.BaseHash, version.NewHash)
	}
	if !hasDocScope(version.ChangedScopes, "whole_doc", "content") {
		t.Fatalf("changed scopes = %#v, want whole_doc content scope", version.ChangedScopes)
	}
	change := findDocChange(version.Changes, "content")
	if change == nil {
		t.Fatal("expected content change")
	}
	if change.OldValue != "before" || change.NewValue != "after" {
		t.Fatalf("content change = (%v, %v), want (before, after)", change.OldValue, change.NewValue)
	}
	if got := version.Snapshot["content"]; got != "after" {
		t.Fatalf("snapshot content = %v, want after", got)
	}
}

func TestSaveDocVersionDeltaReplaysClearedDocFields(t *testing.T) {
	store := newVersionTestStore(t)
	path := "guides/clear-delta"
	initial := &models.Doc{Path: path, Title: "Clear", Description: "long description", Content: "long content", Tags: []string{"one", "two"}}
	if err := store.Versions.SaveDocRevision(nil, initial); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}
	cleared := &models.Doc{Path: path, Title: initial.Title}
	if err := store.Versions.SaveDocVersion(path, models.DocVersion{
		BaseHash: hashDoc(initial), NewHash: hashDoc(cleared), CurrentPath: path,
		Changes: []models.DocChange{
			{Field: "description", OldValue: initial.Description},
			{Field: "content", OldValue: initial.Content},
			{Field: "tags", OldValue: initial.Tags},
		},
		ChangedScopes: []models.DocChangeScope{{Type: "whole_doc", Field: "content"}},
	}); err != nil {
		t.Fatalf("save clearing delta: %v", err)
	}
	history, err := store.Versions.GetDocHistory(path)
	if err != nil {
		t.Fatalf("get history: %v", err)
	}
	if len(history.Versions) != 2 || history.Versions[1].Checkpoint {
		t.Fatalf("history = %#v, want second delta", history.Versions)
	}
	version := history.Versions[1]
	if version.Snapshot["description"] != nil || version.Snapshot["content"] != nil || version.Snapshot["tags"] != nil {
		t.Fatalf("cleared snapshot retained fields: %#v", version.Snapshot)
	}
	if got, want := hashSnapshot(version.Snapshot), hashDoc(cleared); got != want || version.NewHash != want {
		t.Fatalf("cleared hashes = snapshot %q new %q, want %q", got, version.NewHash, want)
	}
}

func TestSaveDocRevisionCheckpointAfterClearsIsStandalone(t *testing.T) {
	store := newVersionTestStore(t)
	path := "guides/clear-checkpoint"
	doc := &models.Doc{Path: path, Title: "Checkpoint", Description: strings.Repeat("description ", 12), Content: strings.Repeat("content ", 30), Tags: []string{"one", "two", "three"}}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}
	oldDoc := *doc
	doc.Description, doc.Content, doc.Tags = "", "", nil
	if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
		t.Fatalf("save clearing checkpoint: %v", err)
	}
	history, err := store.Versions.GetDocHistory(path)
	if err != nil || len(history.Versions) != 2 || !history.Versions[1].Checkpoint {
		t.Fatalf("history = %#v err=%v, want inefficient checkpoint", history, err)
	}
	stream, err := store.Versions.historyStore().Read(nil, "doc", history.DocID)
	if err != nil || len(stream.Records) != 2 {
		t.Fatalf("read stream = %#v err=%v", stream, err)
	}
	standalone, err := docHistoryFromRecords(path, []models.HistoryRecord{stream.Records[1]})
	if err != nil || len(standalone.Versions) != 1 {
		t.Fatalf("standalone replay = %#v err=%v", standalone, err)
	}
	if got, want := hashSnapshot(standalone.Versions[0].Snapshot), hashDoc(doc); got != want || standalone.Versions[0].NewHash != want {
		t.Fatalf("standalone hashes = snapshot %q new %q, want %q", got, standalone.Versions[0].NewHash, want)
	}
	if standalone.Versions[0].Snapshot["description"] != nil || standalone.Versions[0].Snapshot["content"] != nil || standalone.Versions[0].Snapshot["tags"] != nil {
		t.Fatalf("standalone checkpoint retained cleared fields: %#v", standalone.Versions[0].Snapshot)
	}
}

func TestSaveDocVersionRejectsIncompleteCheckpoint(t *testing.T) {
	store := newVersionTestStore(t)
	err := store.Versions.SaveDocVersion("guides/incomplete", models.DocVersion{Checkpoint: true, NewHash: "hash"})
	if !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("incomplete checkpoint error=%v, want ErrHistoryCorrupt", err)
	}
}

func TestSaveDocVersionRejectsMismatchedCandidateHashBeforeAppend(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/hash-guard", Title: "Before", Content: "body"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}
	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get history: %v", err)
	}
	streamBefore, err := store.Versions.historyStore().Read(nil, "doc", history.DocID)
	if err != nil {
		t.Fatalf("read stream before: %v", err)
	}
	updated := *doc
	updated.Title = "After"
	err = store.Versions.SaveDocVersion(doc.Path, models.DocVersion{
		BaseHash: hashDoc(doc), NewHash: "caller-supplied-wrong-hash", CurrentPath: doc.Path,
		Changes: []models.DocChange{{Field: "title", OldValue: doc.Title, NewValue: updated.Title}},
	})
	if !errors.Is(err, ErrHistoryCorrupt) {
		t.Fatalf("mismatched candidate error=%v, want ErrHistoryCorrupt", err)
	}
	streamAfter, readErr := store.Versions.historyStore().Read(nil, "doc", history.DocID)
	if readErr != nil || len(streamAfter.Records) != len(streamBefore.Records) {
		t.Fatalf("stream after rejected append = %#v err=%v, want unchanged count %d", streamAfter, readErr, len(streamBefore.Records))
	}
}

func TestSaveDocRevisionRejectsStaleOldDocBeforeAppend(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/stale", Title: "Current", Content: "body"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}
	historyBefore, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	stale := *doc
	stale.Title = "Observed stale state"
	candidate := stale
	candidate.Content = "new body"
	err = store.Versions.SaveDocRevisionWithOptions(&stale, &candidate, DocRevisionOptions{})
	if !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("stale save error=%v, want ErrHistoryConflict", err)
	}
	historyAfter, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(historyAfter.Versions) != len(historyBefore.Versions) {
		t.Fatalf("history count=%d, want unchanged %d", len(historyAfter.Versions), len(historyBefore.Versions))
	}
}

func TestSaveDocRevisionRejectsNilOldDocForExistingHistory(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/nil-old", Title: "Current", Content: "body"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save initial revision: %v", err)
	}
	err := store.Versions.SaveDocRevisionWithOptions(nil, &models.Doc{Path: doc.Path, Title: "Replacement", Content: "new"}, DocRevisionOptions{})
	if !errors.Is(err, ErrHistoryConflict) {
		t.Fatalf("nil old save error=%v, want ErrHistoryConflict", err)
	}
	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Versions) != 1 {
		t.Fatalf("history count=%d, want 1", len(history.Versions))
	}
}

func TestSaveDocRevisionSeedsCheckpointWhenCanonicalDocHasNoHistory(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/untracked", Title: "Existing", Content: "body"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create canonical doc: %v", err)
	}
	oldDoc, err := store.Docs.Get(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	candidate := *oldDoc
	candidate.Content = "updated body"
	if err := store.Versions.SaveDocRevisionWithOptions(oldDoc, &candidate, DocRevisionOptions{}); err != nil {
		t.Fatalf("seed first checkpoint: %v", err)
	}
	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(history.Versions) != 1 || !history.Versions[0].Checkpoint {
		t.Fatalf("history=%#v, want one checkpoint", history.Versions)
	}
	if history.Versions[0].BaseHash != "" || history.Versions[0].Snapshot["content"] != candidate.Content {
		t.Fatalf("first checkpoint base/snapshot=(%q,%#v), want empty base and updated content", history.Versions[0].BaseHash, history.Versions[0].Snapshot)
	}
}

func TestSaveDocRevisionExplicitSectionDoesNotStoreFullBody(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{
		Path:    "guides/section",
		Title:   "Section",
		Content: "## One\nold one\n\n## Two\nsame two",
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}

	oldDoc := *doc
	doc.Content = "## One\nnew one\n\n## Two\nsame two"
	if err := store.Versions.SaveDocRevisionWithOptions(&oldDoc, doc, DocRevisionOptions{
		Section:      "One",
		Actor:        "cli",
		Source:       "cli",
		AuditEventID: "audit-123",
		SessionID:    "session-456",
	}); err != nil {
		t.Fatalf("save section revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get doc history: %v", err)
	}
	version := history.Versions[1]
	if version.Actor != "cli" || version.Author != "cli" || version.Source != "cli" {
		t.Fatalf("actor/source = (%q, %q, %q), want cli metadata", version.Actor, version.Author, version.Source)
	}
	if version.AuditEventID != "audit-123" || version.SessionID != "session-456" {
		t.Fatalf("audit link = (%q, %q), want supplied audit/session IDs", version.AuditEventID, version.SessionID)
	}
	if _, ok := version.Snapshot["content"]; ok {
		t.Fatalf("section revision snapshot stored full content: %#v", version.Snapshot["content"])
	}
	change := findDocChange(version.Changes, "content")
	if change == nil {
		t.Fatal("expected content change")
	}
	if change.OldValue != "## One\nold one" || change.NewValue != "## One\nnew one" {
		t.Fatalf("section change = (%q, %q), want only changed section", change.OldValue, change.NewValue)
	}
	if !hasDocSectionScope(version.ChangedScopes, "One") {
		t.Fatalf("changed scopes = %#v, want section One", version.ChangedScopes)
	}
}

func TestSaveDocRevisionInfersSingleChangedSection(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{
		Path:    "guides/infer-section",
		Title:   "Infer",
		Content: "## One\nsame one\n\n## Two\nold two",
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}

	oldDoc := *doc
	doc.Content = "## One\nsame one\n\n## Two\nnew two"
	if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
		t.Fatalf("save inferred section revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get doc history: %v", err)
	}
	version := history.Versions[1]
	if _, ok := version.Snapshot["content"]; ok {
		t.Fatal("inferred section revision should not store full content snapshot")
	}
	change := findDocChange(version.Changes, "content")
	if change == nil {
		t.Fatal("expected content change")
	}
	if change.OldValue != "## Two\nold two" || change.NewValue != "## Two\nnew two" {
		t.Fatalf("inferred section change = (%q, %q), want only changed section", change.OldValue, change.NewValue)
	}
	if !hasDocSectionScope(version.ChangedScopes, "Two") {
		t.Fatalf("changed scopes = %#v, want section Two", version.ChangedScopes)
	}
}

func TestSaveDocRevisionRenamePreservesStableHistory(t *testing.T) {
	store := newVersionTestStore(t)
	now := time.Now().UTC()
	doc := &models.Doc{
		Path:      "guides/old",
		Title:     "Guide",
		Content:   "body",
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}
	beforeRename, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get pre-rename history: %v", err)
	}

	oldDoc := *doc
	doc.Path = "guides/new"
	doc.UpdatedAt = time.Now().UTC()
	if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
		t.Fatalf("save rename revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get renamed history: %v", err)
	}
	if history.DocID != beforeRename.DocID {
		t.Fatalf("doc ID after rename = %q, want %q", history.DocID, beforeRename.DocID)
	}
	if history.CurrentPath != doc.Path || history.DocPath != doc.Path {
		t.Fatalf("current path = (%q, %q), want %q", history.CurrentPath, history.DocPath, doc.Path)
	}
	if len(history.Versions) != 2 {
		t.Fatalf("history versions = %d, want 2", len(history.Versions))
	}

	version := history.Versions[1]
	if version.PreviousPath != oldDoc.Path || version.CurrentPath != doc.Path {
		t.Fatalf("path change = %q -> %q, want %q -> %q", version.PreviousPath, version.CurrentPath, oldDoc.Path, doc.Path)
	}
	change := findDocChange(version.Changes, "path")
	if change == nil {
		t.Fatal("expected path change")
	}
	if change.OldValue != oldDoc.Path || change.NewValue != doc.Path {
		t.Fatalf("path change values = (%v, %v), want (%q, %q)", change.OldValue, change.NewValue, oldDoc.Path, doc.Path)
	}
	if !hasDocScope(version.ChangedScopes, "path", "path") {
		t.Fatalf("changed scopes = %#v, want path scope", version.ChangedScopes)
	}

	oldPathHistory, err := store.Versions.GetDocHistory(oldDoc.Path)
	if err != nil {
		t.Fatalf("get old path history: %v", err)
	}
	if oldPathHistory.DocID != history.DocID || len(oldPathHistory.Versions) != 2 {
		t.Fatalf("old path history doc ID/versions = (%q, %d), want (%q, 2)", oldPathHistory.DocID, len(oldPathHistory.Versions), history.DocID)
	}
}

func TestGetDocHistoryReadsLegacyPathKeyedHistory(t *testing.T) {
	store := newVersionTestStore(t)
	docPath := "legacy/doc"
	legacy := models.DocVersionHistory{
		DocPath:        docPath,
		CurrentVersion: 1,
		Versions: []models.DocVersion{
			{
				ID:        "v1",
				DocPath:   docPath,
				Version:   1,
				Timestamp: time.Now().UTC(),
				Changes: []models.DocChange{
					{Field: "title", NewValue: "Legacy"},
				},
				Snapshot: map[string]any{
					"title":   "Legacy",
					"content": "old body",
				},
			},
		},
	}
	if err := writeJSON(store.Versions.legacyDocVersionPath(docPath), legacy); err != nil {
		t.Fatalf("write legacy history: %v", err)
	}
	history, err := store.Versions.GetDocHistory(docPath)
	if err != nil {
		t.Fatalf("get legacy history: %v", err)
	}
	if history.DocID == "" {
		t.Fatal("expected compatibility doc ID for legacy history")
	}
	if history.DocPath != docPath || history.CurrentPath != docPath {
		t.Fatalf("legacy history path = (%q, %q), want %q", history.DocPath, history.CurrentPath, docPath)
	}
	if len(history.Versions) != 1 {
		t.Fatalf("legacy versions = %d, want 1", len(history.Versions))
	}
	version := history.Versions[0]
	if version.DocID != history.DocID {
		t.Fatalf("legacy version doc ID = %q, want %q", version.DocID, history.DocID)
	}
	if got := version.Snapshot["content"]; got != "old body" {
		t.Fatalf("legacy snapshot content = %v, want old body", got)
	}
	if !hasDocScope(version.ChangedScopes, "field", "title") {
		t.Fatalf("legacy changed scopes = %#v, want title field scope", version.ChangedScopes)
	}
}

func TestSaveDocRevisionMigratesLegacyHistoryWithoutLoss(t *testing.T) {
	store := newVersionTestStore(t)
	docPath := "legacy/migrate"
	legacy := models.DocVersionHistory{
		DocPath:        docPath,
		CurrentVersion: 1,
		Versions: []models.DocVersion{
			{
				ID:        "v1",
				DocPath:   docPath,
				Version:   1,
				Timestamp: time.Now().UTC(),
				Changes: []models.DocChange{
					{Field: "content", NewValue: "old"},
				},
				Snapshot: map[string]any{
					"title":   "Legacy",
					"content": "old",
				},
			},
		},
	}
	if err := writeJSON(store.Versions.legacyDocVersionPath(docPath), legacy); err != nil {
		t.Fatalf("write legacy history: %v", err)
	}
	legacyBefore, err := os.ReadFile(store.Versions.legacyDocVersionPath(docPath))
	if err != nil {
		t.Fatal(err)
	}

	oldDoc := &models.Doc{Path: docPath, Title: "Legacy", Content: "old"}
	newDoc := &models.Doc{Path: docPath, Title: "Legacy", Content: "new"}
	if err := store.Versions.SaveDocRevision(oldDoc, newDoc); err != nil {
		t.Fatalf("save migrated revision: %v", err)
	}

	history, err := store.Versions.GetDocHistory(docPath)
	if err != nil {
		t.Fatalf("get migrated history: %v", err)
	}
	if len(history.Versions) != 2 {
		t.Fatalf("migrated versions = %d, want 2", len(history.Versions))
	}
	if got := history.Versions[0].Snapshot["content"]; got != "old" {
		t.Fatalf("first migrated snapshot content = %v, want old", got)
	}
	if got := history.Versions[1].Snapshot["content"]; got != "new" {
		t.Fatalf("second migrated snapshot content = %v, want new", got)
	}
	if !fileExists(store.Versions.historyStore().EntityPath("doc", history.DocID)) {
		t.Fatal("legacy Doc migration did not create JSONL successor")
	}
	legacyAfter, err := os.ReadFile(store.Versions.legacyDocVersionPath(docPath))
	if err != nil || string(legacyBefore) != string(legacyAfter) {
		t.Fatal("legacy Doc JSON changed before explicit cleanup")
	}
}

func TestRestoreDocSectionUpdatesOnlyTargetSectionAndRecordsRevision(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{
		Path:    "guides/restore-section",
		Title:   "Restore Section",
		Content: "## One\nold one\n\n## Two\nold two",
	}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}

	oldDoc := *doc
	doc.Content = "## One\nchanged one\n\n## Two\ncurrent two"
	if err := store.Docs.Update(doc); err != nil {
		t.Fatalf("update doc: %v", err)
	}
	if err := store.Versions.SaveDocRevisionWithOptions(&oldDoc, doc, DocRevisionOptions{Section: "One"}); err != nil {
		t.Fatalf("save update revision: %v", err)
	}

	restored, err := store.RestoreDocSection(doc.Path, "v1", "One", DocRevisionOptions{Actor: "test", Source: "test"})
	if err != nil {
		t.Fatalf("restore section: %v", err)
	}
	wantContent := "## One\nold one\n\n## Two\ncurrent two"
	if restored.Content != wantContent {
		t.Fatalf("restored content = %q, want %q", restored.Content, wantContent)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get history: %v", err)
	}
	if len(history.Versions) != 3 {
		t.Fatalf("history versions = %d, want 3", len(history.Versions))
	}
	version := history.Versions[2]
	if version.Source != "test" || !hasDocSectionScope(version.ChangedScopes, "One") {
		t.Fatalf("restore revision metadata = source %q scopes %#v", version.Source, version.ChangedScopes)
	}
}

func TestRestoreDocRestoresHistoricalStateAndRecordsRevision(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{
		Path:        "guides/restore-doc",
		Title:       "Original",
		Description: "before",
		Tags:        []string{"old"},
		Content:     "old body",
	}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}

	oldDoc := *doc
	doc.Title = "Changed"
	doc.Description = "after"
	doc.Tags = []string{"new"}
	doc.Content = "new body"
	if err := store.Docs.Update(doc); err != nil {
		t.Fatalf("update doc: %v", err)
	}
	if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
		t.Fatalf("save update revision: %v", err)
	}

	restored, err := store.RestoreDoc(doc.Path, "v1", DocRevisionOptions{Actor: "test", Source: "test"})
	if err != nil {
		t.Fatalf("restore doc: %v", err)
	}
	if restored.Path != doc.Path || restored.Title != "Original" || restored.Description != "before" || restored.Content != "old body" {
		t.Fatalf("restored doc = %#v", restored)
	}
	if len(restored.Tags) != 1 || restored.Tags[0] != "old" {
		t.Fatalf("restored tags = %#v, want [old]", restored.Tags)
	}

	history, err := store.Versions.GetDocHistory(doc.Path)
	if err != nil {
		t.Fatalf("get history: %v", err)
	}
	if len(history.Versions) != 3 || history.Versions[2].Source != "test" {
		t.Fatalf("restore history = versions %d source %q", len(history.Versions), history.Versions[len(history.Versions)-1].Source)
	}
}

func TestApplyDocHistoryRetentionMaxVersionsPreservesCheckpointAndGap(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/retention-count", Title: "Retention", Content: "v1"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}
	for i := 2; i <= 5; i++ {
		oldDoc := *doc
		doc.Content = "v" + string(rune('0'+i))
		if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
			t.Fatalf("save revision %d: %v", i, err)
		}
	}
	history, err := store.Versions.ApplyDocHistoryRetention(doc.Path, DocHistoryRetentionPolicy{MaxVersions: 3, Now: time.Now().UTC()})
	if err != nil {
		t.Fatalf("apply JSONL retention: history=%#v err=%v", history, err)
	}
	if len(history.Versions) != 3 {
		t.Fatalf("retained versions = %d, want 3", len(history.Versions))
	}
	if history.Versions[0].ID != "v3" || !history.Versions[0].Checkpoint {
		t.Fatalf("first retained = %s checkpoint=%v, want v3 checkpoint", history.Versions[0].ID, history.Versions[0].Checkpoint)
	}
	if got := history.Versions[0].Snapshot["content"]; got != "v3" {
		t.Fatalf("compacted checkpoint content = %v, want v3", got)
	}
	if len(history.RetentionGaps) != 1 || history.RetentionGaps[0].Count != 2 || history.RetentionGaps[0].Reason != "max_versions" {
		t.Fatalf("retention gaps = %#v, want count=2 max_versions", history.RetentionGaps)
	}
	state, err := store.Versions.ResolveDocState(doc.Path, "v5")
	if err != nil {
		t.Fatalf("resolve retained latest: %v", err)
	}
	if state.Content != "v5" {
		t.Fatalf("resolved latest content = %q, want v5", state.Content)
	}
}

func TestApplyDocHistoryRetentionMaxAge(t *testing.T) {
	store := newVersionTestStore(t)
	doc := &models.Doc{Path: "guides/retention-age", Title: "Retention", Content: "v1"}
	if err := store.Versions.SaveDocRevision(nil, doc); err != nil {
		t.Fatalf("save create revision: %v", err)
	}
	for i := 2; i <= 4; i++ {
		oldDoc := *doc
		doc.Content = "v" + string(rune('0'+i))
		if err := store.Versions.SaveDocRevision(&oldDoc, doc); err != nil {
			t.Fatalf("save revision %d: %v", i, err)
		}
	}
	now := time.Now().UTC()
	history, err := store.Versions.ApplyDocHistoryRetention(doc.Path, DocHistoryRetentionPolicy{
		MaxAge: 48 * time.Hour,
		Now:    now.Add(96 * time.Hour),
	})
	if err != nil {
		t.Fatalf("apply JSONL age retention: history=%#v err=%v", history, err)
	}
	if len(history.Versions) != 1 {
		t.Fatalf("retained versions = %d, want 1 latest retained checkpoint", len(history.Versions))
	}
	if history.Versions[0].ID != "v4" || !history.Versions[0].Checkpoint {
		t.Fatalf("first retained = %s checkpoint=%v, want v4 checkpoint", history.Versions[0].ID, history.Versions[0].Checkpoint)
	}
	if len(history.RetentionGaps) != 1 || history.RetentionGaps[0].Count != 3 || history.RetentionGaps[0].Reason != "max_age" {
		t.Fatalf("retention gaps = %#v, want count=3 max_age", history.RetentionGaps)
	}
}

func newVersionTestStore(t *testing.T) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	return NewStore(root)
}

func setDocHistoryTimestamps(t *testing.T, store *Store, docPath string, base time.Time) {
	t.Helper()
	history, err := store.Versions.GetDocHistory(docPath)
	if err != nil {
		t.Fatalf("get history for timestamps: %v", err)
	}
	for i := range history.Versions {
		history.Versions[i].Timestamp = base.Add(time.Duration(i) * time.Hour)
	}
	if err := writeJSON(store.Versions.stableDocVersionPath(history.DocID), history); err != nil {
		t.Fatalf("write timestamped history: %v", err)
	}
}

func findDocChange(changes []models.DocChange, field string) *models.DocChange {
	for i := range changes {
		if changes[i].Field == field {
			return &changes[i]
		}
	}
	return nil
}

func hasDocChange(changes []models.DocChange, field string) bool {
	return findDocChange(changes, field) != nil
}

func hasDocScope(scopes []models.DocChangeScope, scopeType, field string) bool {
	for _, scope := range scopes {
		if scope.Type == scopeType && scope.Field == field {
			return true
		}
	}
	return false
}

func hasDocSectionScope(scopes []models.DocChangeScope, section string) bool {
	for _, scope := range scopes {
		if scope.Type == "section" && scope.Field == "content" && scope.Section == section && scope.NewBytes > 0 {
			return true
		}
	}
	return false
}
