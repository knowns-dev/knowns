package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/qdrantruntime"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// ExecuteRuntimeJob runs a queued runtime job synchronously inside the shared runtime.
func ExecuteRuntimeJob(storeRoot string, job runtimequeue.Job) error {
	store := storage.NewStore(storeRoot)
	defer func() {
		_ = PersistDefaultSemanticRuntimeStatus()
	}()
	if resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
		switch job.Kind {
		case runtimequeue.JobIndexTask, runtimequeue.JobRemoveTask:
			intent, intentErr := currentQdrantIntent(storeRoot, "task", job.Target, job.Kind == runtimequeue.JobRemoveTask, "")
			if intentErr != nil {
				return fmt.Errorf("build targeted qdrant task intent: %w", intentErr)
			}
			return ExecuteQdrantReconciliation(context.Background(), storeRoot, intent)
		case runtimequeue.JobIndexDoc, runtimequeue.JobRemoveDoc:
			intent, intentErr := currentQdrantIntent(storeRoot, "doc", job.Target, job.Kind == runtimequeue.JobRemoveDoc, "")
			if intentErr != nil {
				return fmt.Errorf("build targeted qdrant doc intent: %w", intentErr)
			}
			return ExecuteQdrantReconciliation(context.Background(), storeRoot, intent)
		}
	}
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
	case runtimequeue.JobReconcileKnowledge:
		reconciler, err := storage.NewFilesystemReconciler(storeRoot, func(result storage.ReconcileResult) error {
			if resolveEffectiveVectorStore(store).Backend != models.SemanticVectorBackendQdrant {
				kind := runtimequeue.JobIndexDoc
				if result.Operation == storage.LifecycleOperationDelete || result.Operation == storage.LifecycleOperationHardDelete {
					kind = runtimequeue.JobRemoveDoc
				}
				target := result.Path
				if result.EntityType == "task" {
					kind, target = runtimequeue.JobIndexTask, result.EntityID
					if result.Operation == storage.LifecycleOperationDelete || result.Operation == storage.LifecycleOperationHardDelete {
						kind = runtimequeue.JobRemoveTask
					}
				}
				_, enqueueErr := runtimequeue.Enqueue(storeRoot, kind, target)
				return enqueueErr
			}
			path := result.CurrentPath
			if path == "" {
				path = result.Path
			}
			_, enqueueErr := runtimequeue.EnqueueQdrantIntent(storeRoot, runtimequeue.QdrantIntent{
				EntityType: result.EntityType, EntityID: result.EntityID,
				Revision: result.Revision, Operation: result.Operation,
				CanonicalHash: result.NewHash, Path: path,
				PreviousPath: result.PreviousPath, BatchID: result.BatchID,
			})
			return enqueueErr
		})
		if err != nil {
			return err
		}
		_, err = reconciler.ReconcileLifecycleWithOptions(context.Background(), true, storage.LifecycleOptions{Source: "runtime-job", Wait: true})
		return err
	case runtimequeue.JobQdrantReconcile:
		if job.Intent == nil {
			return fmt.Errorf("qdrant reconciliation job has no intent")
		}
		return ExecuteQdrantReconciliation(context.Background(), storeRoot, *job.Intent)
	case runtimequeue.JobReindex:
		resolved := resolveEffectiveVectorStore(store)
		if resolved.Backend == models.SemanticVectorBackendQdrant && resolved.Mode == models.SemanticVectorStoreModeManaged {
			mgr := qdrantruntime.NewManager(qdrantruntime.ConfigFromResolution(resolved))
			if _, err := (qdrantruntime.Installer{Root: mgr.Paths().Root, Mirror: os.Getenv("KNOWNS_QDRANT_MIRROR")}).Install(context.Background()); err != nil {
				return fmt.Errorf("install managed Qdrant: %w", err)
			}
			if _, err := mgr.Start(context.Background()); err != nil {
				return fmt.Errorf("start managed Qdrant: %w", err)
			}
		}
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
		if resolveEffectiveVectorStore(store).Backend == models.SemanticVectorBackendQdrant {
			client, clientErr := qdrantClientForStore(store)
			if clientErr != nil {
				return clientErr
			}
			res := resolveEffectiveVectorStore(store)
			keep, ttl := retentionFromResolution(res)
			_, reindexErr := ReindexQdrantGeneration(context.Background(), store, session.Embedder, QdrantGenerationOptions{Client: client, RetentionGenerations: keep, RetentionTTL: ttl, Progress: func(phase string, current, total int) {
				_ = runtimequeue.ReportProgress(storeRoot, job.ID, phase, current, total)
			}})
			return reindexErr
		}
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
	if req.HasTaskSnapshot {
		req.Options.taskSnapshot = taskSnapshotFromValues(req.TaskSnapshot)
		req.Options.taskVisibility = taskVisibility(req.TaskVisibility)
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
