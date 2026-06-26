package handlers

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestHandleDocUpdateRecordsMCPSectionHistoryMetadata(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-mcp-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	if _, err := handleDocCreate(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"title":   "MCP Section",
			"content": "## One\nold one\n\n## Two\nsame two",
		}},
	}); err != nil {
		t.Fatalf("handleDocCreate: %v", err)
	}

	if _, err := handleDocUpdate(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"path":    "mcp-section",
			"section": "One",
			"content": "## One\nnew one",
		}},
	}); err != nil {
		t.Fatalf("handleDocUpdate: %v", err)
	}

	history, err := store.Versions.GetDocHistory("mcp-section")
	if err != nil {
		t.Fatalf("get doc history: %v", err)
	}
	if len(history.Versions) != 2 {
		t.Fatalf("history versions = %d, want 2", len(history.Versions))
	}

	version := history.Versions[1]
	if version.Actor != "mcp" || version.Author != "mcp" || version.Source != "mcp" {
		t.Fatalf("actor/source = (%q, %q, %q), want mcp metadata", version.Actor, version.Author, version.Source)
	}
	if _, ok := version.Snapshot["content"]; ok {
		t.Fatalf("section update stored full content snapshot: %#v", version.Snapshot["content"])
	}
	if len(version.ChangedScopes) != 1 || version.ChangedScopes[0].Type != "section" || version.ChangedScopes[0].Section != "One" {
		t.Fatalf("changed scopes = %#v, want section One", version.ChangedScopes)
	}
}

func TestHandleDocGetHistoryAndDiffExposeStructuredMetadata(t *testing.T) {
	store := setupDocHandlerHistoryStore(t)

	getResult, err := handleDocGet(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"path":           "mcp-history",
			"includeHistory": true,
		}},
	})
	if err != nil {
		t.Fatalf("handleDocGet: %v", err)
	}
	var getPayload struct {
		Doc     models.Doc               `json:"doc"`
		History models.DocVersionHistory `json:"history"`
	}
	unmarshalDocToolResult(t, getResult, &getPayload)
	if getPayload.Doc.Path != "mcp-history" || len(getPayload.History.Versions) != 2 {
		t.Fatalf("get payload = %#v", getPayload)
	}
	if got := getPayload.History.Versions[1].ChangedScopes[0].Section; got != "One" {
		t.Fatalf("history section scope = %q, want One", got)
	}

	diffResult, err := handleDocDiff(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"path":     "mcp-history",
			"revision": "v2",
		}},
	})
	if err != nil {
		t.Fatalf("handleDocDiff: %v", err)
	}
	var diff models.DocRevisionDiff
	unmarshalDocToolResult(t, diffResult, &diff)
	if diff.RevisionID != "v2" || diff.PreviousRevisionID != "v1" {
		t.Fatalf("diff revision IDs = (%q, %q), want (v2, v1)", diff.RevisionID, diff.PreviousRevisionID)
	}
	if len(diff.ChangedScopes) != 1 || diff.ChangedScopes[0].Section != "One" {
		t.Fatalf("diff changed scopes = %#v, want section One", diff.ChangedScopes)
	}
}

func TestHandleDocRestoreSectionRecordsRestoreRevision(t *testing.T) {
	store := setupDocHandlerHistoryStore(t)

	result, err := handleDocRestore(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"path":     "mcp-history",
			"revision": "v1",
			"mode":     "section",
			"section":  "One",
		}},
	})
	if err != nil {
		t.Fatalf("handleDocRestore: %v", err)
	}
	var payload struct {
		Restored bool                     `json:"restored"`
		Doc      models.Doc               `json:"doc"`
		History  models.DocVersionHistory `json:"history"`
	}
	unmarshalDocToolResult(t, result, &payload)
	if !payload.Restored || payload.Doc.Content != "## One\nold one\n\n## Two\nsame two" {
		t.Fatalf("restore payload = restored %v content %q", payload.Restored, payload.Doc.Content)
	}
	if len(payload.History.Versions) != 3 || payload.History.Versions[2].Source != "mcp" {
		t.Fatalf("restore history = %#v", payload.History.Versions)
	}
}

func setupDocHandlerHistoryStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doc-mcp-history-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	if _, err := handleDocCreate(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"title":   "MCP History",
			"content": "## One\nold one\n\n## Two\nsame two",
		}},
	}); err != nil {
		t.Fatalf("handleDocCreate: %v", err)
	}
	if _, err := handleDocUpdate(func() *storage.Store { return store }, mcp.CallToolRequest{
		Params: mcp.CallToolParams{Arguments: map[string]any{
			"path":    "mcp-history",
			"section": "One",
			"content": "## One\nnew one",
		}},
	}); err != nil {
		t.Fatalf("handleDocUpdate: %v", err)
	}
	return store
}

func unmarshalDocToolResult(t *testing.T, result *mcp.CallToolResult, target any) {
	t.Helper()
	if result == nil || len(result.Content) != 1 {
		t.Fatalf("unexpected result content: %#v", result)
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("unexpected result content type: %T", result.Content[0])
	}
	if err := json.Unmarshal([]byte(text.Text), target); err != nil {
		t.Fatalf("unmarshal tool result: %v\n%s", err, text.Text)
	}
}
