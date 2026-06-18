package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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
	if err := createDraft.Flags().Set("decision", "Use Qdrant."); err != nil {
		t.Fatalf("set decision: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runDecisionCreate(createDraft, []string{"Draft", "decision"}); err != nil {
			t.Fatalf("runDecisionCreate draft: %v", err)
		}
	})

	createAccepted := newDecisionCreateTestCmd()
	if err := createAccepted.Flags().Set("source", "@doc/specs/vector"); err != nil {
		t.Fatalf("set source: %v", err)
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
		case "Draft decision":
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
	if accepted.Status != models.DecisionStatusAccepted {
		t.Fatalf("accepted status = %q, want accepted", accepted.Status)
	}

	duplicateCmd := newDecisionCreateTestCmd()
	if err := duplicateCmd.Flags().Set("json", "true"); err != nil {
		t.Fatalf("set json: %v", err)
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
	if len(entriesAfterReview) != 2 {
		t.Fatalf("len(entriesAfterReview) = %d, want no-write count 2", len(entriesAfterReview))
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
	if err := linkCmd.Flags().Set("doc", "specs/vector"); err != nil {
		t.Fatalf("set doc: %v", err)
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
	if linked.Status != models.DecisionStatusAccepted || len(linked.RelatedDocs) != 1 {
		t.Fatalf("linked decision = %+v", linked)
	}

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
