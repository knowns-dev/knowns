package search

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// IndexService orchestrates chunking, embedding, and storage of vectors.
type IndexService struct {
	store    *storage.Store
	embedder EmbedderProvider
	vecStore VectorStore
}

type taskIndexCandidate struct {
	taskID    string
	hash      string
	chunks    []Chunk
	unchanged bool
}

// NewIndexService creates an IndexService.
func NewIndexService(store *storage.Store, embedder EmbedderProvider, vecStore VectorStore) *IndexService {
	return &IndexService{
		store:    store,
		embedder: embedder,
		vecStore: vecStore,
	}
}

// ReindexProgress is called during reindexing to report progress.
type ReindexProgress func(phase string, current, total int)

// Reindex re-indexes all tasks and docs, skipping unchanged items via content hashing.
// If the model or chunk version changed, all hashes are invalidated and a full rebuild occurs.
func (s *IndexService) Reindex(progress ReindexProgress) error {
	// If model/version changed, clear everything for a full rebuild.
	if s.vecStore.NeedsRebuild(s.vecStore.Model()) {
		if err := s.withTaskIndexCommit(func(_ *storage.TaskLifecycleTransaction) error {
			return s.vecStore.Clear()
		}); err != nil {
			return fmt.Errorf("clear vecstore: %w", err)
		}
	}

	tasks, err := allTasksForIndex(s.store)
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	allDocs, err := s.store.Docs.List()
	if err != nil {
		return fmt.Errorf("list docs: %w", err)
	}
	decisions, err := s.store.Decisions.List()
	if err != nil {
		return fmt.Errorf("list decisions: %w", err)
	}

	// Split docs into local and imported.
	var docs, importedDocs []*models.Doc
	for _, doc := range allDocs {
		if doc.IsImported {
			importedDocs = append(importedDocs, doc)
		} else {
			docs = append(docs, doc)
		}
	}

	// Build set of current source IDs for orphan cleanup.
	currentIDs := make(map[string]bool)
	taskCandidates := make(map[string]taskIndexCandidate, len(tasks))

	// Phase 1: prepare Task embeddings without mutating the live index. The
	// canonical Task set is revalidated under the lifecycle lock at final commit.
	for i, task := range tasks {
		if progress != nil {
			progress("tasks", i+1, len(tasks))
		}
		sourceID := "task:" + task.ID
		hash := contentHash(taskContentForHash(task))
		if s.vecStore.GetContentHash(sourceID) == hash {
			taskCandidates[task.ID] = taskIndexCandidate{taskID: task.ID, hash: hash, unchanged: true}
			continue
		}

		chunks, err := s.embedTask(task)
		if err != nil {
			continue // non-fatal
		}
		taskCandidates[task.ID] = taskIndexCandidate{taskID: task.ID, hash: hash, chunks: chunks}
	}

	// Phase 2: Index local docs.
	for i, doc := range docs {
		if progress != nil {
			progress("docs", i+1, len(docs))
		}
		sourceID := "doc:" + doc.Path
		currentIDs[sourceID] = true

		fullDoc, err := s.store.Docs.Get(doc.Path)
		if err != nil {
			continue
		}

		hash := contentHash(fullDoc.Title + "\n" + fullDoc.Description + "\n" + fullDoc.Content)
		if s.vecStore.GetContentHash(sourceID) == hash {
			continue
		}

		s.vecStore.RemoveByPrefix(fmt.Sprintf("doc:%s:", doc.Path))
		if err := s.embedAndStoreDoc(fullDoc); err != nil {
			continue
		}
		s.vecStore.SetContentHash(sourceID, hash)
	}

	// Phase 3: Index imported docs.
	for i, doc := range importedDocs {
		if progress != nil {
			progress("imports", i+1, len(importedDocs))
		}
		sourceID := "doc:" + doc.Path
		currentIDs[sourceID] = true

		fullDoc, err := s.store.Docs.Get(doc.Path)
		if err != nil {
			continue
		}

		hash := contentHash(fullDoc.Title + "\n" + fullDoc.Description + "\n" + fullDoc.Content)
		if s.vecStore.GetContentHash(sourceID) == hash {
			continue
		}

		s.vecStore.RemoveByPrefix(fmt.Sprintf("doc:%s:", doc.Path))
		if err := s.embedAndStoreDoc(fullDoc); err != nil {
			continue
		}
		s.vecStore.SetContentHash(sourceID, hash)
	}

	// Phase 4: Index memory entries.
	memories, err := s.memoryEntriesForIndex()
	if err != nil {
		memories = nil // non-fatal
	}
	for i, entry := range memories {
		if progress != nil {
			progress("memories", i+1, len(memories))
		}
		sourceID := "memory:" + entry.ID
		currentIDs[sourceID] = true

		hash := contentHash(entry.Title + "\n" + entry.Category + "\n" + entry.Content)
		if s.vecStore.GetContentHash(sourceID) == hash {
			continue
		}

		s.vecStore.RemoveByPrefix(fmt.Sprintf("memory:%s:", entry.ID))
		if err := s.embedAndStoreMemory(entry); err != nil {
			continue
		}
		s.vecStore.SetContentHash(sourceID, hash)
	}

	// Phase 5: Index decisions.
	for i, decision := range decisions {
		if progress != nil {
			progress("decisions", i+1, len(decisions))
		}
		sourceID := "decision:" + decision.ID
		currentIDs[sourceID] = true

		hash := contentHash(decisionContentForHash(decision))
		if s.vecStore.GetContentHash(sourceID) == hash {
			continue
		}

		s.vecStore.RemoveByPrefix(fmt.Sprintf("decision:%s:", decision.ID))
		if err := s.embedAndStoreDecision(decision); err != nil {
			continue
		}
		s.vecStore.SetContentHash(sourceID, hash)
	}

	// Phase 6: atomically reconcile Task candidates with canonical lifecycle
	// state, clean orphans, and persist. Embedding never runs under this lock.
	return s.withTaskIndexCommit(func(tx *storage.TaskLifecycleTransaction) error {
		atomicStore, atomic := s.vecStore.(atomicTaskVectorStore)
		taskMutations := make(map[string]taskVectorMutation)
		deleteTaskSource := func(taskID, expectedHash string, checkHash bool) {
			if atomic {
				taskMutations[taskID] = taskVectorMutation{
					TaskID: taskID, Delete: true, ExpectedHash: expectedHash, CheckHash: checkHash,
				}
				return
			}
			sourceID := "task:" + taskID
			s.vecStore.RemoveByPrefix(sourceID + ":")
			s.vecStore.DeleteContentHash(sourceID)
		}
		finalTasks, err := allTasksForIndexTransaction(tx)
		if err != nil {
			return fmt.Errorf("revalidate tasks: %w", err)
		}
		finalByID := make(map[string]*models.Task, len(finalTasks))
		for _, task := range finalTasks {
			reserved, err := tx.IsIDReserved(task.ID)
			if err != nil {
				return fmt.Errorf("revalidate Task %q tombstone: %w", task.ID, err)
			}
			if reserved {
				continue
			}
			finalByID[task.ID] = task
			currentIDs["task:"+task.ID] = true
		}

		for taskID, candidate := range taskCandidates {
			sourceID := "task:" + taskID
			canonical := finalByID[taskID]
			if canonical == nil {
				deleteTaskSource(taskID, "", false)
				continue
			}
			finalHash := contentHash(taskContentForHash(canonical))
			if finalHash != candidate.hash {
				// A concurrent update/archive/reopen may already have committed the
				// correct representation. Preserve it; otherwise fail closed by
				// removing the stale representation and let its hook retry.
				if liveHash := s.vecStore.GetContentHash(sourceID); liveHash != finalHash {
					deleteTaskSource(taskID, liveHash, true)
				}
				continue
			}
			liveHash := s.vecStore.GetContentHash(sourceID)
			if liveHash == candidate.hash {
				continue
			}
			if candidate.unchanged {
				// The session observed this hash before staging but the durable
				// source changed meanwhile. No embeddings were prepared, so remove
				// the inconsistent source and let the next pass rebuild it.
				deleteTaskSource(taskID, liveHash, true)
				continue
			}
			if atomic {
				taskMutations[taskID] = taskVectorMutation{
					TaskID: taskID, Chunks: candidate.chunks, Hash: candidate.hash,
					ExpectedHash: liveHash, CheckHash: true,
				}
				continue
			}
			s.vecStore.RemoveByPrefix(sourceID + ":")
			s.vecStore.AddChunks(candidate.chunks)
			s.vecStore.SetContentHash(sourceID, candidate.hash)
		}

		for id := range s.vecStore.ListContentHashes() {
			if !currentIDs[id] {
				if atomic && strings.HasPrefix(id, "task:") {
					deleteTaskSource(strings.TrimPrefix(id, "task:"), "", false)
					continue
				}
				s.vecStore.RemoveByPrefix(id + ":")
				s.vecStore.DeleteContentHash(id)
			}
		}
		if atomic {
			// Never call SQLite's global Save from a Reindex session whose Task
			// memory view predates a concurrent lifecycle hook commit.
			if err := atomicStore.SaveNonTaskSources(); err != nil {
				return err
			}
			mutations := make([]taskVectorMutation, 0, len(taskMutations))
			for _, mutation := range taskMutations {
				mutations = append(mutations, mutation)
			}
			sort.Slice(mutations, func(i, j int) bool { return mutations[i].TaskID < mutations[j].TaskID })
			return atomicStore.ApplyTaskMutations(mutations)
		}
		return s.vecStore.Save()
	})
}

// IndexTask incrementally indexes a single task (removes old chunks first).
func (s *IndexService) IndexTask(taskID string) error {
	task, err := s.store.Tasks.Get(taskID)
	if err != nil {
		return err
	}
	hash := contentHash(taskContentForHash(task))
	chunks, err := s.embedTask(task)
	if err != nil {
		return err
	}

	return s.withTaskIndexCommit(func(tx *storage.TaskLifecycleTransaction) error {
		atomicStore, atomic := s.vecStore.(atomicTaskVectorStore)
		canonical, canonicalErr := tx.GetTask(taskID)
		reserved, reservedErr := tx.IsIDReserved(taskID)
		if reservedErr != nil {
			return fmt.Errorf("revalidate Task %q tombstone: %w", taskID, reservedErr)
		}
		sourceID := "task:" + taskID
		if canonicalErr != nil || reserved {
			if atomic {
				if err := atomicStore.ApplyTaskMutations([]taskVectorMutation{{TaskID: taskID, Delete: true}}); err != nil {
					return err
				}
				if reserved {
					return nil
				}
				return fmt.Errorf("revalidate Task %q before index commit: %w", taskID, canonicalErr)
			}
			s.vecStore.RemoveByPrefix(sourceID + ":")
			s.vecStore.DeleteContentHash(sourceID)
			if saveErr := s.vecStore.Save(); saveErr != nil {
				return saveErr
			}
			if reserved {
				return nil
			}
			return fmt.Errorf("revalidate Task %q before index commit: %w", taskID, canonicalErr)
		}
		finalHash := contentHash(taskContentForHash(canonical))
		if finalHash != hash {
			liveHash := s.vecStore.GetContentHash(sourceID)
			if liveHash == finalHash {
				if atomic {
					return atomicStore.ApplyTaskMutations(nil)
				}
				return nil
			}
			if atomic {
				if err := atomicStore.ApplyTaskMutations([]taskVectorMutation{{
					TaskID: taskID, Delete: true, ExpectedHash: liveHash, CheckHash: true,
				}}); err != nil {
					return err
				}
				return fmt.Errorf("Task %q changed during semantic indexing; retry", taskID)
			}
			s.vecStore.RemoveByPrefix(sourceID + ":")
			s.vecStore.DeleteContentHash(sourceID)
			if saveErr := s.vecStore.Save(); saveErr != nil {
				return saveErr
			}
			return fmt.Errorf("Task %q changed during semantic indexing; retry", taskID)
		}
		if atomic {
			liveHash := s.vecStore.GetContentHash(sourceID)
			return atomicStore.ApplyTaskMutations([]taskVectorMutation{{
				TaskID: taskID, Chunks: chunks, Hash: hash,
				ExpectedHash: liveHash, CheckHash: true,
			}})
		}
		s.vecStore.RemoveByPrefix(sourceID + ":")
		s.vecStore.AddChunks(chunks)
		s.vecStore.SetContentHash(sourceID, hash)
		return s.vecStore.Save()
	})
}

// IndexDoc incrementally indexes a single doc (removes old chunks first).
func (s *IndexService) IndexDoc(docPath string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("doc:%s:", docPath))

	doc, err := s.store.Docs.Get(docPath)
	if err != nil {
		return err
	}
	if err := s.embedAndStoreDoc(doc); err != nil {
		return err
	}
	return s.vecStore.Save()
}

// RemoveTask removes all chunks for a task from the vector store.
func (s *IndexService) RemoveTask(taskID string) error {
	return s.withTaskIndexCommit(func(_ *storage.TaskLifecycleTransaction) error {
		if atomicStore, ok := s.vecStore.(atomicTaskVectorStore); ok {
			return atomicStore.ApplyTaskMutations([]taskVectorMutation{{TaskID: taskID, Delete: true}})
		}
		sourceID := "task:" + taskID
		s.vecStore.RemoveByPrefix(sourceID + ":")
		s.vecStore.DeleteContentHash(sourceID)
		return s.vecStore.Save()
	})
}

// RemoveDoc removes all chunks for a doc from the vector store.
func (s *IndexService) RemoveDoc(docPath string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("doc:%s:", docPath))
	return s.vecStore.Save()
}

// IndexMemory incrementally indexes a single memory entry (removes old chunks first).
func (s *IndexService) IndexMemory(memoryID string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("memory:%s:", memoryID))

	entry, err := s.memoryEntryForIndex(memoryID)
	if err != nil {
		return err
	}
	if !entry.CurrentForDefaultRetrieval() {
		return s.vecStore.Save()
	}
	if err := s.embedAndStoreMemory(entry); err != nil {
		return err
	}
	return s.vecStore.Save()
}

// RemoveMemory removes all chunks for a memory entry from the vector store.
func (s *IndexService) RemoveMemory(memoryID string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("memory:%s:", memoryID))
	return s.vecStore.Save()
}

// IndexDecision incrementally indexes a single decision (removes old chunks first).
func (s *IndexService) IndexDecision(decisionID string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("decision:%s:", decisionID))

	decision, err := s.store.Decisions.Get(decisionID)
	if err != nil {
		return err
	}
	if err := s.embedAndStoreDecision(decision); err != nil {
		return err
	}
	return s.vecStore.Save()
}

// RemoveDecision removes all chunks for a decision from the vector store.
func (s *IndexService) RemoveDecision(decisionID string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("decision:%s:", decisionID))
	return s.vecStore.Save()
}

func (s *IndexService) embedAndStoreTask(task *models.Task) error {
	chunks, err := s.embedTask(task)
	if err != nil {
		return err
	}
	s.vecStore.AddChunks(chunks)
	return nil
}

func (s *IndexService) embedTask(task *models.Task) ([]Chunk, error) {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.vecStore.Model()]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkTask(task, maxTokens, s.embedder.GetTokenizer())
	return s.embedChunks(result.Chunks)
}

func (s *IndexService) embedAndStoreDoc(doc *models.Doc) error {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.vecStore.Model()]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkDocument(doc.Content, doc.Path, doc.Title, doc.Description, maxTokens, s.embedder.GetTokenizer())
	return s.embedAndStore(result.Chunks)
}

func (s *IndexService) embedAndStoreMemory(entry *models.MemoryEntry) error {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.vecStore.Model()]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkMemory(entry, maxTokens, s.embedder.GetTokenizer())
	return s.embedAndStore(result.Chunks)
}

func (s *IndexService) embedAndStoreDecision(decision *models.DecisionEntry) error {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.vecStore.Model()]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkDecision(decision, maxTokens, s.embedder.GetTokenizer())
	return s.embedAndStore(result.Chunks)
}

func (s *IndexService) memoryEntriesForIndex() ([]*models.MemoryEntry, error) {
	if s.store == nil || s.store.Memory == nil {
		return nil, nil
	}
	if s.store.Root == storage.GlobalSemanticStoreRoot() {
		return currentMemoryEntries(s.store.Memory.ListGlobalOnly())
	}
	return currentMemoryEntries(s.store.Memory.ListLocal())
}

func (s *IndexService) memoryEntryForIndex(memoryID string) (*models.MemoryEntry, error) {
	if s.store == nil || s.store.Memory == nil {
		return nil, fmt.Errorf("memory store unavailable")
	}
	if s.store.Root == storage.GlobalSemanticStoreRoot() {
		return s.store.Memory.GetInLayer(memoryID, models.MemoryLayerGlobal)
	}
	if entry, err := s.store.Memory.GetInLayer(memoryID, models.MemoryLayerProject); err == nil {
		return entry, nil
	}
	return s.store.Memory.GetInLayer(memoryID, models.MemoryLayerGlobal)
}

func currentMemoryEntries(entries []*models.MemoryEntry, err error) ([]*models.MemoryEntry, error) {
	if err != nil {
		return nil, err
	}
	filtered := entries[:0]
	for _, entry := range entries {
		if entry.CurrentForDefaultRetrieval() {
			filtered = append(filtered, entry)
		}
	}
	return filtered, nil
}

func (s *IndexService) embedAndStore(chunks []Chunk) error {
	embedded, err := s.embedChunks(chunks)
	if err != nil {
		return err
	}
	s.vecStore.AddChunks(embedded)
	return nil
}

func (s *IndexService) embedChunks(chunks []Chunk) ([]Chunk, error) {
	if len(chunks) == 0 {
		return chunks, nil
	}

	batchSize := embedBatchSize(len(chunks))
	texts := make([]string, len(chunks))
	for i := range chunks {
		texts[i] = chunks[i].Content
	}

	for start := 0; start < len(chunks); start += batchSize {
		end := start + batchSize
		if end > len(chunks) {
			end = len(chunks)
		}

		if os.Getenv("KNOWNS_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[embed] batch %d:%d of %d chunks...\n", start, end, len(chunks))
		}

		vecs, err := s.embedder.EmbedDocumentBatch(texts[start:end])
		if err != nil || len(vecs) != end-start {
			if os.Getenv("KNOWNS_DEBUG") == "1" {
				if err != nil {
					fmt.Fprintf(os.Stderr, "[embed] batch failed: %v, falling back to one-by-one\n", err)
				} else {
					fmt.Fprintf(os.Stderr, "[embed] batch returned %d vectors for %d chunks, falling back to one-by-one\n", len(vecs), end-start)
				}
			}

			for i := start; i < end; i++ {
				vec, err2 := s.embedder.EmbedDocument(chunks[i].Content)
				if err2 != nil {
					if os.Getenv("KNOWNS_DEBUG") == "1" {
						fmt.Fprintf(os.Stderr, "[embed] chunk %d failed: %v\n", i, err2)
					}
					continue // skip failed chunks
				}
				chunks[i].Embedding = vec
			}
			continue
		}

		if os.Getenv("KNOWNS_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[embed] batch success: %d vectors\n", len(vecs))
		}

		for i := start; i < end; i++ {
			chunks[i].Embedding = vecs[i-start]
		}
	}
	return chunks, nil
}

func (s *IndexService) withTaskIndexCommit(fn func(*storage.TaskLifecycleTransaction) error) error {
	if s == nil || s.store == nil {
		return fmt.Errorf("semantic index service store unavailable")
	}
	return s.store.WithTaskLifecycleTransaction(context.Background(), fn)
}

func embedBatchSize(total int) int {
	const defaultBatchSize = 16
	if total <= 0 {
		return defaultBatchSize
	}
	batchSize := defaultBatchSize
	if raw := os.Getenv("KNOWNS_EMBED_BATCH_SIZE"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			batchSize = parsed
		}
	}
	if batchSize > total {
		return total
	}
	return batchSize
}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

func taskContentForHash(task *models.Task) string {
	s := task.Title + "\n" + task.Description + "\n" + task.Status + "\n" + task.Priority + "\n" + string(task.LifecycleState())
	if task.CompletedAt != nil {
		s += "\ncompleted:" + task.CompletedAt.UTC().Format(time.RFC3339Nano)
	}
	if task.ArchivedAt != nil {
		s += "\narchived:" + task.ArchivedAt.UTC().Format(time.RFC3339Nano)
	}
	for _, ac := range task.AcceptanceCriteria {
		s += "\n" + ac.Text
	}
	s += "\n" + task.ImplementationPlan + "\n" + task.ImplementationNotes
	return s
}

func allTasksForIndex(store *storage.Store) ([]*models.Task, error) {
	if store == nil || store.Tasks == nil {
		return nil, fmt.Errorf("task store unavailable")
	}
	active, err := store.Tasks.List()
	if err != nil {
		return nil, err
	}
	archived, err := store.Tasks.ListArchived()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*models.Task, len(active)+len(archived))
	for _, task := range archived {
		byID[task.ID] = task
	}
	// Prefer canonical active storage when migration artifacts contain both.
	for _, task := range active {
		byID[task.ID] = task
	}
	result := make([]*models.Task, 0, len(byID))
	for _, task := range byID {
		result = append(result, task)
	}
	return result, nil
}

func allTasksForIndexTransaction(tx *storage.TaskLifecycleTransaction) ([]*models.Task, error) {
	if tx == nil {
		return nil, fmt.Errorf("task lifecycle transaction unavailable")
	}
	active, err := tx.ListActiveTasks()
	if err != nil {
		return nil, err
	}
	archived, err := tx.ListArchivedTasks()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]*models.Task, len(active)+len(archived))
	for _, task := range archived {
		byID[task.ID] = task
	}
	for _, task := range active {
		byID[task.ID] = task
	}
	result := make([]*models.Task, 0, len(byID))
	for _, task := range byID {
		result = append(result, task)
	}
	return result, nil
}

func decisionContentForHash(decision *models.DecisionEntry) string {
	if decision == nil {
		return ""
	}
	parts := []string{
		decision.Title,
		decision.Status,
		strings.Join(decision.Supersedes, "\n"),
		strings.Join(decision.SupersededBy, "\n"),
		strings.Join(decision.Tags, "\n"),
		strings.Join(decision.Sources, "\n"),
		strings.Join(decision.RelatedDocs, "\n"),
		strings.Join(decision.RelatedTasks, "\n"),
		decision.Context,
		decision.Decision,
		decision.AlternativesConsidered,
		decision.Consequences,
		decision.Content,
	}
	return strings.Join(parts, "\n")
}
