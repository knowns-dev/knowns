package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func newTaskCreateTestCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "create"}
	cmd.Flags().String("description", "", "")
	cmd.Flags().StringArray("ac", nil, "")
	cmd.Flags().String("status", "", "")
	cmd.Flags().String("priority", "", "")
	cmd.Flags().String("assignee", "", "")
	cmd.Flags().StringArray("label", nil, "")
	cmd.Flags().String("parent", "", "")
	cmd.Flags().String("spec", "", "")
	cmd.Flags().StringArray("fulfills", nil, "")
	cmd.Flags().String("plan", "", "")
	cmd.Flags().String("notes", "", "")
	cmd.Flags().String("prefix", "", "")
	return cmd
}

func TestRunTaskCreateUsesDefaultAndCustomPrefixes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectDir := t.TempDir()
	root := filepath.Join(projectDir, ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("task-prefix-cli"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config: %v", err)
	}
	project.Settings.DefaultTaskIDPrefix = "KN"
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save config: %v", err)
	}

	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(projectDir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWD) })

	cmd := newTaskCreateTestCommand()
	if err := runTaskCreate(cmd, []string{"Default prefix"}); err != nil {
		t.Fatalf("runTaskCreate default: %v", err)
	}
	if err := cmd.Flags().Set("prefix", "lab"); err != nil {
		t.Fatalf("set prefix: %v", err)
	}
	if err := runTaskCreate(cmd, []string{"Custom prefix"}); err != nil {
		t.Fatalf("runTaskCreate custom: %v", err)
	}

	tasks, err := store.Tasks.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tasks) != 2 {
		t.Fatalf("created %d tasks, want 2", len(tasks))
	}
	idsByTitle := map[string]string{}
	for _, task := range tasks {
		idsByTitle[task.Title] = task.ID
	}
	if !strings.HasPrefix(idsByTitle["Default prefix"], "KN-") {
		t.Fatalf("default task ID = %q, want KN prefix", idsByTitle["Default prefix"])
	}
	if !strings.HasPrefix(idsByTitle["Custom prefix"], "LAB-") {
		t.Fatalf("custom task ID = %q, want LAB prefix", idsByTitle["Custom prefix"])
	}

	// The one-off prefix must not leak into project settings.
	reloaded, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Reload config: %v", err)
	}
	if reloaded.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("custom prefix mutated project default to %q", reloaded.Settings.DefaultTaskIDPrefix)
	}

	if err := cmd.Flags().Set("prefix", "1bad"); err != nil {
		t.Fatalf("set invalid prefix: %v", err)
	}
	if err := runTaskCreate(cmd, []string{"Invalid prefix"}); err == nil {
		t.Fatal("runTaskCreate invalid prefix succeeded")
	}
	after, err := store.Tasks.List()
	if err != nil {
		t.Fatalf("List after invalid prefix: %v", err)
	}
	if len(after) != len(tasks) {
		t.Fatalf("invalid prefix created a task: before=%d after=%d", len(tasks), len(after))
	}
}

func TestRunTaskCreateFallsBackToLegacyIDsWithoutPrefix(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectDir := t.TempDir()
	store := storage.NewStore(filepath.Join(projectDir, ".knowns"))
	if err := store.Init("task-legacy-cli"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	if err := os.Chdir(projectDir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWD) })

	if err := runTaskCreate(newTaskCreateTestCommand(), []string{"Legacy id"}); err != nil {
		t.Fatalf("runTaskCreate: %v", err)
	}
	tasks, err := store.Tasks.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("created %d tasks, want 1", len(tasks))
	}
	if id := tasks[0].ID; len(id) != 6 || strings.Contains(id, "-") {
		t.Fatalf("task ID = %q, want legacy six-character base36 format", id)
	}
}
