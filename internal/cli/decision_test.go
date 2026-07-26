package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/decisionmigration"
	"github.com/howznguyen/knowns/internal/decisionreview"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func TestRunDecisionLifecycleCommands(t *testing.T) {
	projectRoot := setupEmptyDecisionCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	createDraft := newDecisionCreateTestCmd()
	if err := createDraft.Flags().Set("decision", "Record cache audit timestamps before pruning stale entries."); err != nil {
		t.Fatalf("set decision: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionCreate(createDraft, []string{"Store", "audit", "timestamps", "for", "cache", "pruning"}); err != nil {
			t.Fatalf("runDecisionCreate draft: %v", err)
		}
	})

	createAccepted := newDecisionCreateTestCmd()
	if err := createAccepted.Flags().Set("source", "https://example.com/vector-spec"); err != nil {
		t.Fatalf("set source: %v", err)
	}
	if err := createAccepted.Flags().Set("task", "verify1"); err != nil {
		t.Fatalf("set task: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionCreate(createAccepted, []string{"Accepted", "decision"}); err != nil {
			t.Fatalf("runDecisionCreate accepted: %v", err)
		}
	})

	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	entries, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("len(entries) = %d, want 2", len(entries))
	}
	var draft, accepted *models.DecisionEntry
	for _, entry := range entries {
		switch entry.Title {
		case "Store audit timestamps for cache pruning":
			draft = entry
		case "Accepted decision":
			accepted = entry
		}
	}
	if draft == nil || accepted == nil {
		t.Fatalf("missing created decisions: %+v", entries)
	}
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draft.Status)
	}
	if accepted.Status != models.DecisionStatusDraft {
		t.Fatalf("linked decision status = %q, want draft", accepted.Status)
	}
	if err := store.Tasks.Create(&models.Task{
		ID: "verify1", Title: "Verify decision", Status: "done", Priority: "medium", Labels: []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Verified", Completed: true}},
	}); err != nil {
		t.Fatalf("create verification task: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionAccept(newDecisionAcceptTestCmd(), []string{accepted.ID}); err != nil {
			t.Fatalf("runDecisionAccept: %v", err)
		}
	})
	accepted, err = store.Decisions.Get(accepted.ID)
	if err != nil || accepted.Status != models.DecisionStatusAccepted || accepted.VerifiedAt == nil {
		t.Fatalf("accepted decision = %+v, err=%v", accepted, err)
	}

	duplicateCmd := newDecisionCreateTestCmd()
	if err := duplicateCmd.Flags().Set("json", "true"); err != nil {
		t.Fatalf("set json: %v", err)
	}
	if err := duplicateCmd.Flags().Set("source", "https://example.com/vector-spec-v2"); err != nil {
		t.Fatalf("set duplicate source: %v", err)
	}
	if err := duplicateCmd.Flags().Set("task", "verify1"); err != nil {
		t.Fatalf("set duplicate task: %v", err)
	}
	reviewOutput := captureMemoryStdout(t, func() {
		if err := runDecisionCreate(duplicateCmd, []string{"Accepted", "decision"}); err != nil {
			t.Fatalf("runDecisionCreate duplicate: %v", err)
		}
	})
	var reviewResult decisionreview.Result
	if err := json.Unmarshal([]byte(reviewOutput), &reviewResult); err != nil {
		t.Fatalf("unmarshal review result: %v\n%s", err, reviewOutput)
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
	inboxCmd := &cobra.Command{}
	inboxCmd.Flags().Bool("json", true, "")
	inboxCmd.Flags().Bool("plain", false, "")
	inboxOutput := captureMemoryStdout(t, func() {
		if err := runDecisionInbox(inboxCmd, nil); err != nil {
			t.Fatalf("runDecisionInbox: %v", err)
		}
	})
	var inbox []models.DecisionEntry
	if err := json.Unmarshal([]byte(inboxOutput), &inbox); err != nil {
		t.Fatalf("unmarshal inbox: %v\n%s", err, inboxOutput)
	}
	if len(inbox) == 0 {
		t.Fatal("Decision inbox is empty after persisted candidate creation")
	}
	resolveCmd := newDecisionResolveTestCmd()
	resolveOutput := captureMemoryStdout(t, func() {
		if err := runDecisionResolve(resolveCmd, []string{decisionreview.ResolutionRejectNew, reviewResult.Candidate.ID}); err != nil {
			t.Fatalf("runDecisionResolve: %v", err)
		}
	})
	if resolveOutput == "" {
		t.Fatal("resolve output is empty")
	}
	entriesAfterResolve, err := store.Decisions.List()
	if err != nil || len(entriesAfterResolve) != 3 {
		t.Fatalf("resolved entries = %d, err=%v", len(entriesAfterResolve), err)
	}
	resolvedCandidate, err := store.Decisions.Get(reviewResult.Candidate.ID)
	if err != nil || resolvedCandidate.Status != models.DecisionStatusRejected {
		t.Fatalf("resolved candidate = %+v err=%v", resolvedCandidate, err)
	}

	listCmd := newDecisionListTestCmd()
	if err := listCmd.Flags().Set("json", "true"); err != nil {
		t.Fatalf("set json: %v", err)
	}
	output := captureMemoryStdout(t, func() {
		if err := runDecisionList(listCmd, nil); err != nil {
			t.Fatalf("runDecisionList: %v", err)
		}
	})
	var listed []models.DecisionEntry
	if err := json.Unmarshal([]byte(output), &listed); err != nil {
		t.Fatalf("unmarshal list: %v\n%s", err, output)
	}
	if len(listed) != 1 || listed[0].ID != accepted.ID {
		t.Fatalf("default list = %+v, want only accepted current %s", listed, accepted.ID)
	}

	linkCmd := newDecisionLinkTestCmd()
	if err := linkCmd.Flags().Set("source", "https://example.com/draft-spec"); err != nil {
		t.Fatalf("set source: %v", err)
	}
	if err := linkCmd.Flags().Set("task", "verify1"); err != nil {
		t.Fatalf("set task: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionLink(linkCmd, []string{draft.ID}); err != nil {
			t.Fatalf("runDecisionLink: %v", err)
		}
	})
	linked, err := store.Decisions.Get(draft.ID)
	if err != nil {
		t.Fatalf("get linked: %v", err)
	}
	if linked.Status != models.DecisionStatusDraft || len(linked.RelatedTasks) != 1 {
		t.Fatalf("linked decision = %+v", linked)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionAccept(newDecisionAcceptTestCmd(), []string{linked.ID}); err != nil {
			t.Fatalf("accept linked decision: %v", err)
		}
	})

	captureMemoryStdout(t, func() {
		if err := runDecisionSupersede(&cobra.Command{}, []string{linked.ID, accepted.ID}); err != nil {
			t.Fatalf("runDecisionSupersede: %v", err)
		}
	})
	superseded, err := store.Decisions.Get(linked.ID)
	if err != nil {
		t.Fatalf("get superseded: %v", err)
	}
	if superseded.Status != models.DecisionStatusSuperseded || len(superseded.SupersededBy) != 1 || superseded.SupersededBy[0] != accepted.ID {
		t.Fatalf("superseded decision = %+v", superseded)
	}
}

func TestRunDecisionMigrationCommands(t *testing.T) {
	projectRoot := setupEmptyDecisionCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)
	memoryID := "legacy1"
	memoryPath := filepath.Join(projectRoot, ".knowns", "memory", models.MemoryFileName(memoryID))
	raw := "---\nid: legacy1\ntitle: Legacy CLI decision\nlayer: project\ncategory: decision\nstatus: active\nsources: []\ntags: []\ncreatedAt: '2026-07-23T10:00:00Z'\nupdatedAt: '2026-07-23T10:00:00Z'\n---\n\nUse first-class System Decisions.\n"
	if err := os.WriteFile(memoryPath, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}

	previewCmd := &cobra.Command{}
	previewCmd.Flags().Bool("json", true, "")
	previewOutput := captureMemoryStdout(t, func() {
		if err := runDecisionMigrationPreview(previewCmd, nil); err != nil {
			t.Fatalf("preview: %v", err)
		}
	})
	var preview decisionmigration.PreviewReport
	if err := json.Unmarshal([]byte(previewOutput), &preview); err != nil || preview.Counts.Total != 1 {
		t.Fatalf("preview = %+v err=%v output=%s", preview, err, previewOutput)
	}
	afterPreview, _ := os.ReadFile(memoryPath)
	if string(afterPreview) != raw {
		t.Fatal("migration preview mutated legacy memory")
	}

	applyCmd := newDecisionMigrationApplyTestCmd()
	_ = applyCmd.Flags().Set("memory", memoryID)
	_ = applyCmd.Flags().Set("resolution", decisionmigration.ResolutionCreateDecision)
	_ = applyCmd.Flags().Set("json", "true")
	applyOutput := captureMemoryStdout(t, func() {
		if err := runDecisionMigrationApply(applyCmd, nil); err != nil {
			t.Fatalf("apply: %v", err)
		}
	})
	var applied decisionmigration.ApplyResult
	if err := json.Unmarshal([]byte(applyOutput), &applied); err != nil || len(applied.Results) != 1 || applied.Results[0].DecisionID == "" {
		t.Fatalf("apply = %+v err=%v output=%s", applied, err, applyOutput)
	}
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	decision, err := store.Decisions.Get(applied.Results[0].DecisionID)
	if err != nil || decision.Status != models.DecisionStatusDraft {
		t.Fatalf("migrated decision = %+v err=%v", decision, err)
	}
	legacy, _ := store.Memory.Get(memoryID)
	if !legacy.CurrentForDefaultRetrieval() {
		t.Fatalf("draft migration hid legacy memory: %+v", legacy)
	}

	rollbackCmd := &cobra.Command{}
	rollbackCmd.Flags().Bool("json", true, "")
	rollbackOutput := captureMemoryStdout(t, func() {
		if err := runDecisionMigrationRollback(rollbackCmd, []string{memoryID}); err != nil {
			t.Fatalf("rollback: %v", err)
		}
	})
	var rolledBack decisionmigration.RollbackResult
	if err := json.Unmarshal([]byte(rollbackOutput), &rolledBack); err != nil || rolledBack.State != decisionmigration.JournalRolledBack {
		t.Fatalf("rollback = %+v err=%v", rolledBack, err)
	}
}

func newDecisionCreateTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("status", "", "")
	cmd.Flags().StringArrayP("tag", "t", nil, "")
	cmd.Flags().StringArray("source", nil, "")
	cmd.Flags().StringArray("doc", nil, "")
	cmd.Flags().StringArray("task", nil, "")
	cmd.Flags().String("body", "", "")
	cmd.Flags().String("context", "", "")
	cmd.Flags().String("decision", "", "")
	cmd.Flags().String("alternatives", "", "")
	cmd.Flags().String("consequences", "", "")
	cmd.Flags().Bool("json", false, "")
	cmd.Flags().Bool("plain", false, "")
	return cmd
}

func newDecisionListTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("status", "", "")
	cmd.Flags().Bool("all-statuses", false, "")
	cmd.Flags().String("tag", "", "")
	cmd.Flags().Bool("json", false, "")
	cmd.Flags().Bool("plain", false, "")
	return cmd
}

func newDecisionLinkTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().StringArray("doc", nil, "")
	cmd.Flags().StringArray("task", nil, "")
	cmd.Flags().StringArray("source", nil, "")
	cmd.Flags().Bool("json", false, "")
	return cmd
}

func newDecisionAcceptTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().StringArray("supersede", nil, "")
	cmd.Flags().Bool("json", false, "")
	return cmd
}

func newDecisionResolveTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("target", "", "")
	cmd.Flags().String("replacement-id", "", "")
	cmd.Flags().Bool("json", false, "")
	cmd.Flags().Bool("plain", false, "")
	return cmd
}

func newDecisionMigrationApplyTestCmd() *cobra.Command {
	cmd := &cobra.Command{}
	cmd.Flags().String("memory", "", "")
	cmd.Flags().String("resolution", "", "")
	cmd.Flags().String("decision-id", "", "")
	cmd.Flags().String("target-memory", "", "")
	cmd.Flags().String("category", "", "")
	cmd.Flags().String("reason", "", "")
	cmd.Flags().StringArray("doc", nil, "")
	cmd.Flags().StringArray("task", nil, "")
	cmd.Flags().Bool("accept-verified", false, "")
	cmd.Flags().Bool("json", false, "")
	return cmd
}

func setupEmptyDecisionCLIProject(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("decision-cli-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return projectRoot
}
