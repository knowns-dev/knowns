package handlers

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/memoryreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/mark3labs/mcp-go/mcp"
)

func TestMemoryAddRejectsLegacyDecisionCategory(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	result, err := handleMemoryAdd(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{
		"action": "add", "category": " Decision ", "content": "Do not persist this.",
	}}})
	if err != nil {
		t.Fatalf("handleMemoryAdd error: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("result = %+v, want tool error", result)
	}
	if text := callMemoryTextResult(t, result); !strings.Contains(text, "System Decision") {
		t.Fatalf("error = %q, want actionable System Decision guidance", text)
	}
	entries, listErr := store.Memory.ListPersistent("")
	if listErr != nil || len(entries) != 0 {
		t.Fatalf("rejected write persisted entries=%+v err=%v", entries, listErr)
	}
}

func TestMemoryAddNoMatchCreatesActiveAndIsRetrievable(t *testing.T) {
	// A write that conflicts with nothing lands active and shows up in the
	// default list straight away. It used to land proposed and stay invisible,
	// which meant an agent using MCP had no way at all to create a memory that
	// would ever be read back.
	store := setupMemoryCleanupStore(t)
	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Unique memory",
		"category": "pattern",
		"content":  "Prefer `storage.Store` over a bare path when a helper needs the memory plane.",
	})
	entry := *decodeMemoryWrite(t, text).Memory
	if entry.Status != models.MemoryStatusActive {
		t.Fatalf("status = %q, want active", entry.Status)
	}
	if !entry.CurrentForDefaultRetrieval() {
		t.Fatal("expected the new memory to be current for default retrieval")
	}
	if entry.Key != "unique-memory" {
		t.Fatalf("key = %q, want a slug derived from the title", entry.Key)
	}

	listText := callMemoryList(t, store, map[string]any{"action": "list"})
	var summaries []map[string]any
	if err := json.Unmarshal([]byte(listText), &summaries); err != nil {
		t.Fatalf("unmarshal list output: %v\n%s", err, listText)
	}
	if len(summaries) != 1 {
		t.Fatalf("default list should contain the new memory, got %+v", summaries)
	}
}

func TestMemoryAddExplicitStatusStillWins(t *testing.T) {
	// active is only the default. A caller that wants the old behaviour, or any
	// other lifecycle state, still gets exactly what it asked for.
	store := setupMemoryCleanupStore(t)
	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Explicitly proposed",
		"category": "pattern",
		"content":  "Hold this one for review.",
		"status":   models.MemoryStatusProposed,
	})
	entry := *decodeMemoryWrite(t, text).Memory
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entry.Status)
	}
}

func TestMemoryAddDuplicateReturnsReviewRequiredAndNoWrite(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	createMemoryForCleanupTest(t, store, "active1", models.MemoryLayerProject, time.Now().UTC(), time.Now().UTC())
	existing, err := store.Memory.Get("active1")
	if err != nil {
		t.Fatalf("get existing: %v", err)
	}
	existing.Title = "Default vector database"
	existing.Category = "pattern"
	existing.Content = "Use Qdrant as the default vector database."
	existing.Status = models.MemoryStatusActive
	if err := store.Memory.Update(existing); err != nil {
		t.Fatalf("update existing: %v", err)
	}

	before := len(callMemoryCleanupListPersistent(t, store))
	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Default vector database",
		"category": "pattern",
		"content":  "Use Qdrant as the default vector database.",
	})
	var result memoryreview.Result
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		t.Fatalf("unmarshal review output: %v\n%s", err, text)
	}
	if result.Status != memoryreview.ResultReviewRequired {
		t.Fatalf("status = %q, want review_required", result.Status)
	}
	if len(result.Matches) != 1 || result.Matches[0].ID != "active1" {
		t.Fatalf("matches = %+v", result.Matches)
	}
	if after := len(callMemoryCleanupListPersistent(t, store)); after != before {
		t.Fatalf("memory count changed on review: before=%d after=%d", before, after)
	}
}

func TestMemoryCleanupDefaultsReturnStaleMemories(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "old001", models.MemoryLayerProject, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))
	createMemoryForCleanupTest(t, store, "new001", models.MemoryLayerProject, now.AddDate(0, 0, -1), now.AddDate(0, 0, -1))

	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d: %+v", len(candidates), candidates)
	}
	if candidates[0].ID != "old001" || candidates[0].Content == "" || candidates[0].AgeDays < 9 {
		t.Fatalf("unexpected candidate: %+v", candidates[0])
	}
}

func TestMemoryCleanupCustomThresholdLayerLimitAndSorting(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "proj01", models.MemoryLayerProject, now.AddDate(0, 0, -40), now.AddDate(0, 0, -40))
	createMemoryForCleanupTest(t, store, "glob01", models.MemoryLayerGlobal, now.AddDate(0, 0, -30), now.AddDate(0, 0, -30))
	createMemoryForCleanupTest(t, store, "glob02", models.MemoryLayerGlobal, now.AddDate(0, 0, -50), now.AddDate(0, 0, -50))
	createMemoryForCleanupTest(t, store, "glob03", models.MemoryLayerGlobal, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))

	candidates := callMemoryCleanup(t, store, map[string]any{
		"action":        "cleanup",
		"layer":         models.MemoryLayerGlobal,
		"olderThanDays": 14,
		"limit":         1,
	})
	if len(candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(candidates))
	}
	if candidates[0].ID != "glob02" {
		t.Fatalf("expected oldest global memory first, got %+v", candidates[0])
	}
}

func TestMemoryCleanupEmptyWhenNoStaleMemories(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "new001", models.MemoryLayerProject, now.AddDate(0, 0, -1), now.AddDate(0, 0, -1))

	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 0 {
		t.Fatalf("expected no candidates, got %+v", candidates)
	}
}

func TestMemoryUpdateTouchRemovesEntryFromCleanup(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	now := time.Now().UTC()
	createMemoryForCleanupTest(t, store, "old001", models.MemoryLayerProject, now.AddDate(0, 0, -10), now.AddDate(0, 0, -10))

	before, err := store.Memory.Get("old001")
	if err != nil {
		t.Fatalf("get before: %v", err)
	}
	updated, err := handleMemoryUpdate(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: map[string]any{"action": "update", "id": "old001"}}})
	if err != nil || updated.IsError {
		t.Fatalf("update returned error: %v, result: %+v", err, updated)
	}
	after, err := store.Memory.Get("old001")
	if err != nil {
		t.Fatalf("get after: %v", err)
	}
	if !after.UpdatedAt.After(before.UpdatedAt) {
		t.Fatalf("expected updatedAt to advance, before=%s after=%s", before.UpdatedAt, after.UpdatedAt)
	}
	candidates := callMemoryCleanup(t, store, map[string]any{"action": "cleanup"})
	if len(candidates) != 0 {
		t.Fatalf("expected touched memory to be excluded, got %+v", candidates)
	}
}

func setupMemoryCleanupStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("memory-cleanup-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func createMemoryForCleanupTest(t *testing.T, store *storage.Store, id, layer string, createdAt, updatedAt time.Time) {
	t.Helper()
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        id,
		Title:     "Memory " + id,
		Layer:     layer,
		Category:  "pattern",
		Tags:      []string{"cleanup"},
		Content:   "Content for " + id,
		CreatedAt: createdAt,
		UpdatedAt: updatedAt,
	}); err != nil {
		t.Fatalf("create memory %s: %v", id, err)
	}
}

func callMemoryCleanup(t *testing.T, store *storage.Store, args map[string]any) []models.MemoryCleanupCandidate {
	t.Helper()
	result, err := handleMemoryCleanup(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("cleanup returned error: %v, result: %+v", err, result)
	}
	if len(result.Content) != 1 {
		t.Fatalf("expected one content item, got %d", len(result.Content))
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	var candidates []models.MemoryCleanupCandidate
	if err := json.Unmarshal([]byte(text.Text), &candidates); err != nil {
		t.Fatalf("unmarshal cleanup output: %v\n%s", err, text.Text)
	}
	return candidates
}

// decodeMemoryWrite reads the one shape every memory write now returns. The
// three write paths used to answer in two different shapes; this helper exists
// so a future divergence fails here rather than in a caller.
func decodeMemoryWrite(t *testing.T, text string) memoryWriteResult {
	t.Helper()
	var out memoryWriteResult
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("unmarshal memory write result: %v\n%s", err, text)
	}
	if out.Memory == nil {
		t.Fatalf("memory write result carried no entry: %s", text)
	}
	return out
}

func callMemoryAdd(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryAdd(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("add returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func callMemoryList(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryList(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("list returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func callMemoryTextResult(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()
	if len(result.Content) != 1 {
		t.Fatalf("expected one content item, got %d", len(result.Content))
	}
	text, ok := result.Content[0].(mcp.TextContent)
	if !ok {
		t.Fatalf("expected text content, got %T", result.Content[0])
	}
	return text.Text
}

func callMemoryCleanupListPersistent(t *testing.T, store *storage.Store) []*models.MemoryEntry {
	t.Helper()
	entries, err := store.Memory.ListPersistent("")
	if err != nil {
		t.Fatalf("list persistent memories: %v", err)
	}
	return entries
}

// callMemoryAddExpectingError runs add and requires it to be refused, returning
// the message so a test can assert the refusal explains itself.
func callMemoryAddExpectingError(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryAdd(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil {
		t.Fatalf("add returned a transport error: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected add to be refused, got: %+v", result)
	}
	return callMemoryTextResult(t, result)
}

func callMemoryUpdate(t *testing.T, store *storage.Store, args map[string]any) string {
	t.Helper()
	result, err := handleMemoryUpdate(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("update returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func TestMemoryAddRejectsPreferenceWithoutWhy(t *testing.T) {
	// A preference has no truth-maker outside the user's own words, so the
	// reason is the only thing that lets it be applied to a case it does not
	// name. "No em dash" cannot say whether it covers a string literal.
	store := setupMemoryCleanupStore(t)
	msg := callMemoryAddExpectingError(t, store, map[string]any{
		"action":   "add",
		"title":    "Avoid em dashes",
		"category": "preference",
		"content":  "Never use an em dash in prose written for the user.",
	})
	if !strings.Contains(msg, "**Why:**") {
		t.Fatalf("refusal should name the missing marker, got: %s", msg)
	}
	if entries := callMemoryCleanupListPersistent(t, store); len(entries) != 0 {
		t.Fatalf("refused add must write nothing, got %d entries", len(entries))
	}

	text := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Avoid em dashes",
		"category": "preference",
		"content":  "Never use an em dash in prose written for the user.\n\n**Why:** it reads as machine-written.",
	})
	entry := *decodeMemoryWrite(t, text).Memory
	if entry.Category != "preference" {
		t.Fatalf("category = %q, want preference", entry.Category)
	}
}

func TestMemoryAddRejectsCategoryOutsideTheContract(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	msg := callMemoryAddExpectingError(t, store, map[string]any{
		"action":   "add",
		"title":    "Document history storage",
		"category": "implementation",
		"content":  "Revisions live under .knowns/history.",
	})
	if !strings.Contains(msg, "implementation") {
		t.Fatalf("refusal should name the rejected category, got: %s", msg)
	}

	// Each entry has to be genuinely unlike the others. Near-identical titles or
	// bodies trip the duplicate review, which writes nothing and would make this
	// test fail for a reason that has nothing to do with categories.
	accepted := []struct{ category, title, content string }{
		{"pattern", "Retry with jittered backoff", "Spread reconnects so a restart does not thunder."},
		{"convention", "Anchor citations to symbols", "Cite `Manager.Start`, never a line number."},
		{"preference", "Answer in Vietnamese", "Reply in Vietnamese.\n\n**Why:** the user writes in Vietnamese."},
		{"failure", "A stale pid file blocks recovery", "`Manager.Start` reports state=stale and falls through to a fresh spawn."},
	}
	for _, tc := range accepted {
		callMemoryAdd(t, store, map[string]any{
			"action":   "add",
			"title":    tc.title,
			"category": tc.category,
			"content":  tc.content,
		})
	}
	if entries := callMemoryCleanupListPersistent(t, store); len(entries) != len(accepted) {
		t.Fatalf("expected %d entries, got %d", len(accepted), len(entries))
	}
}

func TestMemoryAddWithSameExplicitKeyUpdatesInPlace(t *testing.T) {
	// Two writes under one key must converge on one entry, and the id must
	// survive, because @memory/<id> refs already exist in the store and in the
	// shipped instructions.
	store := setupMemoryCleanupStore(t)
	first := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Qdrant is the default vector store",
		"key":      "vector-store-default",
		"category": "convention",
		"content":  "Qdrant, managed mode.",
	})
	created := *decodeMemoryWrite(t, first).Memory

	second := callMemoryAdd(t, store, map[string]any{
		"action":   "add",
		"title":    "Qdrant is the default vector store",
		"key":      "vector-store-default",
		"category": "convention",
		"content":  "Qdrant, managed mode, started from the reconcile path.",
		"sources":  []any{"internal/qdrantruntime/manager.go"},
	})
	var upsert struct {
		Replaced bool                `json:"replaced"`
		Memory   *models.MemoryEntry `json:"memory"`
	}
	if err := json.Unmarshal([]byte(second), &upsert); err != nil {
		t.Fatalf("unmarshal second add: %v\n%s", err, second)
	}
	if !upsert.Replaced {
		t.Fatalf("second write under the same key should report replaced, got: %s", second)
	}
	if upsert.Memory.ID != created.ID {
		t.Fatalf("id changed across upsert: %q then %q", created.ID, upsert.Memory.ID)
	}
	if upsert.Memory.LastVerified.IsZero() {
		t.Fatal("supplying sources should stamp lastVerified")
	}
	if entries := callMemoryCleanupListPersistent(t, store); len(entries) != 1 {
		t.Fatalf("expected exactly one entry after the upsert, got %d", len(entries))
	}
}

func TestMemoryUpdateWritesProvenance(t *testing.T) {
	// Before this, sources, confidence and lastVerified were reachable only
	// through the duplicate-resolution flow, so an entry could be re-confirmed
	// and still read as last checked months earlier.
	store := setupMemoryCleanupStore(t)
	createMemoryForCleanupTest(t, store, "prov1", models.MemoryLayerProject, time.Now().UTC(), time.Now().UTC())

	text := callMemoryUpdate(t, store, map[string]any{
		"action":     "update",
		"id":         "prov1",
		"sources":    []any{"internal/search/engine.go", "@task-npgfm4"},
		"confidence": models.MemoryConfidenceHigh,
		"ttlDays":    180,
	})
	entry := *decodeMemoryWrite(t, text).Memory
	if len(entry.Sources) != 2 {
		t.Fatalf("sources = %+v, want two", entry.Sources)
	}
	if entry.Confidence != models.MemoryConfidenceHigh {
		t.Fatalf("confidence = %q, want high", entry.Confidence)
	}
	if entry.TTLDays != 180 {
		t.Fatalf("ttlDays = %d, want 180", entry.TTLDays)
	}
	if entry.LastVerified.IsZero() {
		t.Fatal("supplying evidence should stamp lastVerified")
	}

	stored, err := store.Memory.Get("prov1")
	if err != nil {
		t.Fatalf("get stored: %v", err)
	}
	if len(stored.Sources) != 2 || stored.Confidence != models.MemoryConfidenceHigh {
		t.Fatalf("provenance did not survive the round trip: %+v", stored)
	}
}

func callMemoryAction(t *testing.T, store *storage.Store, fn func(func() *storage.Store, mcp.CallToolRequest) (*mcp.CallToolResult, error), args map[string]any) string {
	t.Helper()
	result, err := fn(func() *storage.Store { return store }, mcp.CallToolRequest{Params: mcp.CallToolParams{Arguments: args}})
	if err != nil || result.IsError {
		t.Fatalf("action returned error: %v, result: %+v", err, result)
	}
	return callMemoryTextResult(t, result)
}

func TestMemoryConfirmStampsVerificationWithoutChangingStatus(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	createMemoryForCleanupTest(t, store, "conf1", models.MemoryLayerProject, time.Now().UTC(), time.Now().UTC())

	text := callMemoryAction(t, store, handleMemoryConfirm, map[string]any{"action": "confirm", "id": "conf1"})
	// confirm is a lifecycle action, not a content write: it cannot move the
	// claim boundary, so it keeps returning the entry directly.
	var entry models.MemoryEntry
	if err := json.Unmarshal([]byte(text), &entry); err != nil {
		t.Fatalf("unmarshal confirm output: %v\n%s", err, text)
	}
	if entry.LastVerified.IsZero() {
		t.Fatal("confirm should stamp lastVerified")
	}
	// Confirming says the content still holds. It is not a promotion, so an
	// entry still under review must not be quietly moved out of the queue.
	before, err := store.Memory.Get("conf1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if entry.Status != before.Status {
		t.Fatalf("confirm changed status from %q to %q", before.Status, entry.Status)
	}
}

func TestMemoryContradictSplitsByWhoDecides(t *testing.T) {
	store := setupMemoryCleanupStore(t)

	// A claim about the code: the repository settles it, an agent can read the
	// repository, so an agent may retire it.
	worldFact := callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Retry uses jittered backoff",
		"category": "failure", "content": "`Manager.Start` retries with jitter.",
	})
	worldEntry := *decodeMemoryWrite(t, worldFact).Memory
	text := callMemoryAction(t, store, handleMemoryContradict, map[string]any{
		"action": "contradict", "id": worldEntry.ID, "note": "the jitter was removed in a refactor",
	})
	var got struct {
		Outcome   string              `json:"outcome"`
		NeedsUser bool                `json:"needsUser"`
		Memory    *models.MemoryEntry `json:"memory"`
	}
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatalf("unmarshal contradict output: %v\n%s", err, text)
	}
	if got.Memory.Status != models.MemoryStatusStale {
		t.Fatalf("world-fact status = %q, want stale", got.Memory.Status)
	}
	if got.NeedsUser {
		t.Error("a claim about the code should not need the user to retire it")
	}

	// A commitment: nothing outside the user's words makes it true, so an agent
	// saying it "seems wrong" has observed nothing that bears on it.
	pref := callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Reply in Vietnamese",
		"category": "preference",
		"content":  "Answer in Vietnamese.\n\n**Why:** the user writes in Vietnamese.",
	})
	prefEntry := *decodeMemoryWrite(t, pref).Memory
	text = callMemoryAction(t, store, handleMemoryContradict, map[string]any{
		"action": "contradict", "id": prefEntry.ID, "note": "saw an English reply",
	})
	if err := json.Unmarshal([]byte(text), &got); err != nil {
		t.Fatalf("unmarshal contradict output: %v\n%s", err, text)
	}
	if got.Memory.Status != models.MemoryStatusActive {
		t.Fatalf("preference status = %q, want it left active", got.Memory.Status)
	}
	if !got.NeedsUser {
		t.Error("contradicting a preference must say the user has to decide")
	}
	if got.Memory.Metadata[memoryDisputedMetadataKey] == "" {
		t.Error("the dispute should be recorded on the entry")
	}
}

func TestMemoryAddReportsTheClaimItWillInject(t *testing.T) {
	store := setupMemoryCleanupStore(t)

	// Multi-paragraph, no marker: the boundary is a guess and the author is the
	// only one who can settle it, so say so while they still have it in mind.
	guessed := decodeMemoryWrite(t, callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Retry uses jittered backoff", "category": "failure",
		"content": "`Manager.Start` retries with jitter.\n\nAdded 2026-08-01 after the thundering herd on deploy.",
	}))
	if guessed.Claim != "`Manager.Start` retries with jitter." {
		t.Fatalf("claim = %q", guessed.Claim)
	}
	if guessed.ClaimSource != models.MemoryClaimSourceFirstParagraph {
		t.Fatalf("claimSource = %q, want first-paragraph", guessed.ClaimSource)
	}
	if guessed.ClaimWarning == "" {
		t.Fatal("a guessed boundary must be reported at write time")
	}
	if guessed.Memory.Status != models.MemoryStatusActive {
		t.Fatalf("a guessed boundary must not block the write, status = %q", guessed.Memory.Status)
	}

	// Single paragraph: nothing to split. Warning here would train the author
	// to scroll past the warning that matters.
	whole := decodeMemoryWrite(t, callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Timeouts are five seconds", "category": "pattern",
		"content": "Every outbound call uses a five second timeout.",
	}))
	if whole.ClaimSource != models.MemoryClaimSourceWhole {
		t.Fatalf("claimSource = %q, want whole", whole.ClaimSource)
	}
	if whole.ClaimWarning != "" {
		t.Fatalf("single-paragraph write must not warn, got %q", whole.ClaimWarning)
	}

	// Marker present: the author chose, so report it and stay quiet.
	marked := decodeMemoryWrite(t, callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Config is read once", "category": "pattern",
		"content": "Config is read once at startup.\n" + models.MemoryDetailMarker + "\nA reload needs a restart.",
	}))
	if marked.ClaimSource != models.MemoryClaimSourceMarker || marked.ClaimWarning != "" {
		t.Fatalf("claimSource = %q warning = %q", marked.ClaimSource, marked.ClaimWarning)
	}
}

func TestMemoryUpdateReportsTheClaimToo(t *testing.T) {
	store := setupMemoryCleanupStore(t)
	created := decodeMemoryWrite(t, callMemoryAdd(t, store, map[string]any{
		"action": "add", "title": "Config is read once", "category": "pattern",
		"content": "Config is read once at startup.",
	}))
	if created.ClaimWarning != "" {
		t.Fatalf("unexpected warning on create: %q", created.ClaimWarning)
	}

	// Growing a one-paragraph memory into several is exactly when the boundary
	// starts being guessed, and exactly when nobody would think to check.
	updated := decodeMemoryWrite(t, callMemoryUpdate(t, store, map[string]any{
		"action": "update", "id": created.Memory.ID,
		"content": "Config is read once at startup.\n\nA reload needs a restart.",
	}))
	if updated.ClaimSource != models.MemoryClaimSourceFirstParagraph || updated.ClaimWarning == "" {
		t.Fatalf("claimSource = %q warning = %q", updated.ClaimSource, updated.ClaimWarning)
	}
	if updated.Claim != "Config is read once at startup." {
		t.Fatalf("claim = %q", updated.Claim)
	}
}
