package search

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// IndexService orchestrates chunking, embedding, and storage of vectors.
type IndexService struct {
	store    *storage.Store
	embedder EmbedderProvider
	vecStore VectorStore
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
		if err := s.vecStore.Clear(); err != nil {
			return fmt.Errorf("clear vecstore: %w", err)
		}
	}

	tasks, err := s.store.Tasks.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	allDocs, err := s.store.Docs.List()
	if err != nil {
		return fmt.Errorf("list docs: %w", err)
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

	// Phase 1: Index tasks.
	for i, task := range tasks {
		if progress != nil {
			progress("tasks", i+1, len(tasks))
		}
		sourceID := "task:" + task.ID
		currentIDs[sourceID] = true

		hash := contentHash(taskContentForHash(task))
		if s.vecStore.GetContentHash(sourceID) == hash {
			continue // unchanged
		}

		s.vecStore.RemoveByPrefix(fmt.Sprintf("task:%s:", task.ID))
		if err := s.embedAndStoreTask(task); err != nil {
			continue // non-fatal
		}
		s.vecStore.SetContentHash(sourceID, hash)
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

	// Phase 4: Clean up orphaned entries (deleted tasks/docs/memories).
	for id := range s.vecStore.ListContentHashes() {
		if !currentIDs[id] {
			// Extract prefix for chunk removal (e.g. "task:abc" → "task:abc:")
			s.vecStore.RemoveByPrefix(id + ":")
			s.vecStore.DeleteContentHash(id)
		}
	}

	return s.vecStore.Save()
}

// IndexTask incrementally indexes a single task (removes old chunks first).
func (s *IndexService) IndexTask(taskID string) error {
	s.vecStore.RemoveByPrefix(fmt.Sprintf("task:%s:", taskID))

	task, err := s.store.Tasks.Get(taskID)
	if err != nil {
		return err
	}
	if err := s.embedAndStoreTask(task); err != nil {
		return err
	}
	return s.vecStore.Save()
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
	s.vecStore.RemoveByPrefix(fmt.Sprintf("task:%s:", taskID))
	return s.vecStore.Save()
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

func (s *IndexService) embedAndStoreTask(task *models.Task) error {
	maxTokens := 512
	if cfg, ok := EmbeddingModels[s.vecStore.Model()]; ok {
		maxTokens = cfg.MaxTokens
	}
	result := ChunkTask(task, maxTokens, s.embedder.GetTokenizer())
	return s.embedAndStore(result.Chunks)
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

func (s *IndexService) memoryEntriesForIndex() ([]*models.MemoryEntry, error) {
	if s.store == nil || s.store.Memory == nil {
		return nil, nil
	}
	if s.store.Root == storage.GlobalSemanticStoreRoot() {
		return s.store.Memory.ListGlobalOnly()
	}
	return s.store.Memory.ListLocal()
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

func (s *IndexService) embedAndStore(chunks []Chunk) error {
	if len(chunks) == 0 {
		return nil
	}

	// Batch embed all chunks at once.
	texts := make([]string, len(chunks))
	for i := range chunks {
		texts[i] = chunks[i].Content
	}

	if os.Getenv("KNOWNS_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "[embed] batch %d chunks...\n", len(chunks))
	}

	vecs, err := s.embedder.EmbedDocumentBatch(texts)
	if err != nil {
		if os.Getenv("KNOWNS_DEBUG") == "1" {
			fmt.Fprintf(os.Stderr, "[embed] batch failed: %v, falling back to one-by-one\n", err)
		}
		// Fallback: try one by one if batch fails.
		for i := range chunks {
			vec, err2 := s.embedder.EmbedDocument(chunks[i].Content)
			if err2 != nil {
				if os.Getenv("KNOWNS_DEBUG") == "1" {
					fmt.Fprintf(os.Stderr, "[embed] chunk %d failed: %v\n", i, err2)
				}
				continue // skip failed chunks
			}
			chunks[i].Embedding = vec
		}
		s.vecStore.AddChunks(chunks)
		return nil
	}

	if os.Getenv("KNOWNS_DEBUG") == "1" {
		fmt.Fprintf(os.Stderr, "[embed] batch success: %d vectors\n", len(vecs))
	}

	for i := range chunks {
		chunks[i].Embedding = vecs[i]
	}
	s.vecStore.AddChunks(chunks)
	return nil
}

func contentHash(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

func taskContentForHash(task *models.Task) string {
	s := task.Title + "\n" + task.Description + "\n" + task.Status + "\n" + task.Priority
	for _, ac := range task.AcceptanceCriteria {
		s += "\n" + ac.Text
	}
	s += "\n" + task.ImplementationPlan + "\n" + task.ImplementationNotes
	return s
}
