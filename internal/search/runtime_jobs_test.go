package search

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
)

func TestExecuteRuntimeJobReusesSemanticRuntimeProvider(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() {
		defaultSemanticRuntime = oldRuntime
		rt.Close()
	}()

	if err := ExecuteRuntimeJob(store.Root, runtimequeue.Job{Kind: runtimequeue.JobRemoveTask, Target: "task-a"}); err != nil {
		t.Fatalf("remove task job: %v", err)
	}
	if err := ExecuteRuntimeJob(store.Root, runtimequeue.Job{Kind: runtimequeue.JobRemoveDecision, Target: "decision-a"}); err != nil {
		t.Fatalf("remove decision job: %v", err)
	}
	if openCount != 1 {
		t.Fatalf("openCount = %d, want 1 shared cached provider", openCount)
	}
}

func TestExecuteRuntimeJobCodeFileJobsDoNotOpenSemanticRuntime(t *testing.T) {
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() {
		defaultSemanticRuntime = oldRuntime
		rt.Close()
	}()

	for _, kind := range []runtimequeue.JobKind{
		runtimequeue.JobIndexFile,
		runtimequeue.JobRemoveFile,
		runtimequeue.JobIndexAll,
	} {
		if err := ExecuteRuntimeJob(store.Root, runtimequeue.Job{Kind: kind, Target: "main.go"}); err != nil {
			t.Fatalf("%s job: %v", kind, err)
		}
	}
	if openCount != 0 {
		t.Fatalf("openCount = %d, want 0 for code-file jobs", openCount)
	}
}

func TestExecuteRuntimeJobSemanticSearchReturnsPayload(t *testing.T) {
	runtimequeue.SetTestBypass(true)
	t.Cleanup(func() { runtimequeue.SetTestBypass(false) })
	store := newSemanticRuntimeTestStore(t, "gte-small", 384)
	if err := store.Docs.Create(&models.Doc{
		Path:    "runtime/owner",
		Title:   "Runtime Owner",
		Content: "semantic runtime owner",
	}); err != nil {
		t.Fatalf("create doc: %v", err)
	}
	seedSemanticRuntimeJobIndex(t, store.Root)
	openCount := 0
	rt := NewSemanticRuntime(SemanticRuntimeOptions{
		IdleTimeout: time.Hour,
		openEmbedder: func(cfg semanticRuntimeConfig) (EmbedderProvider, error) {
			openCount++
			return &countingEmbedder{dimensions: cfg.dimensions}, nil
		},
	})
	oldRuntime := defaultSemanticRuntime
	defaultSemanticRuntime = rt
	defer func() {
		defaultSemanticRuntime = oldRuntime
		rt.Close()
	}()

	requestID, err := writeSemanticSearchRuntimeRequest(semanticSearchRuntimeRequest{
		Options: SearchOptions{Query: "runtime owner", Mode: string(ModeHybrid), Limit: 5},
	})
	if err != nil {
		t.Fatalf("write semantic request: %v", err)
	}
	defer os.Remove(semanticSearchRuntimeRequestPath(requestID))
	job, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobSemanticSearch, requestID)
	if err != nil {
		t.Fatalf("enqueue semantic search: %v", err)
	}
	if err := ExecuteRuntimeJob(store.Root, job); err != nil {
		t.Fatalf("execute semantic search job: %v", err)
	}
	snapshot, err := runtimequeue.LoadJobSnapshot(store.Root, job.ID)
	if err != nil {
		t.Fatalf("load semantic search job snapshot: %v", err)
	}
	if snapshot.Job == nil {
		t.Fatalf("semantic search job snapshot missing job")
	}
	if err := runtimequeue.CompleteJob(store.Root, *snapshot.Job, nil); err != nil {
		t.Fatalf("complete semantic search job: %v", err)
	}
	result, err := runtimequeue.WaitForJob(store.Root, job.ID, time.Second)
	if err != nil {
		t.Fatalf("wait semantic search job: %v", err)
	}
	if result.Details == nil || len(result.Details.Result) == 0 {
		t.Fatalf("missing semantic search result payload: %+v", result.Details)
	}
	if openCount != 1 {
		t.Fatalf("openCount = %d, want 1 daemon-owned provider", openCount)
	}
}

func seedSemanticRuntimeJobIndex(t *testing.T, storeRoot string) {
	t.Helper()
	vecStore := NewSQLiteVectorStore(filepath.Join(storeRoot, ".search"), "gte-small", 384)
	if err := vecStore.Load(); err != nil {
		t.Fatalf("load vector store: %v", err)
	}
	defer vecStore.Close()
	embedding := make([]float32, 384)
	embedding[0] = 1
	vecStore.AddChunks([]Chunk{{
		ID:         "doc:runtime/owner:chunk:1",
		Type:       ChunkTypeDoc,
		Content:    "semantic runtime owner",
		TokenCount: 3,
		Embedding:  embedding,
		DocPath:    "runtime/owner",
		Position:   1,
	}})
	if err := vecStore.Save(); err != nil {
		t.Fatalf("save vector store: %v", err)
	}
}
