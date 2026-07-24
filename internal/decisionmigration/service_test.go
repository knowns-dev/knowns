package decisionmigration

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestPreviewIsDeterministicClassifiedAndReadOnly(t *testing.T) {
	store := setupMigrationStore(t)
	verifiedAt := migrationTime().Add(-time.Hour)
	existingDecision := &models.DecisionEntry{
		Title:        "Existing system decision",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"https://example.com/evidence"},
		Verification: []string{"task:@task-proof:done"},
		VerifiedAt:   &verifiedAt,
	}
	if err := store.Decisions.Create(existingDecision, storage.DecisionCreateOptions{Now: verifiedAt}); err != nil {
		t.Fatalf("create existing decision: %v", err)
	}

	seedLegacyMemory(t, store, legacyMemory("noise01", "Project workflow decision", "Captured automatically from a prompt."))
	seedLegacyMemory(t, store, legacyMemory("dup001", "Use bounded retrieval", "Only retrieve current guidance for the active scope."))
	seedLegacyMemory(t, store, legacyMemory("dup002", "Bound current guidance", "Only retrieve current guidance for the active scope."))
	linked := legacyMemory("linked1", "Existing decision provenance", "Historical source: "+models.DecisionRef(existingDecision.ID))
	seedLegacyMemory(t, store, linked)
	seedLegacyMemory(t, store, legacyMemory("class01", "Repository convention", "Convention: use the code tool for structural edits."))

	before := snapshotTree(t, store.Root)
	service := New(store)
	first, err := service.Preview()
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	second, err := service.Preview()
	if err != nil {
		t.Fatalf("second Preview: %v", err)
	}
	after := snapshotTree(t, store.Root)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("Preview wrote project files\nbefore=%v\nafter=%v", sortedKeys(before), sortedKeys(after))
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("Preview is not deterministic\nfirst=%+v\nsecond=%+v", first, second)
	}
	if first.Counts.Total != 5 || first.Counts.HighNoise != 1 || first.Counts.Duplicate != 2 {
		t.Fatalf("preview counts = %+v", first.Counts)
	}

	byID := candidatesByID(first.Candidates)
	if got := byID["noise01"].ProposedResolution; got != ResolutionArchiveNoise {
		t.Fatalf("noise resolution = %q", got)
	}
	if got := byID["dup002"].ProposedResolution; got != ResolutionConsolidateDuplicate || byID["dup002"].ProposedTargetID != "dup001" {
		t.Fatalf("duplicate proposal = %+v", byID["dup002"])
	}
	if got := byID["linked1"].ProposedResolution; got != ResolutionLinkExisting || byID["linked1"].ProposedDecisionID != existingDecision.ID {
		t.Fatalf("link proposal = %+v", byID["linked1"])
	}
	if got := byID["class01"].ProposedResolution; got != ResolutionReclassify || byID["class01"].ProposedCategory != "convention" {
		t.Fatalf("reclassify proposal = %+v", byID["class01"])
	}
}

func TestPreviewRejectsCorruptMigrationJournal(t *testing.T) {
	store := setupMigrationStore(t)
	memory := legacyMemory("broken1", "Broken journal", "This candidate has a corrupt prior migration journal.")
	seedLegacyMemory(t, store, memory)
	journalDir := filepath.Join(store.Root, "migrations", "decision-memory")
	if err := os.MkdirAll(journalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(journalDir, memory.ID+".json"), []byte("{not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := New(store).Preview(); err == nil || !strings.Contains(err.Error(), "parse migration journal") {
		t.Fatalf("Preview error = %v, want corrupt journal failure", err)
	}
}

func TestCreateMigrationStaysDraftUntilVerifiedThenFinalizesAndRollsBack(t *testing.T) {
	store := setupMigrationStore(t)
	memory := legacyMemory("create1", "Remove Memories from durable decisions", "Use first-class System Decisions; Decision Memory is legacy.")
	memory.Sources = []string{"https://example.com/legacy-record"}
	seedLegacyMemory(t, store, memory)
	service := New(store)
	selection := Selection{MemoryID: memory.ID, Resolution: ResolutionCreateDecision}

	first, err := service.Apply(context.Background(), []Selection{selection})
	if err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	item := first.Results[0]
	if item.DecisionID == "" || item.LegacyExcluded {
		t.Fatalf("create result = %+v", item)
	}
	decision, err := store.Decisions.Get(item.DecisionID)
	if err != nil {
		t.Fatalf("get migrated decision: %v", err)
	}
	if decision.Status != models.DecisionStatusDraft || !contains(decision.Tags, "legacy-memory-migration") || !contains(decision.Sources, memoryReference(memory.ID)) {
		t.Fatalf("draft provenance = %+v", decision)
	}
	legacy, _ := store.Memory.Get(memory.ID)
	if legacy.Status != models.MemoryStatusActive || !legacy.CurrentForDefaultRetrieval() {
		t.Fatalf("legacy was hidden before verified acceptance: %+v", legacy)
	}

	second, err := service.Apply(context.Background(), []Selection{selection})
	if err != nil {
		t.Fatalf("idempotent Apply: %v", err)
	}
	if !second.Results[0].Idempotent || second.Results[0].LegacyExcluded {
		t.Fatalf("idempotent draft result = %+v", second.Results[0])
	}
	decisions, _ := store.Decisions.List()
	if len(decisions) != 1 {
		t.Fatalf("rerun created %d decisions, want 1", len(decisions))
	}

	verifiedAt := migrationTime().Add(time.Hour)
	if _, _, err := store.Decisions.Accept(decision.ID, []string{"reviewed-migration:test"}, nil, verifiedAt); err != nil {
		t.Fatalf("accept migrated decision: %v", err)
	}
	finalized, err := service.Apply(context.Background(), []Selection{selection})
	if err != nil {
		t.Fatalf("finalize accepted migration: %v", err)
	}
	if !finalized.Results[0].LegacyExcluded {
		t.Fatalf("accepted migration did not exclude legacy: %+v", finalized.Results[0])
	}
	legacy, _ = store.Memory.Get(memory.ID)
	if legacy.Status != models.MemoryStatusArchived || legacy.MergedInto != models.DecisionRef(decision.ID) || legacy.Metadata[models.LegacyDecisionMigrationDecisionKey] != decision.ID {
		t.Fatalf("finalized legacy = %+v", legacy)
	}
	rolledBack, err := service.Rollback(context.Background(), memory.ID)
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if rolledBack.State != JournalRolledBack {
		t.Fatalf("rollback result = %+v", rolledBack)
	}
	legacy, _ = store.Memory.Get(memory.ID)
	if legacy.Status != models.MemoryStatusActive || legacy.Metadata != nil {
		t.Fatalf("rollback memory = %+v", legacy)
	}
	decision, _ = store.Decisions.Get(decision.ID)
	if decision.Status != models.DecisionStatusRejected || decision.VerifiedAt != nil {
		t.Fatalf("accepted history should remain as rejected: %+v", decision)
	}
	if _, err := service.Rollback(context.Background(), memory.ID); err != nil {
		t.Fatalf("idempotent Rollback: %v", err)
	}
}

func TestApplySupportsAllReviewedResolutionTypes(t *testing.T) {
	store := setupMigrationStore(t)
	verifiedAt := migrationTime().Add(-time.Hour)
	existing := &models.DecisionEntry{
		Title:        "Canonical target",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"https://example.com/canonical"},
		Verification: []string{"reviewed:test"},
		VerifiedAt:   &verifiedAt,
	}
	if err := store.Decisions.Create(existing, storage.DecisionCreateOptions{Now: verifiedAt}); err != nil {
		t.Fatalf("create target decision: %v", err)
	}

	for _, memory := range []*models.MemoryEntry{
		legacyMemory("target1", "Target duplicate", "Canonical duplicate content."),
		legacyMemory("follow1", "Follower duplicate", "Canonical duplicate content."),
		legacyMemory("reclass", "Code pattern", "Pattern: keep lifecycle transitions atomic."),
		legacyMemory("archive", "Prompt noise", "A noisy capture."),
		legacyMemory("reject", "Rejected prompt noise", "Another noisy capture."),
		legacyMemory("leave01", "Needs later review", "Insufficient evidence for a resolution."),
	} {
		seedLegacyMemory(t, store, memory)
	}
	leavePath := filepath.Join(store.Root, "memory", models.MemoryFileName("leave01"))
	leaveBefore, _ := os.ReadFile(leavePath)

	service := New(store)
	result, err := service.Apply(context.Background(), []Selection{
		{MemoryID: "follow1", Resolution: ResolutionConsolidateDuplicate, TargetMemoryID: "target1"},
		{MemoryID: "target1", Resolution: ResolutionLinkExisting, DecisionID: existing.ID},
		{MemoryID: "reclass", Resolution: ResolutionReclassify, Category: "pattern"},
		{MemoryID: "archive", Resolution: ResolutionArchiveNoise, Reason: "runtime capture"},
		{MemoryID: "reject", Resolution: ResolutionRejectNoise, Reason: "not durable guidance"},
		{MemoryID: "leave01", Resolution: ResolutionLeaveUnchanged},
	})
	if err != nil {
		t.Fatalf("Apply all resolutions: %v; result=%+v", err, result)
	}
	if len(result.Results) != 6 {
		t.Fatalf("results = %d, want 6", len(result.Results))
	}
	for _, id := range []string{"target1", "follow1"} {
		entry, _ := store.Memory.Get(id)
		if entry.Status != models.MemoryStatusArchived || entry.MergedInto != models.DecisionRef(existing.ID) {
			t.Fatalf("decision-backed %s = %+v", id, entry)
		}
	}
	reclassified, _ := store.Memory.Get("reclass")
	if reclassified.Category != "pattern" || reclassified.Status != models.MemoryStatusActive {
		t.Fatalf("reclassified = %+v", reclassified)
	}
	archived, _ := store.Memory.Get("archive")
	if archived.Status != models.MemoryStatusArchived {
		t.Fatalf("archived = %+v", archived)
	}
	rejected, _ := store.Memory.Get("reject")
	if rejected.Status != models.MemoryStatusRejected || rejected.RejectedReason != "not durable guidance" {
		t.Fatalf("rejected = %+v", rejected)
	}
	leaveAfter, _ := os.ReadFile(leavePath)
	if string(leaveBefore) != string(leaveAfter) {
		t.Fatalf("leave_unchanged mutated memory\nbefore:\n%s\nafter:\n%s", leaveBefore, leaveAfter)
	}
	linked, _ := store.Decisions.Get(existing.ID)
	for _, ref := range []string{memoryReference("target1"), memoryReference("follow1")} {
		if !contains(linked.Sources, ref) {
			t.Fatalf("target decision sources %v missing %s", linked.Sources, ref)
		}
	}
	for _, id := range []string{"follow1", "target1", "reclass", "archive", "reject", "leave01"} {
		if _, err := service.Rollback(context.Background(), id); err != nil {
			t.Fatalf("Rollback %s: %v", id, err)
		}
		entry, getErr := store.Memory.Get(id)
		if getErr != nil {
			t.Fatalf("get rolled back %s: %v", id, getErr)
		}
		if entry.Category != models.LegacyDecisionMemoryCategory || entry.Status != models.MemoryStatusActive || entry.Metadata != nil {
			t.Fatalf("rolled back %s = %+v", id, entry)
		}
	}
	linked, _ = store.Decisions.Get(existing.ID)
	if !reflect.DeepEqual(linked.Sources, []string{"https://example.com/canonical"}) {
		t.Fatalf("rollback removed external source or kept migration sources: %v", linked.Sources)
	}
}

func TestApplyCompensatesPartialFailureAndCanRetry(t *testing.T) {
	store := setupMigrationStore(t)
	memory := legacyMemory("retry01", "Retry migration safely", "A durable system evolution record.")
	seedLegacyMemory(t, store, memory)
	service := New(store)
	service.beforeStep = func(memoryID, step string) error {
		if memoryID == memory.ID && step == "before_memory" {
			return fmt.Errorf("injected memory failure")
		}
		return nil
	}
	selection := Selection{MemoryID: memory.ID, Resolution: ResolutionCreateDecision}
	result, err := service.Apply(context.Background(), []Selection{selection})
	if err == nil || len(result.Results) != 1 || !strings.Contains(result.Results[0].Error, "injected memory failure") {
		t.Fatalf("Apply failure = result:%+v err:%v", result, err)
	}
	legacy, _ := store.Memory.Get(memory.ID)
	if legacy.Status != models.MemoryStatusActive || legacy.Metadata != nil {
		t.Fatalf("failed migration changed memory: %+v", legacy)
	}
	decisions, _ := store.Decisions.List()
	if len(decisions) != 0 {
		t.Fatalf("failed draft migration left decisions: %+v", decisions)
	}
	journal, readErr := service.readJournal(memory.ID)
	if readErr != nil || journal.State != JournalFailed {
		t.Fatalf("failed journal = %+v err=%v", journal, readErr)
	}

	service.beforeStep = nil
	retried, err := service.Apply(context.Background(), []Selection{selection})
	if err != nil {
		t.Fatalf("retry Apply: %v", err)
	}
	if retried.Results[0].State != JournalApplied || retried.Results[0].DecisionID == "" {
		t.Fatalf("retry result = %+v", retried.Results[0])
	}
}

func TestAcceptVerifiedRequiresEvidenceAndCompensates(t *testing.T) {
	store := setupMigrationStore(t)
	memory := legacyMemory("verify1", "Verified migration only", "Acceptance requires linked completed task evidence.")
	seedLegacyMemory(t, store, memory)
	service := New(store)
	result, err := service.Apply(context.Background(), []Selection{{
		MemoryID:       memory.ID,
		Resolution:     ResolutionCreateDecision,
		AcceptVerified: true,
	}})
	if err == nil || !strings.Contains(result.Results[0].Error, "linked task") {
		t.Fatalf("verified Apply = result:%+v err:%v", result, err)
	}
	legacy, _ := store.Memory.Get(memory.ID)
	if !legacy.CurrentForDefaultRetrieval() {
		t.Fatalf("failed verification hid legacy: %+v", legacy)
	}
	decisions, _ := store.Decisions.List()
	if len(decisions) != 0 {
		t.Fatalf("failed verification left draft: %+v", decisions)
	}
}

func TestAcceptVerifiedRejectsMemoryOnlyResolution(t *testing.T) {
	selection := Selection{
		MemoryID:       "legacy1",
		Resolution:     ResolutionLeaveUnchanged,
		AcceptVerified: true,
	}
	if err := selection.validate(); err == nil || !strings.Contains(err.Error(), "Decision-backed") {
		t.Fatalf("validate error = %v, want Decision-backed resolution error", err)
	}
}

func TestCurrentDecisionConsumptionGateKeepsLegacyActive(t *testing.T) {
	store := setupMigrationStore(t)
	verifiedAt := migrationTime()
	decision := &models.DecisionEntry{
		Title:        "Accepted but consumer disabled",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"https://example.com/source"},
		Verification: []string{"reviewed:test"},
		VerifiedAt:   &verifiedAt,
	}
	if err := store.Decisions.Create(decision, storage.DecisionCreateOptions{Now: verifiedAt}); err != nil {
		t.Fatal(err)
	}
	memory := legacyMemory("gate001", "Consumer gate", "Keep legacy active until Decision consumption is active.")
	seedLegacyMemory(t, store, memory)
	service := New(store)
	service.CurrentDecisionConsumptionActive = false
	result, err := service.Apply(context.Background(), []Selection{{MemoryID: memory.ID, Resolution: ResolutionLinkExisting, DecisionID: decision.ID}})
	if err != nil {
		t.Fatalf("Apply with gate disabled: %v", err)
	}
	if result.Results[0].LegacyExcluded {
		t.Fatalf("gate-disabled migration excluded legacy: %+v", result.Results[0])
	}
	legacy, _ := store.Memory.Get(memory.ID)
	if !legacy.CurrentForDefaultRetrieval() {
		t.Fatalf("gate-disabled legacy = %+v", legacy)
	}
}

func TestRollbackRejectsPostMigrationMemoryDrift(t *testing.T) {
	store := setupMigrationStore(t)
	memory := legacyMemory("drift01", "Pattern candidate", "Pattern: use an explicit migration review.")
	seedLegacyMemory(t, store, memory)
	service := New(store)
	selection := Selection{MemoryID: memory.ID, Resolution: ResolutionReclassify, Category: "pattern"}
	if _, err := service.Apply(context.Background(), []Selection{selection}); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	changed, _ := store.Memory.Get(memory.ID)
	changed.Content = "A user edited this memory after migration."
	if err := store.Memory.Update(changed); err != nil {
		t.Fatalf("external edit: %v", err)
	}
	if _, err := service.Rollback(context.Background(), memory.ID); err == nil || !strings.Contains(err.Error(), "changed after migration") {
		t.Fatalf("Rollback error = %v, want unsafe drift failure", err)
	}
	unchanged, _ := store.Memory.Get(memory.ID)
	if unchanged.Content != changed.Content || unchanged.Category != "pattern" {
		t.Fatalf("unsafe rollback overwrote external edit: %+v", unchanged)
	}
}

func setupMigrationStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("decision-migration-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return store
}

func migrationTime() time.Time {
	return time.Date(2026, 7, 23, 10, 30, 0, 0, time.UTC)
}

func legacyMemory(id, title, content string) *models.MemoryEntry {
	return &models.MemoryEntry{
		ID:           id,
		Title:        title,
		Layer:        models.MemoryLayerProject,
		Category:     models.LegacyDecisionMemoryCategory,
		Content:      content,
		Status:       models.MemoryStatusActive,
		Confidence:   models.MemoryConfidenceMedium,
		LastVerified: migrationTime(),
		TTLDays:      365,
		CreatedAt:    migrationTime(),
		UpdatedAt:    migrationTime(),
	}
}

func seedLegacyMemory(t *testing.T, store *storage.Store, entry *models.MemoryEntry) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(store.Root, "memory"), 0o755); err != nil {
		t.Fatal(err)
	}
	var sources strings.Builder
	if len(entry.Sources) > 0 {
		sources.WriteString("sources:\n")
		for _, source := range entry.Sources {
			fmt.Fprintf(&sources, "  - %s\n", source)
		}
	} else {
		sources.WriteString("sources: []\n")
	}
	raw := fmt.Sprintf(`---
id: %s
title: %s
layer: project
category: decision
status: %s
confidence: %s
lastVerified: '%s'
ttlDays: %d
%screatedAt: '%s'
updatedAt: '%s'
---

%s
`, entry.ID, entry.Title, entry.Status, entry.Confidence, entry.LastVerified.Format(time.RFC3339), entry.TTLDays, sources.String(), entry.CreatedAt.Format(time.RFC3339), entry.UpdatedAt.Format(time.RFC3339), entry.Content)
	path := filepath.Join(store.Root, "memory", models.MemoryFileName(entry.ID))
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("seed legacy memory: %v", err)
	}
}

func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	result := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		result[relative] = string(data)
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot tree: %v", err)
	}
	return result
}

func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func candidatesByID(candidates []Candidate) map[string]Candidate {
	result := make(map[string]Candidate, len(candidates))
	for _, candidate := range candidates {
		result[candidate.MemoryID] = candidate
	}
	return result
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
