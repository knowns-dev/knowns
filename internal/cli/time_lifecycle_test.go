package cli

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
)

func TestTimeCLIRejectsStaleExpectedHashWithoutSideEffects(t *testing.T) {
	root := t.TempDir()
	t.Chdir(root)
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	if err := store.Init("cli-time-occ"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := store.Tasks.Create(&models.Task{ID: "cli-time-occ", Title: "secret CLI title", Description: "secret description", Status: "todo", Priority: "medium", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	base, err := store.Tasks.Get("cli-time-occ")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tasklifecycle.New(store).UpdateTask(t.Context(), base.ID, tasklifecycle.TaskUpdateOptions{ExpectedHash: base.CanonicalHash, Mutate: func(task *models.Task) error { task.Title = "changed"; return nil }}); err != nil {
		t.Fatal(err)
	}
	historyBefore, _ := store.Versions.GetHistory(base.ID)
	if err := timeAddCmd.Flags().Set("expected-hash", base.CanonicalHash); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = timeAddCmd.Flags().Set("expected-hash", "")
		_ = timeStopCmd.Flags().Set("expected-hash", "")
	})
	err = runTimeAdd(timeAddCmd, []string{base.ID, "30s"})
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("stale CLI add error = %v", err)
	}
	entries, _ := store.Time.GetEntries(base.ID)
	historyAfter, _ := store.Versions.GetHistory(base.ID)
	if len(entries) != 0 || len(historyAfter.Versions) != len(historyBefore.Versions) {
		t.Fatalf("stale CLI add side effects: entries=%#v history=%d/%d", entries, len(historyAfter.Versions), len(historyBefore.Versions))
	}
	if err := store.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{{TaskID: base.ID, StartedAt: now.Add(-time.Minute).Format(time.RFC3339Nano)}}}); err != nil {
		t.Fatal(err)
	}
	if err := timeStopCmd.Flags().Set("expected-hash", base.CanonicalHash); err != nil {
		t.Fatal(err)
	}
	err = runTimeStop(timeStopCmd, []string{base.ID})
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("stale CLI stop error = %v", err)
	}
	state, _ := store.Time.GetState()
	entries, _ = store.Time.GetEntries(base.ID)
	if len(state.Active) != 1 || len(entries) != 0 {
		t.Fatalf("stale CLI stop side effects: state=%#v entries=%#v", state, entries)
	}
}
