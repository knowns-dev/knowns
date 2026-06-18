package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func TestRunMemoryCreateWritesProposedAndListHidesByDefault(t *testing.T) {
	projectRoot := setupEmptyMemoryCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	createCmd := &cobra.Command{}
	createCmd.Flags().String("layer", "", "")
	createCmd.Flags().String("category", "", "")
	createCmd.Flags().StringArrayP("tag", "t", nil, "")
	createCmd.Flags().StringP("content", "c", "", "")
	createCmd.Flags().String("status", "", "")
	createCmd.Flags().Bool("create-anyway", false, "")
	if err := createCmd.Flags().Set("category", "decision"); err != nil {
		t.Fatalf("set category: %v", err)
	}
	if err := createCmd.Flags().Set("content", "Use proposed status for CLI-created memories."); err != nil {
		t.Fatalf("set content: %v", err)
	}
	captureMemoryStdout(t, func() {
		if err := runMemoryCreate(createCmd, []string{"CLI", "review", "memory"}); err != nil {
			t.Fatalf("runMemoryCreate: %v", err)
		}
	})

	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	entries, err := store.Memory.ListPersistent(models.MemoryLayerProject)
	if err != nil {
		t.Fatalf("list persistent: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if entries[0].Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entries[0].Status)
	}

	listCmd := &cobra.Command{}
	listCmd.Flags().String("layer", "", "")
	listCmd.Flags().String("category", "", "")
	listCmd.Flags().String("tag", "", "")
	listCmd.Flags().String("status", "", "")
	listCmd.Flags().Bool("all-statuses", false, "")
	listCmd.Flags().Bool("json", false, "")
	if err := listCmd.Flags().Set("json", "true"); err != nil {
		t.Fatalf("set json: %v", err)
	}
	output := captureMemoryStdout(t, func() {
		if err := runMemoryList(listCmd, nil); err != nil {
			t.Fatalf("runMemoryList: %v", err)
		}
	})
	var listed []models.MemoryEntry
	if err := json.Unmarshal([]byte(output), &listed); err != nil {
		t.Fatalf("unmarshal list output: %v\n%s", err, output)
	}
	if len(listed) != 0 {
		t.Fatalf("default list should exclude proposed memory, got %+v", listed)
	}
}

func TestRunMemoryCleanupPlain(t *testing.T) {
	projectRoot := setupMemoryCleanupCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	cmd := &cobra.Command{}
	cmd.Flags().Int("older-than", 7, "")
	cmd.Flags().String("layer", models.MemoryLayerProject, "")
	cmd.Flags().Int("limit", 20, "")
	cmd.Flags().Bool("plain", false, "")
	if err := cmd.Flags().Set("plain", "true"); err != nil {
		t.Fatalf("set plain: %v", err)
	}
	var out bytes.Buffer
	cmd.SetOut(&out)
	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w

	if err := runMemoryCleanup(cmd, nil); err != nil {
		os.Stdout = origStdout
		_ = w.Close()
		t.Fatalf("runMemoryCleanup returned error: %v", err)
	}
	_ = w.Close()
	os.Stdout = origStdout
	_, _ = out.ReadFrom(r)
	got := out.String()
	for _, want := range []string{"MEMORY: stale1", "TITLE: Stale Memory", "AGE_DAYS:", "CONTENT:", "stale content"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got:\n%s", want, got)
		}
	}
	if strings.Contains(got, "fresh1") {
		t.Fatalf("expected fresh memory to be excluded, got:\n%s", got)
	}
}

func setupMemoryCleanupCLIProject(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("memory-cleanup-cli-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "stale1",
		Title:     "Stale Memory",
		Layer:     models.MemoryLayerProject,
		Content:   "stale content",
		CreatedAt: now.AddDate(0, 0, -9),
		UpdatedAt: now.AddDate(0, 0, -9),
	}); err != nil {
		t.Fatalf("create stale memory: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "fresh1",
		Title:     "Fresh Memory",
		Layer:     models.MemoryLayerProject,
		Content:   "fresh content",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create fresh memory: %v", err)
	}
	return projectRoot
}

func setupEmptyMemoryCLIProject(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("memory-cli-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return projectRoot
}

func captureMemoryStdout(t *testing.T, fn func()) string {
	t.Helper()
	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = origStdout
	var out bytes.Buffer
	_, _ = out.ReadFrom(r)
	return out.String()
}
