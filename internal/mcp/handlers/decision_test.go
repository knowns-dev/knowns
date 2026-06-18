package handlers

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestDecisionHandlersLifecycle(t *testing.T) {
	store := setupDecisionHandlerStore(t)

	draftText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action":   "create",
		"title":    "Draft MCP decision",
		"decision": "Create a draft.",
	})
	var draft models.DecisionEntry
	if err := json.Unmarshal([]byte(draftText), &draft); err != nil {
		t.Fatalf("unmarshal draft: %v\n%s", err, draftText)
	}
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draft.Status)
	}

	acceptedText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action":      "create",
		"title":       "Accepted MCP decision",
		"relatedDocs": []any{"specs/vector"},
	})
	var accepted models.DecisionEntry
	if err := json.Unmarshal([]byte(acceptedText), &accepted); err != nil {
		t.Fatalf("unmarshal accepted: %v\n%s", err, acceptedText)
	}
	if accepted.Status != models.DecisionStatusAccepted {
		t.Fatalf("accepted status = %q, want accepted", accepted.Status)
	}

	duplicateText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action": "create",
		"title":  "Accepted MCP decision",
	})
	var reviewResult decisionreview.Result
	if err := json.Unmarshal([]byte(duplicateText), &reviewResult); err != nil {
		t.Fatalf("unmarshal review: %v\n%s", err, duplicateText)
	}
	if reviewResult.Status != decisionreview.ResultReviewRequired || len(reviewResult.Matches) != 1 {
		t.Fatalf("review result = %+v, want review_required match", reviewResult)
	}
	entriesAfterReview, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("List after review: %v", err)
	}
	if len(entriesAfterReview) != 2 {
		t.Fatalf("len(entriesAfterReview) = %d, want no-write count 2", len(entriesAfterReview))
	}

	resolveText := callDecisionHandlerText(t, handleDecisionResolve, store, map[string]any{
		"action":     "resolve",
		"resolution": "link_as_related",
		"id":         accepted.ID,
		"title":      "Related MCP decision",
	})
	var resolveResult decisionreview.Result
	if err := json.Unmarshal([]byte(resolveText), &resolveResult); err != nil {
		t.Fatalf("unmarshal resolve: %v\n%s", err, resolveText)
	}
	if resolveResult.Decision == nil || resolveResult.Decision.ID == accepted.ID || resolveResult.Decision.Status != models.DecisionStatusDraft {
		t.Fatalf("resolve result = %+v, want new draft related decision", resolveResult)
	}
	if len(resolveResult.Decision.Sources) != 1 || resolveResult.Decision.Sources[0] != models.DecisionRef(accepted.ID) {
		t.Fatalf("resolve sources = %#v", resolveResult.Decision.Sources)
	}

	listText := callDecisionHandlerText(t, handleDecisionList, store, map[string]any{"action": "list"})
	var listed []models.DecisionEntry
	if err := json.Unmarshal([]byte(listText), &listed); err != nil {
		t.Fatalf("unmarshal list: %v\n%s", err, listText)
	}
	if len(listed) != 1 || listed[0].ID != accepted.ID {
		t.Fatalf("default list = %+v, want only %s", listed, accepted.ID)
	}

	linkedText := callDecisionHandlerText(t, handleDecisionLink, store, map[string]any{
		"action":       "link",
		"id":           draft.ID,
		"relatedTasks": []any{"yken4b"},
	})
	var linked models.DecisionEntry
	if err := json.Unmarshal([]byte(linkedText), &linked); err != nil {
		t.Fatalf("unmarshal linked: %v\n%s", err, linkedText)
	}
	if linked.Status != models.DecisionStatusAccepted || len(linked.RelatedTasks) != 1 {
		t.Fatalf("linked decision = %+v", linked)
	}

	supersedeText := callDecisionHandlerText(t, handleDecisionSupersede, store, map[string]any{
		"action": "supersede",
		"oldId":  linked.ID,
		"newId":  accepted.ID,
	})
	var result struct {
		Superseded models.DecisionEntry `json:"superseded"`
		Current    models.DecisionEntry `json:"current"`
	}
	if err := json.Unmarshal([]byte(supersedeText), &result); err != nil {
		t.Fatalf("unmarshal supersede: %v\n%s", err, supersedeText)
	}
	if result.Superseded.Status != models.DecisionStatusSuperseded || result.Current.Supersedes[0] != linked.ID {
		t.Fatalf("supersede result = %+v", result)
	}
}

type decisionHandlerFunc func(func() *storage.Store, mcp.CallToolRequest) (*mcp.CallToolResult, error)

func callDecisionHandlerText(t *testing.T, fn decisionHandlerFunc, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := fn(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("handler returned error: %v, result: %+v", err, result)
	}
	if len(result.Content) != 1 {
		t.Fatalf("expected one content item, got %d", len(result.Content))
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	return text.Text
}

func setupDecisionHandlerStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("decision-handler-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}
