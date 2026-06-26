package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

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
	if _, err := os.Stat(store.Versions.stableDocVersionPath(history.DocID)); err != nil {
		t.Fatalf("expected stable doc history file: %v", err)
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
	if version.Checkpoint {
		t.Fatal("content update should not be marked as a checkpoint")
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
	if _, err := os.Stat(store.Versions.stableDocVersionPath(history.DocID)); err != nil {
		t.Fatalf("expected migrated stable history file: %v", err)
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
	setDocHistoryTimestamps(t, store, doc.Path, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	history, err := store.Versions.ApplyDocHistoryRetention(doc.Path, DocHistoryRetentionPolicy{MaxVersions: 3, Now: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)})
	if err != nil {
		t.Fatalf("apply retention: %v", err)
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
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	setDocHistoryTimestamps(t, store, doc.Path, base)

	history, err := store.Versions.ApplyDocHistoryRetention(doc.Path, DocHistoryRetentionPolicy{
		MaxAge: 48 * time.Hour,
		Now:    base.Add(96 * time.Hour),
	})
	if err != nil {
		t.Fatalf("apply max-age retention: %v", err)
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
