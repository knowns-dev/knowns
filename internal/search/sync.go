package search

import (
	"context"
	"errors"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

type indexJobKey struct {
	root   string
	action string
	target string
}

var backgroundIndexer = newIndexScheduler(1)

type indexScheduler struct {
	jobs  chan func()
	delay time.Duration

	mu      sync.Mutex
	pending map[indexJobKey]*time.Timer
}

func newIndexScheduler(workers int) *indexScheduler {
	if workers <= 0 {
		workers = 1
	}
	s := &indexScheduler{
		jobs:    make(chan func(), 256),
		delay:   indexQueueDelay(),
		pending: make(map[indexJobKey]*time.Timer),
	}
	for range workers {
		go func() {
			for job := range s.jobs {
				job()
				if s.delay > 0 {
					time.Sleep(s.delay)
				}
			}
		}()
	}
	return s
}

func (s *indexScheduler) Submit(key indexJobKey, job func()) {
	s.SubmitAfter(key, 0, job)
}

func (s *indexScheduler) SubmitAfter(key indexJobKey, debounce time.Duration, job func()) {
	s.mu.Lock()
	if timer, exists := s.pending[key]; exists {
		timer.Stop()
	}

	timer := time.AfterFunc(debounce, func() {
		wrapped := func() {
			defer func() {
				s.mu.Lock()
				delete(s.pending, key)
				s.mu.Unlock()
			}()
			job()
		}

		select {
		case s.jobs <- wrapped:
		default:
			log.Printf("[search] background index queue full, dropping %s %s", key.action, key.target)
			s.mu.Lock()
			delete(s.pending, key)
			s.mu.Unlock()
		}
	})
	s.pending[key] = timer
	s.mu.Unlock()
}

func BestEffortIndexTask(store *storage.Store, taskID string) {
	if qdrantBestEffortIntent(store, "task", taskID, false) {
		return
	}
	if enqueueRuntimeJob(store, runtimequeue.JobIndexTask, taskID, func() {
		scheduleBestEffort(store, "index-task", taskID, func(svc *IndexService) error {
			return svc.IndexTask(taskID)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "index-task", taskID, func(svc *IndexService) error {
		return svc.IndexTask(taskID)
	})
}

func BestEffortIndexDoc(store *storage.Store, docPath string) {
	if qdrantBestEffortIntent(store, "doc", docPath, false) {
		return
	}
	if enqueueRuntimeJob(store, runtimequeue.JobIndexDoc, docPath, func() {
		scheduleBestEffort(store, "index-doc", docPath, func(svc *IndexService) error {
			return svc.IndexDoc(docPath)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "index-doc", docPath, func(svc *IndexService) error {
		return svc.IndexDoc(docPath)
	})
}

func BestEffortRemoveTask(store *storage.Store, taskID string) {
	if qdrantBestEffortIntent(store, "task", taskID, true) {
		return
	}
	if enqueueRuntimeJob(store, runtimequeue.JobRemoveTask, taskID, func() {
		scheduleBestEffort(store, "remove-task", taskID, func(svc *IndexService) error {
			return svc.RemoveTask(taskID)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "remove-task", taskID, func(svc *IndexService) error {
		return svc.RemoveTask(taskID)
	})
}

// ReconcileTaskIndex synchronously updates one Task's derived index. A project
// without semantic search has no derived index to reconcile and succeeds.
func ReconcileTaskIndex(store *storage.Store, taskID string) error {
	return withSemanticIndex(store, func(service *IndexService) error {
		return service.IndexTask(taskID)
	})
}

// ReconcileTaskRemoval synchronously removes one Task's derived index.
func ReconcileTaskRemoval(store *storage.Store, taskID string) error {
	return withSemanticIndex(store, func(service *IndexService) error {
		return service.RemoveTask(taskID)
	})
}

func withSemanticIndex(store *storage.Store, fn func(*IndexService) error) error {
	if store == nil {
		return nil
	}
	embedder, vecStore, err := InitSemantic(store)
	if errors.Is(err, ErrSemanticNotConfigured) {
		return nil
	}
	if err != nil {
		return err
	}
	defer embedder.Close()
	defer vecStore.Close()
	return fn(NewIndexService(store, embedder, vecStore))
}

func BestEffortRemoveDoc(store *storage.Store, docPath string) {
	if qdrantBestEffortIntent(store, "doc", docPath, true) {
		return
	}
	if enqueueRuntimeJob(store, runtimequeue.JobRemoveDoc, docPath, func() {
		scheduleBestEffort(store, "remove-doc", docPath, func(svc *IndexService) error {
			return svc.RemoveDoc(docPath)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "remove-doc", docPath, func(svc *IndexService) error {
		return svc.RemoveDoc(docPath)
	})
}

// BestEffortRemoveDocID preserves stable Doc identity for Qdrant removals.
// Without a durable tombstone/purge proof it deliberately queues no mutation.
func BestEffortRemoveDocID(store *storage.Store, docID, docPath string) {
	if store != nil && resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
		intent, err := removalIntentFromHistoryOrPurge(store.Root, "doc", docID, "docs/"+strings.TrimSuffix(strings.TrimPrefix(docPath, "docs/"), ".md")+".md", "")
		if err != nil {
			log.Printf("[search] could not prove qdrant doc removal %s: %v", docID, err)
			return
		}
		intent.BatchID = "public-hook"
		if ok, proofErr := proveQdrantIntent(store.Root, intent); proofErr != nil || !ok {
			log.Printf("[search] could not prove qdrant doc removal %s: %v", docID, proofErr)
			return
		}
		if err := markQdrantIntentPending(store.Root, intent); err != nil {
			log.Printf("[search] could not persist qdrant doc removal readiness: %v", err)
		}
		if _, err := runtimequeue.EnqueueQdrantIntent(store.Root, intent); err != nil {
			log.Printf("[search] could not queue qdrant doc removal: %v", err)
		}
		return
	}
	BestEffortRemoveDoc(store, docPath)
}

// BestEffortRenameDoc sends one stable-id Qdrant intent so the old source is
// deleted and only the renamed canonical document is upserted.
func BestEffortRenameDoc(store *storage.Store, docID, oldPath, newPath string) {
	if store != nil && resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
		doc, err := store.Docs.Get(newPath)
		if err != nil || doc.ID != docID {
			log.Printf("[search] could not resolve renamed qdrant doc %s: %v", docID, err)
			return
		}
		stream, err := storage.NewHistoryStore(store.Root).Read(context.Background(), "doc", docID)
		if err != nil || len(stream.Records) == 0 {
			log.Printf("[search] renamed qdrant doc lacks durable history %s", docID)
			return
		}
		head := stream.Records[len(stream.Records)-1]
		intent := runtimequeue.QdrantIntent{EntityType: "doc", EntityID: docID, Revision: head.Revision, Operation: "rename", CanonicalHash: storage.CanonicalDocHash(doc), Path: "docs/" + strings.TrimSuffix(strings.TrimPrefix(newPath, "docs/"), ".md") + ".md", PreviousPath: "docs/" + strings.TrimSuffix(strings.TrimPrefix(oldPath, "docs/"), ".md") + ".md", BatchID: "public-hook"}
		if ok, proofErr := proveQdrantIntent(store.Root, intent); proofErr != nil || !ok {
			log.Printf("[search] could not prove renamed qdrant doc %s: %v", docID, proofErr)
			return
		}
		if err := markQdrantIntentPending(store.Root, intent); err != nil {
			log.Printf("[search] could not persist renamed qdrant doc readiness: %v", err)
		}
		if _, err := runtimequeue.EnqueueQdrantIntent(store.Root, intent); err != nil {
			log.Printf("[search] could not queue renamed qdrant doc: %v", err)
		}
		return
	}
	BestEffortRemoveDoc(store, oldPath)
	BestEffortIndexDoc(store, newPath)
}

func BestEffortIndexMemory(store *storage.Store, memoryID string) {
	targetStore, targetRoot := memoryIndexTarget(store, memoryID)
	if targetStore == nil {
		return
	}
	if enqueueRuntimeJob(targetStore, runtimequeue.JobIndexMemory, memoryID, func() {
		scheduleBestEffort(targetStore, "index-memory", memoryID, func(svc *IndexService) error {
			return svc.IndexMemory(memoryID)
		})
	}) {
		return
	}
	_ = targetRoot
	scheduleBestEffort(targetStore, "index-memory", memoryID, func(svc *IndexService) error {
		return svc.IndexMemory(memoryID)
	})
}

func BestEffortRemoveMemory(store *storage.Store, memoryID string) {
	targetStore, _ := memoryIndexTarget(store, memoryID)
	if targetStore == nil {
		return
	}
	if enqueueRuntimeJob(targetStore, runtimequeue.JobRemoveMemory, memoryID, func() {
		scheduleBestEffort(targetStore, "remove-memory", memoryID, func(svc *IndexService) error {
			return svc.RemoveMemory(memoryID)
		})
	}) {
		return
	}
	scheduleBestEffort(targetStore, "remove-memory", memoryID, func(svc *IndexService) error {
		return svc.RemoveMemory(memoryID)
	})
}

func BestEffortIndexDecision(store *storage.Store, decisionID string) {
	if enqueueRuntimeJob(store, runtimequeue.JobIndexDecision, decisionID, func() {
		scheduleBestEffort(store, "index-decision", decisionID, func(svc *IndexService) error {
			return svc.IndexDecision(decisionID)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "index-decision", decisionID, func(svc *IndexService) error {
		return svc.IndexDecision(decisionID)
	})
}

func BestEffortRemoveDecision(store *storage.Store, decisionID string) {
	if enqueueRuntimeJob(store, runtimequeue.JobRemoveDecision, decisionID, func() {
		scheduleBestEffort(store, "remove-decision", decisionID, func(svc *IndexService) error {
			return svc.RemoveDecision(decisionID)
		})
	}) {
		return
	}
	scheduleBestEffort(store, "remove-decision", decisionID, func(svc *IndexService) error {
		return svc.RemoveDecision(decisionID)
	})
}

func memoryIndexTarget(store *storage.Store, memoryID string) (*storage.Store, string) {
	if store == nil || store.Memory == nil {
		return nil, ""
	}
	entry, err := store.Memory.Get(memoryID)
	if err != nil {
		return store, store.Root
	}
	if entry.Layer == models.MemoryLayerGlobal {
		globalStore := storage.NewGlobalSemanticStore()
		return globalStore, globalStore.Root
	}
	return store, store.Root
}

// BestEffortIndexFile is a no-op because code indexing has been removed.
func BestEffortIndexFile(store *storage.Store, docPath, absPath string) {
	// Code files are not indexed in background sync. Real-time code intelligence uses LSP.
}

// BestEffortRemoveFile removes all code chunks for a file from the vector store.
func BestEffortRemoveFile(store *storage.Store, docPath string) {
	// Code files are not indexed in background sync. Real-time code intelligence uses LSP.
}

func enqueueRuntimeJob(store *storage.Store, kind runtimequeue.JobKind, target string, fallback func()) bool {
	if store == nil {
		return true
	}
	if runtimequeue.ShouldBypassDaemon() {
		fallback()
		return true
	}
	if _, err := runtimequeue.Enqueue(store.Root, kind, target); err != nil {
		log.Printf("[search] runtime queue unavailable for %s %s: %v", kind, target, err)
		fallback()
		return true
	}
	return true
}

// qdrantBestEffortIntent handles public mutation hooks when Qdrant is active.
// These hooks must use the same durable, proof-checked intent path as watcher
// callbacks. Returning true means the caller must not run the legacy
// IndexService fallback, including when intent construction or queue durable
// storage fails.
func qdrantBestEffortIntent(store *storage.Store, entityType, target string, remove bool) bool {
	if store == nil || resolveEffectiveVectorStore(store).Backend != models.SemanticVectorBackendQdrant {
		return false
	}
	intent, err := currentPublicQdrantIntent(store.Root, entityType, target, remove)
	if err != nil {
		log.Printf("[search] could not build qdrant %s intent for %s: %v", entityType, target, err)
		return true
	}
	if ok, proofErr := proveQdrantIntent(store.Root, intent); proofErr != nil || !ok {
		log.Printf("[search] could not prove qdrant %s intent for %s: %v", entityType, target, proofErr)
		return true
	}
	if err := markQdrantIntentPending(store.Root, intent); err != nil {
		// The intent still goes to the durable queue. If its status watermark
		// cannot be recorded, the queue remains the retry authority and status
		// surfaces the watermark corruption/read failure instead of falling back.
		log.Printf("[search] could not persist qdrant %s readiness for %s: %v", entityType, target, err)
	}
	if _, err := runtimequeue.EnqueueQdrantIntent(store.Root, intent); err != nil {
		log.Printf("[search] could not queue qdrant %s intent for %s: %v", entityType, target, err)
	}
	return true
}

func scheduleBestEffort(store *storage.Store, action, target string, fn func(*IndexService) error) {
	if store == nil {
		return
	}
	backgroundIndexer.SubmitAfter(indexJobKey{root: store.Root, action: action, target: target}, entityIndexDebounce(action), func() {
		runBestEffort(store, action+" "+target, fn)
	})
}

func runBestEffort(store *storage.Store, action string, fn func(*IndexService) error) {
	if store == nil {
		return
	}

	embedder, vecStore, err := InitSemantic(store)
	if err != nil {
		if !errors.Is(err, ErrSemanticNotConfigured) {
			log.Printf("[search] could not %s: %v", action, err)
		}
		return
	}
	defer embedder.Close()
	defer vecStore.Close()

	if err := fn(NewIndexService(store, embedder, vecStore)); err != nil {
		log.Printf("[search] could not %s: %v", action, err)
	}
}

func indexQueueDelay() time.Duration {
	const defaultMs = 500
	if raw := os.Getenv("KNOWNS_INDEX_QUEUE_DELAY_MS"); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err == nil {
			if ms <= 0 {
				return 0
			}
			return time.Duration(ms) * time.Millisecond
		}
	}
	return defaultMs * time.Millisecond
}

func codeIndexDebounce(action string) time.Duration {
	if strings.HasPrefix(action, "remove-") || action == "index-all-files" {
		return 0
	}
	return durationFromEnvMs("KNOWNS_CODE_INDEX_DEBOUNCE_MS", 1000)
}

func entityIndexDebounce(action string) time.Duration {
	if strings.HasPrefix(action, "remove-") {
		return 0
	}
	return durationFromEnvMs("KNOWNS_ENTITY_INDEX_DEBOUNCE_MS", 5000)
}

func durationFromEnvMs(envKey string, defaultMs int) time.Duration {
	if raw := os.Getenv(envKey); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err == nil {
			if ms <= 0 {
				return 0
			}
			return time.Duration(ms) * time.Millisecond
		}
	}
	return time.Duration(defaultMs) * time.Millisecond
}
