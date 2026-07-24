package handlers

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func TestDecisionHandlersLifecycle(t *testing.T) {
	store := setupDecisionHandlerStore(t)
	if err := store.Tasks.Create(&models.Task{
		ID: "verify1", Title: "Verify decision", Status: "done", Priority: "medium", Labels: []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Verified", Completed: true}},
	}); err != nil {
		t.Fatalf("create verification task: %v", err)
	}

	draftText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action":   "create",
		"title":    "Store audit timestamps for cache pruning",
		"decision": "Record cache audit timestamps before pruning stale entries.",
	})
	var draft models.DecisionEntry
	if err := json.Unmarshal([]byte(draftText), &draft); err != nil {
		t.Fatalf("unmarshal draft: %v\n%s", err, draftText)
	}
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draft.Status)
	}

	acceptedText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action":       "create",
		"title":        "Accepted MCP decision",
		"sources":      []any{"https://example.com/vector-spec"},
		"relatedTasks": []any{"verify1"},
	})
	var accepted models.DecisionEntry
	if err := json.Unmarshal([]byte(acceptedText), &accepted); err != nil {
		t.Fatalf("unmarshal accepted: %v\n%s", err, acceptedText)
	}
	if accepted.Status != models.DecisionStatusDraft {
		t.Fatalf("linked status = %q, want draft", accepted.Status)
	}
	acceptedResultText := callDecisionHandlerText(t, handleDecisionAccept, store, map[string]any{"action": "accept", "id": accepted.ID})
	var acceptedResult decisionreview.Result
	if err := json.Unmarshal([]byte(acceptedResultText), &acceptedResult); err != nil {
		t.Fatalf("unmarshal accept result: %v", err)
	}
	accepted = *acceptedResult.Decision

	duplicateText := callDecisionHandlerText(t, handleDecisionCreate, store, map[string]any{
		"action":       "create",
		"title":        "Accepted MCP decision",
		"sources":      []any{"https://example.com/vector-spec-v2"},
		"relatedTasks": []any{"verify1"},
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
	if len(entriesAfterReview) != 3 {
		t.Fatalf("len(entriesAfterReview) = %d, want persisted candidate count 3", len(entriesAfterReview))
	}

	inboxResult, err := handleDecisionReviewInbox(func() *storage.Store { return store })
	inboxText := decisionToolResultText(t, inboxResult, err)
	var inbox []models.DecisionEntry
	if err := json.Unmarshal([]byte(inboxText), &inbox); err != nil {
		t.Fatalf("unmarshal review inbox: %v\n%s", err, inboxText)
	}
	foundCandidate := false
	for _, candidate := range inbox {
		if candidate.ID == reviewResult.Candidate.ID && candidate.ReviewState == models.DecisionReviewStateNeedsResolution {
			foundCandidate = true
		}
	}
	if !foundCandidate {
		t.Fatalf("review inbox = %+v, missing persisted candidate", inbox)
	}

	resolveText := callDecisionHandlerText(t, handleDecisionResolve, store, map[string]any{
		"action":      "resolve",
		"resolution":  "link_as_related",
		"candidateId": reviewResult.Candidate.ID,
		"targetId":    accepted.ID,
	})
	var resolveResult decisionreview.Result
	if err := json.Unmarshal([]byte(resolveText), &resolveResult); err != nil {
		t.Fatalf("unmarshal resolve: %v\n%s", err, resolveText)
	}
	if resolveResult.Decision == nil || resolveResult.Decision.ID != reviewResult.Candidate.ID || resolveResult.Decision.Status != models.DecisionStatusRejected {
		t.Fatalf("resolve result = %+v, want rejected linked candidate", resolveResult)
	}
	if resolveResult.Current == nil || resolveResult.Current.ID != accepted.ID ||
		!containsString(resolveResult.Current.Sources, models.DecisionRef(reviewResult.Candidate.ID)) {
		t.Fatalf("resolve current = %+v", resolveResult.Current)
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
		"relatedTasks": []any{"verify1"},
		"sources":      []any{"https://example.com/draft-spec"},
	})
	var linked models.DecisionEntry
	if err := json.Unmarshal([]byte(linkedText), &linked); err != nil {
		t.Fatalf("unmarshal linked: %v\n%s", err, linkedText)
	}
	if linked.Status != models.DecisionStatusDraft || len(linked.RelatedTasks) != 1 {
		t.Fatalf("linked decision = %+v", linked)
	}
	linkedResultText := callDecisionHandlerText(t, handleDecisionAccept, store, map[string]any{"action": "accept", "id": linked.ID})
	var linkedResult decisionreview.Result
	if err := json.Unmarshal([]byte(linkedResultText), &linkedResult); err != nil {
		t.Fatalf("unmarshal linked accept result: %v", err)
	}
	linked = *linkedResult.Decision

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

func TestDecisionHandlersMigrationEntryPoints(t *testing.T) {
	store := setupDecisionHandlerStore(t)
	memoryID := "mcpmig1"
	path := filepath.Join(store.Root, "memory", models.MemoryFileName(memoryID))
	raw := "---\nid: mcpmig1\ntitle: Legacy MCP decision\nlayer: project\ncategory: decision\nstatus: active\nsources: []\ntags: []\ncreatedAt: '2026-07-23T10:00:00Z'\nupdatedAt: '2026-07-23T10:00:00Z'\n---\n\nUse System Decisions.\n"
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	previewResult, err := handleDecisionMigrationPreview(func() *storage.Store { return store })
	previewText := decisionToolResultText(t, previewResult, err)
	var preview decisionmigration.PreviewReport
	if err := json.Unmarshal([]byte(previewText), &preview); err != nil || preview.Counts.Total != 1 {
		t.Fatalf("preview = %+v err=%v", preview, err)
	}
	after, _ := os.ReadFile(path)
	if string(after) != raw {
		t.Fatal("MCP migration preview wrote memory")
	}

	req := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"action":              "migration_apply",
		"memoryId":            memoryID,
		"migrationResolution": decisionmigration.ResolutionCreateDecision,
	}}}
	applyResult, err := handleDecisionMigrationApply(context.Background(), func() *storage.Store { return store }, req)
	applyText := decisionToolResultText(t, applyResult, err)
	var applied decisionmigration.ApplyResult
	if err := json.Unmarshal([]byte(applyText), &applied); err != nil || len(applied.Results) != 1 || applied.Results[0].DecisionID == "" {
		t.Fatalf("apply = %+v err=%v", applied, err)
	}
	decision, _ := store.Decisions.Get(applied.Results[0].DecisionID)
	if decision.Status != models.DecisionStatusDraft {
		t.Fatalf("migrated status = %s, want draft", decision.Status)
	}

	rollbackReq := mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"memoryId": memoryID}}}
	rollbackResult, err := handleDecisionMigrationRollback(context.Background(), func() *storage.Store { return store }, rollbackReq)
	rollbackText := decisionToolResultText(t, rollbackResult, err)
	var rolledBack decisionmigration.RollbackResult
	if err := json.Unmarshal([]byte(rollbackText), &rolledBack); err != nil || rolledBack.State != decisionmigration.JournalRolledBack {
		t.Fatalf("rollback = %+v err=%v", rolledBack, err)
	}
}

type decisionHelpCapture struct {
	entries map[string]HelpEntry
}

func (capture *decisionHelpCapture) AddTool(mcp.Tool, server.ToolHandlerFunc) {}
func (capture *decisionHelpCapture) RegisterHelp(key string, entry HelpEntry) {
	capture.entries[key] = entry
}

func TestDecisionHelpDiscoversLifecycleAndMigration(t *testing.T) {
	capture := &decisionHelpCapture{entries: make(map[string]HelpEntry)}
	RegisterDecisionTool(capture, func() *storage.Store { return nil })
	entry, ok := capture.entries["decision"]
	if !ok {
		t.Fatal("decision help was not registered")
	}
	searchable := helpSearchText("decision", entry)
	for _, want := range []string{"migration_preview", "migration_apply", "migration_rollback", "legacy decision memory", "verified"} {
		if !strings.Contains(searchable, want) {
			t.Fatalf("decision help missing %q: %+v", want, entry)
		}
	}
}

type decisionHandlerFunc func(func() *storage.Store, mcp.CallToolRequest) (*mcp.CallToolResult, error)

func callDecisionHandlerText(t *testing.T, fn decisionHandlerFunc, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := fn(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	return decisionToolResultText(t, result, err)
}

func decisionToolResultText(t *testing.T, result *mcp.CallToolResult, err error) string {
	t.Helper()
	if err != nil || result == nil || result.IsError {
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
