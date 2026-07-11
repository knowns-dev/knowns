package search

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// ExecuteRuntimeJob runs a queued runtime job synchronously inside the shared runtime.
func ExecuteRuntimeJob(storeRoot string, job runtimequeue.Job) error {
	store := storage.NewStore(storeRoot)
	defer func() {
		_ = PersistDefaultSemanticRuntimeStatus()
	}()
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
	case runtimequeue.JobIndexDecision:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.IndexDecision(job.Target)
		})
	case runtimequeue.JobRemoveDecision:
		return executeRuntimeEntity(store, string(job.Kind)+" "+job.Target, func(svc *IndexService) error {
			return svc.RemoveDecision(job.Target)
		})
	case runtimequeue.JobSemanticSearch:
		return executeRuntimeSemanticSearch(storeRoot, store, job)
	case runtimequeue.JobReindex:
		session, err := InitSemanticRuntimeSession(store)
		if err != nil {
			if errors.Is(err, ErrSemanticNotConfigured) || errors.Is(err, ErrSemanticRuntimeDisabled) {
				return nil
			}
			return err
		}
		if session == nil || session.Embedder == nil || session.VecStore == nil {
			return nil
		}
		defer session.Close()
		return session.Engine(store).Reindex(func(phase string, current, total int) {
			_ = runtimequeue.ReportProgress(storeRoot, job.ID, phase, current, total)
		})
	case runtimequeue.JobIndexFile, runtimequeue.JobRemoveFile, runtimequeue.JobIndexAll:
		return nil
	default:
		return fmt.Errorf("unsupported runtime job kind: %s", job.Kind)
	}
}

func executeRuntimeSemanticSearch(storeRoot string, store *storage.Store, job runtimequeue.Job) error {
	req, err := readSemanticSearchRuntimeRequest(job.Target)
	if err != nil {
		return fmt.Errorf("read semantic search request: %w", err)
	}
	resp, err := searchWithLocalRuntime(store, req.Options)
	if err != nil {
		return err
	}
	data, err := json.Marshal(resp)
	if err != nil {
		return fmt.Errorf("encode semantic search response: %w", err)
	}
	return runtimequeue.ReportDetails(storeRoot, job.ID, runtimequeue.JobDetails{
		Phase:  "semantic-search",
		Result: data,
	})
}

func executeRuntimeEntity(store *storage.Store, action string, fn func(*IndexService) error) error {
	if store == nil {
		return nil
	}
	session, err := InitSemanticRuntimeSession(store)
	if err != nil {
		if errors.Is(err, ErrSemanticNotConfigured) || errors.Is(err, ErrSemanticRuntimeDisabled) {
			return nil
		}
		return fmt.Errorf("could not %s: %w", action, err)
	}
	defer session.Close()
	return fn(session.IndexService(store))
}
