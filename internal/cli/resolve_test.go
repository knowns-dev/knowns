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
	"github.com/howznguyen/knowns/internal/testutil"
	"github.com/spf13/cobra"
)

func TestRunResolveDefaultOutput(t *testing.T) {
	projectRoot := setupResolveCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	cmd := &cobra.Command{}
	var out bytes.Buffer
	cmd.SetOut(&out)

	if err := runResolve(cmd, []string{"@doc/guides/setup{implements}"}); err != nil {
		t.Fatalf("runResolve returned error: %v", err)
	}

	got := out.String()
	for _, want := range []string{
		"Semantic Reference",
		"Reference: @doc/guides/setup{implements}",
		"Relation: implements",
		"Resolved: true",
		"Entity Type: doc",
		"Path: guides/setup",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got:\n%s", want, got)
		}
	}
}

func TestRunResolvePlainAndJSONOutput(t *testing.T) {
	projectRoot := setupResolveCLIProject(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	plainCmd := &cobra.Command{}
	plainCmd.Flags().Bool("plain", false, "")
	if err := plainCmd.Flags().Set("plain", "true"); err != nil {
		t.Fatalf("set plain flag: %v", err)
	}
	var plainOut bytes.Buffer
	plainCmd.SetOut(&plainOut)

	if err := runResolve(plainCmd, []string{"@task-rag001{blocked-by}"}); err != nil {
		t.Fatalf("runResolve plain returned error: %v", err)
	}
	if got := plainOut.String(); !strings.Contains(got, "Priority: high") || !strings.Contains(got, "Relation: blocked-by") {
		t.Fatalf("unexpected plain output:\n%s", got)
	}

	jsonCmd := &cobra.Command{}
	jsonCmd.Flags().Bool("json", false, "")
	if err := jsonCmd.Flags().Set("json", "true"); err != nil {
		t.Fatalf("set json flag: %v", err)
	}
	var jsonOut bytes.Buffer
	jsonCmd.SetOut(&jsonOut)

	if err := runResolve(jsonCmd, []string{"@memory-mem001"}); err != nil {
		t.Fatalf("runResolve json returned error: %v", err)
	}

	var resolution models.SemanticResolution
	if err := json.Unmarshal(jsonOut.Bytes(), &resolution); err != nil {
		t.Fatalf("unmarshal json output: %v\n%s", err, jsonOut.String())
	}
	if !resolution.Found || resolution.Entity == nil {
		t.Fatal("expected resolved JSON entity")
	}
	if resolution.Reference.Relation != models.SemanticReferenceRelationReferences {
		t.Fatalf("relation = %q", resolution.Reference.Relation)
	}
	if resolution.Entity.Type != "memory" || resolution.Entity.MemoryLayer != models.MemoryLayerProject {
		t.Fatalf("unexpected JSON entity: %+v", resolution.Entity)
	}
}

func setupResolveCLIProject(t *testing.T) string {
	t.Helper()
	testutil.TempHome(t)

	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("resolve-cli-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:      "guides/setup",
		Title:     "Setup Guide",
		Tags:      []string{"guide"},
		Content:   "Body",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:        "rag001",
		Title:     "Implement runtime",
		Status:    "in-progress",
		Priority:  "high",
		Labels:    []string{"semantic", "cli"},
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{
		ID:        "mem001",
		Title:     "Semantic note",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Tags:      []string{"semantic"},
		Content:   "Remember this.",
		CreatedAt: now,
		UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	return projectRoot
}
