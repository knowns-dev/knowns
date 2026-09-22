package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func newMigrateCmd(t *testing.T, write bool, allStatuses bool) *cobra.Command {
	t.Helper()
	cmd := &cobra.Command{}
	cmd.Flags().Bool("write", false, "")
	cmd.Flags().String("layer", "", "")
	cmd.Flags().Bool("all-statuses", false, "")
	cmd.Flags().Bool("plain", false, "")
	cmd.Flags().Bool("json", false, "")
	cmd.Flags().Int("page", 0, "")
	cmd.Flags().Int("page-size", 0, "")
	if write {
		_ = cmd.Flags().Set("write", "true")
	}
	if allStatuses {
		_ = cmd.Flags().Set("all-statuses", "true")
	}
	return cmd
}

func seedMigrateStore(t *testing.T) (string, *storage.Store) {
	t.Helper()
	projectRoot := setupEmptyMemoryCLIProject(t)
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	now := time.Now().UTC().Add(-72 * time.Hour)
	seed := []struct {
		id      string
		content string
	}{
		{"guessed", "The point.\n\nThe evidence behind it."},
		{"whole", "Nothing to split here."},
		{"marked", "Already chosen.\n" + models.MemoryDetailMarker + "\nThe rest."},
	}
	for _, s := range seed {
		entry := &models.MemoryEntry{
			ID: s.id, Title: "Memory " + s.id, Layer: models.MemoryLayerProject,
			Category: "pattern", Content: s.content, Status: models.MemoryStatusActive,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create %s: %v", s.id, err)
		}
	}
	return projectRoot, store
}

func TestMemoryMigratePreviewWritesNothing(t *testing.T) {
	projectRoot, store := seedMigrateStore(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	out := captureMemoryStdout(t, func() {
		if err := runMemoryMigrate(newMigrateCmd(t, false, false), nil); err != nil {
			t.Fatalf("preview: %v", err)
		}
	})
	if !strings.Contains(out, "guessed") {
		t.Fatalf("preview should list the guessed entry, got %q", out)
	}
	// Only the guessed one. A single-paragraph body has nothing to split and an
	// already-marked one has nothing to decide.
	if strings.Contains(out, "MEMORY: whole") || strings.Contains(out, "MEMORY: marked") {
		t.Fatalf("preview listed an entry that needs no marker: %q", out)
	}
	if !strings.Contains(out, "Nothing was written") {
		t.Fatalf("preview must say it wrote nothing, got %q", out)
	}
	entry, err := store.Memory.Get("guessed")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if strings.Contains(entry.Content, models.MemoryDetailMarker) {
		t.Fatal("preview modified the store")
	}
}

func TestMemoryMigrateWriteFreezesBoundaryAndIsIdempotent(t *testing.T) {
	projectRoot, store := seedMigrateStore(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	before, err := store.Memory.Get("guessed")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	claimBefore, _ := models.MemoryClaim(before.Content)
	updatedBefore := before.UpdatedAt

	captureMemoryStdout(t, func() {
		if err := runMemoryMigrate(newMigrateCmd(t, true, false), nil); err != nil {
			t.Fatalf("write: %v", err)
		}
	})

	after, err := store.Memory.Get("guessed")
	if err != nil {
		t.Fatalf("get after: %v", err)
	}
	if !strings.Contains(after.Content, models.MemoryDetailMarker) {
		t.Fatal("write did not insert the marker")
	}
	claimAfter, _ := models.MemoryClaim(after.Content)
	if claimAfter != claimBefore {
		t.Fatalf("migration changed the injected claim: %q -> %q", claimBefore, claimAfter)
	}
	// A reformat must not make a memory look freshly verified: UpdatedAt feeds
	// the recency bonus, so bumping it reorders retrieval as a side effect.
	if !after.UpdatedAt.Equal(updatedBefore) {
		t.Fatalf("migration moved UpdatedAt: %v -> %v", updatedBefore, after.UpdatedAt)
	}
	// And retrieval must see the same text it saw before.
	if got := models.StripMemoryDetailMarker(after.Content); got != before.Content {
		t.Fatalf("indexable content changed: %q -> %q", before.Content, got)
	}

	out := captureMemoryStdout(t, func() {
		if err := runMemoryMigrate(newMigrateCmd(t, false, false), nil); err != nil {
			t.Fatalf("second preview: %v", err)
		}
	})
	if !strings.Contains(out, "No memories are guessing") {
		t.Fatalf("re-preview should be empty, got %q", out)
	}
}

func TestMemoryMigrateRejectsAnUnknownLayer(t *testing.T) {
	projectRoot, _ := seedMigrateStore(t)
	origDir, _ := os.Getwd()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	defer os.Chdir(origDir)

	cmd := newMigrateCmd(t, false, false)
	_ = cmd.Flags().Set("layer", "nonsense")
	if err := runMemoryMigrate(cmd, nil); err == nil {
		t.Fatal("expected an invalid layer to be refused")
	}
}
