package search

import (
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

func BestEffortRemoveDoc(store *storage.Store, docPath string) {
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

// BestEffortIndexAll reindexes docs, tasks, and memories.
// Safe to call from a goroutine; errors are logged, not returned.
// No-op if semantic search is not configured.
func BestEffortIndexAll(store *storage.Store, projectRoot string) {
	_ = enqueueRuntimeJob(store, runtimequeue.JobReindex, projectRoot, func() {
		scheduleBestEffort(store, "reindex", "all", func(svc *IndexService) error {
			return svc.Reindex(nil)
		})
	})
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
