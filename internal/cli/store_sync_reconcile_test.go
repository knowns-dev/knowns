package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/testutil"
)

// A Doc that arrives through store sync is recorded in local history and
// queued for reindexing without a manual reindex (FR-20).
func TestSyncedDocIsReconciledAndQueuedForIndexing(t *testing.T) {
	runtimequeue.SetTestBypass(true)
	defer runtimequeue.SetTestBypass(false)
	testutil.TempHome(t)
	ctx := context.Background()

	// The file as another machine wrote it.
	origin := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := origin.Init("origin"); err != nil {
		t.Fatal(err)
	}
	if err := origin.MutateDocWithHistory(ctx, nil, &models.Doc{Path: "arrived", Title: "Arrived", Content: "# From a teammate"}, storage.DocMutationOptions{}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(origin.Root, "docs", "arrived.md"))
	if err != nil {
		t.Fatal(err)
	}

	// This machine's store folder receives it through a fetch.
	local := storage.NewStore(filepath.Join(t.TempDir(), "stores", "team", "shop-web"))
	if err := local.Init("shop-web"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(local.Root, "docs", "arrived.md"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	reconcileSynced(ctx, local.Root, []string{"docs/arrived.md", "config.json"})

	history, err := local.Versions.GetDocHistory("arrived")
	if err != nil || history == nil || len(history.Versions) == 0 {
		t.Fatalf("the synced Doc should have local history, got %+v, %v", history, err)
	}
	queue, err := runtimequeue.LoadQueue(local.Root)
	if err != nil {
		t.Fatal(err)
	}
	queued := false
	var kinds []string
	for _, job := range queue.Jobs {
		kinds = append(kinds, string(job.Kind)+":"+job.Target)
		// Either backend's route counts: a local index job, or a Qdrant
		// lifecycle intent for this Doc.
		if job.Kind == runtimequeue.JobIndexDoc && job.Target == "arrived" {
			queued = true
		}
		if job.Kind == runtimequeue.JobQdrantReconcile && job.Intent != nil && job.Intent.EntityType == "doc" && strings.Contains(job.Intent.Path, "arrived") {
			queued = true
		}
	}
	if !queued {
		t.Fatalf("the synced Doc should be queued for indexing, queue: %v", kinds)
	}
}
