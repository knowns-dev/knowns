package search

import (
	"errors"
	"fmt"
	"path/filepath"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// ExecuteRuntimeJob runs a queued runtime job synchronously inside the shared runtime.
func ExecuteRuntimeJob(storeRoot string, job runtimequeue.Job) error {
	store := storage.NewStore(storeRoot)
	switch job.Kind {
	case runtimequeue.JobIndexTask:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.IndexTask(job.Target)
		})
	case runtimequeue.JobIndexDoc:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.IndexDoc(job.Target)
		})
	case runtimequeue.JobRemoveTask:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.RemoveTask(job.Target)
		})
	case runtimequeue.JobRemoveDoc:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.RemoveDoc(job.Target)
		})
	case runtimequeue.JobIndexMemory:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.IndexMemory(job.Target)
		})
	case runtimequeue.JobRemoveMemory:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.RemoveMemory(job.Target)
		})
	case runtimequeue.JobIndexFile:
		projectRoot := filepath.Dir(storeRoot)
		absPath := filepath.Join(projectRoot, job.Target)
		return executeRuntimeCode(store, string(job.Kind)+" "+job.Target, func(embedder EmbedderProvider, vecStore VectorStore) error {
			syms, _, err := IndexFile(job.Target, absPath)
			if err != nil || len(syms) == 0 {
				return err
			}
			prefix := fmt.Sprintf("code::%s::", job.Target)
			vecStore.RemoveByPrefix(prefix)
			var chunks []Chunk
			for _, sym := range syms {
				chunk := sym.ToChunk()
				vec, err := embedder.EmbedDocument(chunk.Content)
				if err != nil {
					continue
				}
				chunk.Embedding = vec
				chunks = append(chunks, chunk)
			}
			vecStore.AddChunks(chunks)
			if err := vecStore.Save(); err != nil {
				return err
			}

			allSyms, allEdges, err := IndexAllFiles(projectRoot, false)
			if err != nil || len(allSyms) == 0 {
				return err
			}
			db := store.SemanticDBWritable()
			if db == nil {
				return nil
			}
			defer db.Close()
			return SaveCodeEdges(db, ResolveCodeEdges(allSyms, allEdges))
		})
	case runtimequeue.JobRemoveFile:
		return executeRuntimeCode(store, string(job.Kind)+" "+job.Target, func(_ EmbedderProvider, vecStore VectorStore) error {
			projectRoot := filepath.Dir(storeRoot)
			vecStore.RemoveByPrefix(fmt.Sprintf("code::%s::", job.Target))
			if err := vecStore.Save(); err != nil {
				return err
			}

			allSyms, allEdges, err := IndexAllFiles(projectRoot, false)
			if err != nil {
				return err
			}
			db := store.SemanticDBWritable()
			if db == nil {
				return nil
			}
			defer db.Close()
			return SaveCodeEdges(db, ResolveCodeEdges(allSyms, allEdges))
		})
	case runtimequeue.JobIndexAll:
		projectRoot := filepath.Dir(storeRoot)
		return executeRuntimeCode(store, string(job.Kind)+" "+projectRoot, func(embedder EmbedderProvider, vecStore VectorStore) error {
			_ = runtimequeue.ReportProgress(storeRoot, job.ID, "parsing", 0, 0)
			syms, edges, err := IndexAllFiles(projectRoot, false)
			if err != nil {
				return err
			}
			vecStore.RemoveByPrefix("code::")
			var chunks []Chunk
			total := len(syms)
			_ = runtimequeue.ReportProgress(storeRoot, job.ID, "embedding", 0, total)
			for i, sym := range syms {
				chunk := sym.ToChunk()
				vec, embedErr := embedder.EmbedDocument(chunk.Content)
				if embedErr != nil {
					continue
				}
				chunk.Embedding = vec
				chunks = append(chunks, chunk)
				if total > 0 && (i+1)%25 == 0 {
					_ = runtimequeue.ReportProgress(storeRoot, job.ID, "embedding", i+1, total)
				}
			}
			_ = runtimequeue.ReportProgress(storeRoot, job.ID, "saving", total, total)
			vecStore.AddChunks(chunks)
			if err := vecStore.Save(); err != nil {
				return err
			}
			if len(edges) == 0 {
				return nil
			}
			db := store.SemanticDBWritable()
			if db == nil {
				return nil
			}
			defer db.Close()
			resolvedEdges := ResolveCodeEdges(syms, edges)
			return SaveCodeEdges(db, resolvedEdges)
		})
	case runtimequeue.JobReindex:
		embedder, vecStore, err := InitSemantic(store)
		if err != nil {
			if errors.Is(err, ErrSemanticNotConfigured) {
				return nil
			}
			return err
		}
		if embedder == nil || vecStore == nil {
			return nil
		}
		defer embedder.Close()
		defer vecStore.Close()
		return NewEngine(store, embedder, vecStore).Reindex(func(phase string, current, total int) {
			_ = runtimequeue.ReportProgress(storeRoot, job.ID, phase, current, total)
		})
	default:
		return fmt.Errorf("unsupported runtime job kind: %s", job.Kind)
	}
}

func executeRuntimeEntity(store *storage.Store, action string, fn func(*IndexService) error) error {
	if store == nil {
		return nil
	}
	embedder, vecStore, err := InitSemantic(store)
	if err != nil {
		if errors.Is(err, ErrSemanticNotConfigured) {
			return nil
		}
		return fmt.Errorf("could not %s: %w", action, err)
	}
	defer embedder.Close()
	defer vecStore.Close()
	return fn(NewIndexService(store, embedder, vecStore))
}

func executeRuntimeCode(store *storage.Store, action string, fn func(EmbedderProvider, VectorStore) error) error {
	if store == nil {
		return nil
	}
	embedder, vecStore, err := InitSemantic(store)
	if err != nil {
		if errors.Is(err, ErrSemanticNotConfigured) {
			return nil
		}
		return fmt.Errorf("could not %s: %w", action, err)
	}
	defer embedder.Close()
	defer vecStore.Close()
	return fn(embedder, vecStore)
}
