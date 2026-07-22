package search

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestTaskLifecycleKeywordVisibilityAndHistoricalMetadata(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	engine := NewEngine(store, nil, nil)

	for _, backend := range []string{lexicalBackendBM25, lexicalBackendHeuristic} {
		human, err := SearchWithLexicalBackend(store, backend, "lifecycle context needle", SearchOptions{Type: "task", Limit: 10})
		if err != nil {
			t.Fatalf("human %s search: %v", backend, err)
		}
		if !resultIDsEqual(human, []string{"act001", "done01"}) {
			t.Fatalf("human %s Task results = %+v, want active and done", backend, human)
		}

		ai, err := SearchWithLexicalBackend(store, backend, "lifecycle context needle", SearchOptions{
			Type:    "task",
			Limit:   10,
			Purpose: SearchPurposeAIRetrieval,
		})
		if err != nil {
			t.Fatalf("AI %s search: %v", backend, err)
		}
		assertTaskResultIDs(t, ai, []string{"act001"})
	}

	response, err := engine.Retrieve(models.RetrievalOptions{
		Query:       "lifecycle context needle",
		Mode:        string(ModeKeyword),
		SourceTypes: []string{"task"},
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("default Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, response.Candidates, []string{"act001"})
	if len(response.ContextPack.Items) != 1 || response.ContextPack.Items[0].ID != "act001" {
		t.Fatalf("default context pack leaked historical Tasks: %+v", response.ContextPack.Items)
	}

	historicalSearch, err := engine.Search(SearchOptions{
		Query:             "lifecycle context needle",
		Type:              "task",
		Mode:              string(ModeKeyword),
		IncludeHistorical: true,
		Limit:             10,
	})
	if err != nil {
		t.Fatalf("historical human Search: %v", err)
	}
	assertTaskResultIDs(t, historicalSearch, []string{"act001", "done01", "arch01"})
	for index, result := range historicalSearch {
		if result.LifecycleState == "" || (index > 0 && result.CompletedAt == nil) {
			t.Fatalf("historical SearchResult missing lifecycle metadata: %+v", result)
		}
	}

	historical, err := engine.Retrieve(models.RetrievalOptions{
		Query:             "lifecycle context needle",
		Mode:              string(ModeKeyword),
		SourceTypes:       []string{"task"},
		IncludeHistorical: true,
		Limit:             10,
	})
	if err != nil {
		t.Fatalf("historical Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, historical.Candidates, []string{"act001", "done01", "arch01"})
	wantStates := []models.TaskLifecycleState{
		models.TaskLifecycleActive,
		models.TaskLifecycleDone,
		models.TaskLifecycleArchived,
	}
	for index, candidate := range historical.Candidates {
		if candidate.LifecycleState != wantStates[index] || candidate.Metadata.LifecycleState != wantStates[index] {
			t.Fatalf("candidate %d lifecycle metadata = %+v", index, candidate)
		}
		if candidate.CompletedAt == nil && candidate.LifecycleState != models.TaskLifecycleActive {
			t.Fatalf("historical candidate missing completedAt: %+v", candidate)
		}
		if candidate.LifecycleState == models.TaskLifecycleArchived && candidate.ArchivedAt == nil {
			t.Fatalf("archived candidate missing archivedAt: %+v", candidate)
		}
		item := historical.ContextPack.Items[index]
		if item.ID != candidate.ID || item.LifecycleState != candidate.LifecycleState || item.Metadata.LifecycleState != candidate.LifecycleState {
			t.Fatalf("context item lifecycle metadata = %+v, candidate = %+v", item, candidate)
		}
	}

	archived, err := store.Tasks.Get("arch01")
	if err != nil || archived.LifecycleState() != models.TaskLifecycleArchived {
		t.Fatalf("direct archived Task lookup = %+v, err=%v", archived, err)
	}
}

func TestTaskLifecycleSemanticHybridStaleIndexAndReopenVisibility(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	vecStore := &stubVectorStore{chunks: []ScoredChunk{
		{Chunk: Chunk{ID: "task:done01:chunk:description", Type: ChunkTypeTask, TaskID: "done01", Status: "todo"}, Score: 0.99},
		{Chunk: Chunk{ID: "task:ghost1:chunk:description", Type: ChunkTypeTask, TaskID: "ghost1", Status: "todo"}, Score: 0.98},
		{Chunk: Chunk{ID: "task:arch01:chunk:description", Type: ChunkTypeTask, TaskID: "arch01", Status: "todo"}, Score: 0.97},
		{Chunk: Chunk{ID: "task:act001:chunk:description", Type: ChunkTypeTask, TaskID: "act001", Status: "done"}, Score: 0.40},
	}}
	engine := NewEngine(store, stubEmbedder{}, vecStore)

	for _, mode := range []SearchMode{ModeSemantic, ModeHybrid} {
		response, err := engine.Retrieve(models.RetrievalOptions{
			Query:       "lifecycle context needle",
			Mode:        string(mode),
			SourceTypes: []string{"task"},
			Limit:       10,
		})
		if err != nil {
			t.Fatalf("%s Retrieve: %v", mode, err)
		}
		assertTaskCandidateIDs(t, response.Candidates, []string{"act001"})
		for _, item := range response.ContextPack.Items {
			if item.ID == "done01" || item.ID == "arch01" || item.ID == "ghost1" {
				t.Fatalf("%s context pack leaked non-active/stale Task: %+v", mode, item)
			}
		}
	}

	historical, err := engine.Retrieve(models.RetrievalOptions{
		Query:             "lifecycle context needle",
		Mode:              string(ModeSemantic),
		SourceTypes:       []string{"task"},
		IncludeHistorical: true,
		Limit:             10,
	})
	if err != nil {
		t.Fatalf("historical semantic Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, historical.Candidates, []string{"act001", "done01", "arch01"})

	reopenTask(t, store, "done01", false)
	reopenTask(t, store, "arch01", true)
	reopened, err := engine.Retrieve(models.RetrievalOptions{
		Query:       "lifecycle context needle",
		Mode:        string(ModeSemantic),
		SourceTypes: []string{"task"},
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("Retrieve after reopen: %v", err)
	}
	assertTaskCandidateIDs(t, reopened.Candidates, []string{"done01", "arch01", "act001"})
	for _, candidate := range reopened.Candidates {
		if candidate.LifecycleState != models.TaskLifecycleActive {
			t.Fatalf("reopened candidate remains historical: %+v", candidate)
		}
	}
}

func TestTaskLifecycleDoneOverrideRanksByRelevanceUnlessHistorical(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	settings := project.Settings.EffectiveTaskLifecycle()
	settings.ExcludeDoneFromDefaultRetrieval = false
	project.Settings.TaskLifecycle = &settings
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save lifecycle override: %v", err)
	}
	updateTaskSearchText(t, store, "act001", "Background active Task", "ranking override needle appears in active details")
	updateTaskSearchText(t, store, "done01", "Ranking override needle", "exact done result")
	updateTaskSearchText(t, store, "arch01", "Ranking override needle archived", "exact archived result")

	semanticChunks := []ScoredChunk{
		{Chunk: Chunk{ID: "task:done01:chunk:description", Type: ChunkTypeTask, TaskID: "done01"}, Score: 0.99},
		{Chunk: Chunk{ID: "task:arch01:chunk:description", Type: ChunkTypeTask, TaskID: "arch01"}, Score: 0.98},
		{Chunk: Chunk{ID: "task:act001:chunk:description", Type: ChunkTypeTask, TaskID: "act001"}, Score: 0.40},
	}
	for _, mode := range []SearchMode{ModeKeyword, ModeSemantic, ModeHybrid} {
		engine := NewEngine(store, stubEmbedder{}, &stubVectorStore{chunks: semanticChunks})
		response, err := engine.Retrieve(models.RetrievalOptions{
			Query:       "ranking override needle",
			Mode:        string(mode),
			SourceTypes: []string{"task"},
			Limit:       10,
		})
		if err != nil {
			t.Fatalf("%s Retrieve with done override: %v", mode, err)
		}
		assertTaskCandidateIDs(t, response.Candidates, []string{"done01", "act001"})

		historical, err := engine.Retrieve(models.RetrievalOptions{
			Query:             "ranking override needle",
			Mode:              string(mode),
			SourceTypes:       []string{"task"},
			IncludeHistorical: true,
			Limit:             10,
		})
		if err != nil {
			t.Fatalf("historical %s Retrieve with done override: %v", mode, err)
		}
		assertTaskCandidateIDs(t, historical.Candidates, []string{"act001", "done01", "arch01"})
	}
}

func TestTaskLifecycleReferenceExpansionAndContextPackFiltering(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:        "guides/lifecycle-reference-gateway",
		Title:       "Lifecycle Reference Gateway",
		Description: "reference gateway unique",
		Content:     "reference gateway unique links @task/act001{implements}, @task/done01{implements}, and @task/arch01{implements}.",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create reference doc: %v", err)
	}
	engine := NewEngine(store, nil, nil)

	response, err := engine.Retrieve(models.RetrievalOptions{
		Query:            "reference gateway unique",
		Mode:             string(ModeKeyword),
		SourceTypes:      []string{"doc", "task"},
		ExpandReferences: true,
		Limit:            10,
	})
	if err != nil {
		t.Fatalf("default reference Retrieve: %v", err)
	}
	assertExpandedTaskIDs(t, response.Candidates, []string{"act001"})
	for _, item := range response.ContextPack.Items {
		if item.Type == "task" && item.ID != "act001" {
			t.Fatalf("default context pack leaked referenced historical Task: %+v", item)
		}
	}

	historical, err := engine.Retrieve(models.RetrievalOptions{
		Query:             "reference gateway unique",
		Mode:              string(ModeKeyword),
		SourceTypes:       []string{"doc", "task"},
		ExpandReferences:  true,
		IncludeHistorical: true,
		Limit:             10,
	})
	if err != nil {
		t.Fatalf("historical reference Retrieve: %v", err)
	}
	assertExpandedTaskIDs(t, historical.Candidates, []string{"act001", "done01", "arch01"})
}

func TestTaskLifecycleRuntimeKeywordFallbackPreservesAIVisibility(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	t.Setenv("KNOWNS_SEMANTIC_RUNTIME_DISABLED", "1")

	response, runtimeMeta, err := RetrieveWithRuntime(store, models.RetrievalOptions{
		Query:       "lifecycle context needle",
		Mode:        string(ModeHybrid),
		SourceTypes: []string{"task"},
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("runtime fallback Retrieve: %v", err)
	}
	if runtimeMeta == nil || !runtimeMeta.Degraded {
		t.Fatalf("runtime metadata = %+v, want degraded fallback", runtimeMeta)
	}
	assertTaskCandidateIDs(t, response.Candidates, []string{"act001"})
}

func TestRetrieveWithRuntimeUsesOneTaskSnapshotAcrossSearchAndContextAssembly(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	before, err := store.Tasks.Get("act001")
	if err != nil {
		t.Fatalf("get Task before runtime retrieval: %v", err)
	}
	oldTitle := before.Title
	oldDescription := before.Description
	newTitle := "Edited after runtime search"
	newDescription := "new canonical details must not mix into the in-flight response"

	response, runtimeMeta, err := retrieveWithRuntime(store, models.RetrievalOptions{
		Query:       "lifecycle context needle",
		Mode:        string(ModeKeyword),
		SourceTypes: []string{"task"},
		Limit:       10,
	}, func() {
		updateTaskSearchText(t, store, "act001", newTitle, newDescription)
	})
	if err != nil {
		t.Fatalf("RetrieveWithRuntime with edit between phases: %v", err)
	}
	if runtimeMeta != nil {
		t.Fatalf("keyword runtime metadata = %+v, want nil", runtimeMeta)
	}
	assertTaskCandidateIDs(t, response.Candidates, []string{"act001"})
	if candidate := response.Candidates[0]; candidate.Title != oldTitle || strings.Contains(candidate.Snippet, newDescription) {
		t.Fatalf("candidate mixed Task snapshots: %+v", candidate)
	}
	if len(response.ContextPack.Items) != 1 {
		t.Fatalf("context items = %d, want 1", len(response.ContextPack.Items))
	}
	content := response.ContextPack.Items[0].Content
	if !strings.Contains(content, oldTitle) || !strings.Contains(content, oldDescription) || strings.Contains(content, newTitle) || strings.Contains(content, newDescription) {
		t.Fatalf("context content mixed pre/post-edit Task snapshots: %q", content)
	}
	canonical, err := store.Tasks.Get("act001")
	if err != nil {
		t.Fatalf("get Task after runtime retrieval: %v", err)
	}
	if canonical.Title != newTitle || canonical.Description != newDescription {
		t.Fatalf("between-phase edit did not occur: %+v", canonical)
	}
}

func TestTaskLifecycleReindexIncludesArchivedTasksWithoutDefaultLeakage(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	vecStore := &recordingVectorStore{hashes: map[string]string{}}
	indexer := NewIndexService(store, stubEmbedder{}, vecStore)
	if err := indexer.Reindex(nil); err != nil {
		t.Fatalf("Reindex: %v", err)
	}

	for _, id := range []string{"act001", "done01", "arch01"} {
		if vecStore.GetContentHash("task:"+id) == "" {
			t.Fatalf("reindex missing Task hash for %s: %+v", id, vecStore.ListContentHashes())
		}
		found := false
		for _, chunk := range vecStore.chunks {
			if chunk.Type == ChunkTypeTask && chunk.TaskID == id {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("reindex missing Task chunks for %s", id)
		}
	}

	scored := make([]ScoredChunk, 0, len(vecStore.chunks))
	for _, chunk := range vecStore.chunks {
		scored = append(scored, ScoredChunk{Chunk: chunk, Score: 0.9})
	}
	engine := NewEngine(store, stubEmbedder{}, &stubVectorStore{chunks: scored})
	response, err := engine.Retrieve(models.RetrievalOptions{
		Query:       "lifecycle context needle",
		Mode:        string(ModeSemantic),
		SourceTypes: []string{"task"},
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("Retrieve after reindex: %v", err)
	}
	assertTaskCandidateIDs(t, response.Candidates, []string{"act001"})
}

func TestIndexTaskHardDeleteDuringEmbeddingCannotResurrectContent(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	embedder := newBlockingTaskEmbedder()
	vecStore := &recordingVectorStore{
		chunks: []Chunk{{ID: "task:act001:chunk:stale", Type: ChunkTypeTask, TaskID: "act001", Content: "deleted secret"}},
		hashes: map[string]string{"task:act001": "stale"},
	}
	indexer := NewIndexService(store, embedder, vecStore)
	indexErr := make(chan error, 1)
	go func() { indexErr <- indexer.IndexTask("act001") }()
	waitForSignal(t, embedder.started, "IndexTask embedding")

	hardDeleteTaskForIndexRace(t, store, "act001")
	removeErr := make(chan error, 1)
	go func() { removeErr <- indexer.RemoveTask("act001") }()
	select {
	case err := <-removeErr:
		if err != nil {
			t.Fatalf("RemoveTask during blocked embedding: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RemoveTask blocked behind embedding; lifecycle lock was held during external work")
	}

	close(embedder.release)
	if err := <-indexErr; err != nil {
		t.Fatalf("IndexTask after concurrent hard-delete: %v", err)
	}
	assertTaskIndexAbsent(t, vecStore, "act001")
}

func TestReindexHardDeleteDuringEmbeddingCannotResurrectContent(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	embedder := newBlockingTaskEmbedder()
	vecStore := &recordingVectorStore{
		chunks: []Chunk{{ID: "task:act001:chunk:stale", Type: ChunkTypeTask, TaskID: "act001", Content: "deleted secret"}},
		hashes: map[string]string{"task:act001": "stale"},
	}
	indexer := NewIndexService(store, embedder, vecStore)
	reindexErr := make(chan error, 1)
	go func() { reindexErr <- indexer.Reindex(nil) }()
	waitForSignal(t, embedder.started, "Reindex Task embedding")

	hardDeleteTaskForIndexRace(t, store, "act001")
	removeErr := make(chan error, 1)
	go func() { removeErr <- indexer.RemoveTask("act001") }()
	select {
	case err := <-removeErr:
		if err != nil {
			t.Fatalf("RemoveTask during blocked Reindex: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RemoveTask blocked behind Reindex embedding; lifecycle lock was held during external work")
	}

	close(embedder.release)
	if err := <-reindexErr; err != nil {
		t.Fatalf("Reindex after concurrent hard-delete: %v", err)
	}
	assertTaskIndexAbsent(t, vecStore, "act001")
}

func TestIndexTaskLifecycleChangeDuringEmbeddingDiscardsStaleCandidate(t *testing.T) {
	store := newTaskLifecycleSearchStore(t)
	embedder := newBlockingTaskEmbedder()
	vecStore := &recordingVectorStore{
		chunks: []Chunk{{ID: "task:act001:chunk:stale", Type: ChunkTypeTask, TaskID: "act001", Status: "todo"}},
		hashes: map[string]string{"task:act001": "stale"},
	}
	indexer := NewIndexService(store, embedder, vecStore)
	indexErr := make(chan error, 1)
	go func() { indexErr <- indexer.IndexTask("act001") }()
	waitForSignal(t, embedder.started, "IndexTask embedding before archive")

	now := time.Now().UTC()
	err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		task, err := tx.GetTask("act001")
		if err != nil {
			return err
		}
		task.Status = "done"
		task.CompletedAt = &now
		task.ArchivedAt = &now
		task.UpdatedAt = now
		if err := tx.PatchTaskLifecycle(task); err != nil {
			return err
		}
		return tx.ArchiveTask(task.ID)
	})
	if err != nil {
		t.Fatalf("archive during embedding: %v", err)
	}

	close(embedder.release)
	if err := <-indexErr; err == nil || !strings.Contains(err.Error(), "changed during semantic indexing") {
		t.Fatalf("stale IndexTask error = %v, want retryable lifecycle-change error", err)
	}
	assertTaskIndexAbsent(t, vecStore, "act001")

	if err := NewIndexService(store, stubEmbedder{}, vecStore).IndexTask("act001"); err != nil {
		t.Fatalf("retry IndexTask after archive: %v", err)
	}
	canonical, err := store.Tasks.Get("act001")
	if err != nil {
		t.Fatalf("get archived Task: %v", err)
	}
	if got := vecStore.GetContentHash("task:act001"); got != contentHash(taskContentForHash(canonical)) {
		t.Fatalf("archived Task hash = %q, want canonical lifecycle hash", got)
	}
	for _, chunk := range vecStore.chunks {
		if chunk.TaskID == "act001" && chunk.Status != "done" {
			t.Fatalf("archived Task chunk retained stale lifecycle metadata: %+v", chunk)
		}
	}
}

func TestSQLiteReindexPreservesNewerTwoSessionTaskLifecycleCommits(t *testing.T) {
	tests := []struct {
		name       string
		taskID     string
		mutate     func(*testing.T, *storage.Store, *IndexService)
		wantStatus string
		deleted    bool
	}{
		{
			name:   "archive",
			taskID: "act001",
			mutate: func(t *testing.T, store *storage.Store, indexer *IndexService) {
				now := time.Now().UTC()
				err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
					task, err := tx.GetTask("act001")
					if err != nil {
						return err
					}
					task.Status = "done"
					task.CompletedAt = &now
					task.ArchivedAt = &now
					task.UpdatedAt = now
					if err := tx.PatchTaskLifecycle(task); err != nil {
						return err
					}
					return tx.ArchiveTask(task.ID)
				})
				if err != nil {
					t.Fatalf("archive canonical Task: %v", err)
				}
				if err := indexer.IndexTask("act001"); err != nil {
					t.Fatalf("session B IndexTask after archive: %v", err)
				}
			},
			wantStatus: "done",
		},
		{
			name:   "reopen",
			taskID: "arch01",
			mutate: func(t *testing.T, store *storage.Store, indexer *IndexService) {
				reopenTask(t, store, "arch01", true)
				if err := indexer.IndexTask("arch01"); err != nil {
					t.Fatalf("session B IndexTask after reopen: %v", err)
				}
			},
			wantStatus: "todo",
		},
		{
			name:   "hard-delete",
			taskID: "act001",
			mutate: func(t *testing.T, store *storage.Store, indexer *IndexService) {
				hardDeleteTaskForIndexRace(t, store, "act001")
				if err := indexer.RemoveTask("act001"); err != nil {
					t.Fatalf("session B RemoveTask after hard-delete: %v", err)
				}
			},
			deleted: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newTaskLifecycleSearchStore(t)
			dir := filepath.Join(store.Root, ".search")
			sessionA := NewSQLiteVectorStore(dir, "test-model", 1)
			sessionB := NewSQLiteVectorStore(dir, "test-model", 1)
			if err := sessionA.Load(); err != nil {
				t.Fatalf("load SQLite session A: %v", err)
			}
			defer sessionA.Close()
			if err := sessionB.Load(); err != nil {
				t.Fatalf("load SQLite session B: %v", err)
			}
			defer sessionB.Close()

			blocker := newBlockingTaskEmbedder()
			reindexErr := make(chan error, 1)
			go func() {
				reindexErr <- NewIndexService(store, blocker, sessionA).Reindex(nil)
			}()
			waitForSignal(t, blocker.started, "session A staged Reindex embedding")

			test.mutate(t, store, NewIndexService(store, stubEmbedder{}, sessionB))
			close(blocker.release)
			if err := <-reindexErr; err != nil {
				t.Fatalf("session A Reindex after newer session B commit: %v", err)
			}

			assertSQLiteCanonicalTaskSource(t, dir, store, test.taskID, test.wantStatus, test.deleted)
			verifier := NewSQLiteVectorStore(dir, "test-model", 1)
			if err := verifier.Load(); err != nil {
				t.Fatalf("load verifier before next Reindex: %v", err)
			}
			if err := NewIndexService(store, stubEmbedder{}, verifier).Reindex(nil); err != nil {
				verifier.Close()
				t.Fatalf("next Reindex: %v", err)
			}
			if err := verifier.Close(); err != nil {
				t.Fatalf("close verifier: %v", err)
			}
			assertSQLiteCanonicalTaskSource(t, dir, store, test.taskID, test.wantStatus, test.deleted)
		})
	}
}

func assertSQLiteCanonicalTaskSource(t *testing.T, dir string, store *storage.Store, taskID, wantStatus string, deleted bool) {
	t.Helper()
	verifier := NewSQLiteVectorStore(dir, "test-model", 1)
	if err := verifier.Load(); err != nil {
		t.Fatalf("load SQLite verifier: %v", err)
	}
	defer verifier.Close()
	sourceID := "task:" + taskID
	if deleted {
		if hash := verifier.GetContentHash(sourceID); hash != "" {
			t.Fatalf("deleted Task hash survived two-session race: %q", hash)
		}
		for _, result := range verifier.Search([]float32{1}, VectorSearchOpts{TopK: 100, Threshold: 0.1, ChunkType: ChunkTypeTask}) {
			if result.TaskID == taskID {
				t.Fatalf("deleted Task chunk survived two-session race: %+v", result.Chunk)
			}
		}
		return
	}
	canonical, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get canonical Task %s: %v", taskID, err)
	}
	wantHash := contentHash(taskContentForHash(canonical))
	if hash := verifier.GetContentHash(sourceID); hash != wantHash {
		t.Fatalf("Task %s hash = %q, want canonical %q", taskID, hash, wantHash)
	}
	found := false
	for _, result := range verifier.Search([]float32{1}, VectorSearchOpts{TopK: 100, Threshold: 0.1, ChunkType: ChunkTypeTask}) {
		if result.TaskID != taskID {
			continue
		}
		found = true
		if result.Status != wantStatus {
			t.Fatalf("Task %s retained stale SQLite chunk status %q, want %q", taskID, result.Status, wantStatus)
		}
	}
	if !found {
		t.Fatalf("Task %s canonical SQLite chunks missing", taskID)
	}
}

func newTaskLifecycleSearchStore(t *testing.T) *storage.Store {
	t.Helper()
	store := newSearchTestStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	completed := now.Add(-48 * time.Hour)
	archived := now.Add(-24 * time.Hour)
	tasks := []*models.Task{
		{ID: "act001", Title: "Lifecycle context needle active", Description: "lifecycle context needle active details", Status: "todo", Priority: "high", CreatedAt: now, UpdatedAt: now},
		{ID: "done01", Title: "Lifecycle context needle done", Description: "lifecycle context needle done details", Status: "done", Priority: "medium", CompletedAt: &completed, CreatedAt: now, UpdatedAt: now},
		{ID: "arch01", Title: "Lifecycle context needle archived", Description: "lifecycle context needle archived details", Status: "done", Priority: "low", CompletedAt: &completed, ArchivedAt: &archived, CreatedAt: now, UpdatedAt: now},
	}
	for _, task := range tasks {
		if err := store.Tasks.Create(task); err != nil {
			t.Fatalf("create Task %s: %v", task.ID, err)
		}
	}
	if err := store.Tasks.Archive("arch01"); err != nil {
		t.Fatalf("archive Task: %v", err)
	}
	return store
}

func reopenTask(t *testing.T, store *storage.Store, id string, archived bool) {
	t.Helper()
	if archived {
		if err := store.Tasks.Unarchive(id); err != nil {
			t.Fatalf("unarchive %s: %v", id, err)
		}
	}
	task, err := store.Tasks.Get(id)
	if err != nil {
		t.Fatalf("get %s for reopen: %v", id, err)
	}
	task.Status = "todo"
	task.CompletedAt = nil
	task.ArchivedAt = nil
	task.UpdatedAt = time.Now().UTC()
	if err := store.Tasks.Update(task); err != nil {
		t.Fatalf("update reopened %s: %v", id, err)
	}
}

func updateTaskSearchText(t *testing.T, store *storage.Store, id, title, description string) {
	t.Helper()
	task, err := store.Tasks.Get(id)
	if err != nil {
		t.Fatalf("get %s for search text update: %v", id, err)
	}
	task.Title = title
	task.Description = description
	task.UpdatedAt = time.Now().UTC()
	if err := store.Tasks.Update(task); err != nil {
		t.Fatalf("update %s search text: %v", id, err)
	}
}

type blockingTaskEmbedder struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newBlockingTaskEmbedder() *blockingTaskEmbedder {
	return &blockingTaskEmbedder{started: make(chan struct{}), release: make(chan struct{})}
}

func (e *blockingTaskEmbedder) Embed(string) ([]float32, error) { return []float32{1}, nil }
func (e *blockingTaskEmbedder) EmbedDocument(string) ([]float32, error) {
	return []float32{1}, nil
}
func (e *blockingTaskEmbedder) EmbedQuery(string) ([]float32, error) { return []float32{1}, nil }
func (e *blockingTaskEmbedder) EmbedBatch(texts []string) ([][]float32, error) {
	return stubVectors(len(texts)), nil
}
func (e *blockingTaskEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error) {
	e.once.Do(func() { close(e.started) })
	<-e.release
	return stubVectors(len(texts)), nil
}
func (e *blockingTaskEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error) {
	return stubVectors(len(texts)), nil
}
func (e *blockingTaskEmbedder) Dimensions() int { return 1 }
func (e *blockingTaskEmbedder) ModelConfig() EmbeddingModelConfig {
	return EmbeddingModelConfig{Name: "blocking", Dimensions: 1}
}
func (e *blockingTaskEmbedder) GetTokenizer() Tokenizer { return nil }
func (e *blockingTaskEmbedder) Close()                  {}

func hardDeleteTaskForIndexRace(t *testing.T, store *storage.Store, taskID string) {
	t.Helper()
	err := store.WithTaskLifecycleTransaction(context.Background(), func(tx *storage.TaskLifecycleTransaction) error {
		if err := tx.SaveTombstone(&models.TaskTombstone{
			ID:        taskID,
			DeletedAt: time.Now().UTC(),
			Actor:     "test",
			Reason:    "index race regression",
		}); err != nil {
			return err
		}
		return tx.DeleteTask(taskID)
	})
	if err != nil {
		t.Fatalf("hard-delete canonical Task %s: %v", taskID, err)
	}
}

func waitForSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func assertTaskIndexAbsent(t *testing.T, vecStore *recordingVectorStore, taskID string) {
	t.Helper()
	prefix := "task:" + taskID + ":"
	for _, chunk := range vecStore.chunks {
		if strings.HasPrefix(chunk.ID, prefix) {
			t.Fatalf("deleted Task content resurrected in semantic index: %+v", chunk)
		}
	}
	if hash := vecStore.GetContentHash("task:" + taskID); hash != "" {
		t.Fatalf("deleted Task content hash resurrected: %q", hash)
	}
}

func assertTaskResultIDs(t *testing.T, results []models.SearchResult, want []string) {
	t.Helper()
	got := make([]string, 0, len(results))
	for _, result := range results {
		if result.Type == "task" {
			got = append(got, result.ID)
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("Task result IDs = %v, want %v; results=%+v", got, want, results)
	}
}

func assertTaskCandidateIDs(t *testing.T, candidates []models.RetrievalCandidate, want []string) {
	t.Helper()
	got := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Type == "task" {
			got = append(got, candidate.ID)
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("Task candidate IDs = %v, want %v; candidates=%+v", got, want, candidates)
	}
}

func assertExpandedTaskIDs(t *testing.T, candidates []models.RetrievalCandidate, want []string) {
	t.Helper()
	got := make([]string, 0, len(want))
	for _, candidate := range candidates {
		if candidate.Type == "task" && !candidate.DirectMatch {
			got = append(got, candidate.ID)
		}
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("expanded Task IDs = %v, want %v; candidates=%+v", got, want, candidates)
	}
}
