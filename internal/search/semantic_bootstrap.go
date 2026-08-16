package search

import (
	"errors"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// semanticBootstrapRequest captures whether a non-blocking Qdrant bootstrap was
// requested for a degraded semantic search. It is intentionally small because
// task 05 queues existing reindex work; task 06/07 wire full Qdrant generation
// rebuild and doctor repair.
type semanticBootstrapRequest struct {
	Eligible bool
	Queued   bool
	Reason   string
	Error    string
}

var semanticBootstrapEnqueueReindex = func(storeRoot string) (runtimequeue.Job, error) {
	return runtimequeue.EnqueueReindex(storeRoot)
}

var semanticBootstrapAsync = func(fn func()) { go fn() }

func queueSemanticBootstrapAsync(store *storage.Store, cause error) semanticBootstrapRequest {
	request := semanticBootstrapEligibility(store, cause)
	if !request.Eligible {
		return request
	}
	request.Queued = true
	semanticBootstrapAsync(func() {
		if _, err := semanticBootstrapEnqueueReindex(store.Root); err != nil {
			// The search path must remain non-blocking and keyword-safe. Runtime queue
			// errors are surfaced through status/logs/doctor rather than returned to
			// the user who already received fallback results.
			_ = err
		}
	})
	return request
}

func semanticBootstrapEligibility(store *storage.Store, cause error) semanticBootstrapRequest {
	if errors.Is(cause, ErrSemanticRuntimeDisabled) || errors.Is(cause, ErrSemanticNotConfigured) {
		return semanticBootstrapRequest{Reason: "semantic runtime disabled or not configured"}
	}
	if store == nil {
		return semanticBootstrapRequest{Reason: "no store"}
	}
	res := resolveEffectiveVectorStore(store)
	if !res.Enabled || res.OptedOut || res.Backend == models.SemanticVectorBackendNone {
		return semanticBootstrapRequest{Reason: "semantic vector search disabled"}
	}
	if res.Backend != models.SemanticVectorBackendQdrant {
		return semanticBootstrapRequest{Reason: "semantic backend is not qdrant"}
	}
	if strings.TrimSpace(store.Root) == "" {
		return semanticBootstrapRequest{Reason: "store root is empty"}
	}
	return semanticBootstrapRequest{Eligible: true, Reason: "qdrant bootstrap/reindex queued"}
}

func applySemanticBootstrapMetadata(meta *RuntimeMetadata, bootstrap semanticBootstrapRequest) {
	if meta == nil || !bootstrap.Queued {
		return
	}
	meta.Warming = true
	meta.BootstrapQueued = true
	if bootstrap.Reason != "" {
		if meta.Message == "" {
			meta.Message = bootstrap.Reason
		} else if !strings.Contains(meta.Message, "qdrant bootstrap") {
			meta.Message += "; " + bootstrap.Reason
		}
	}
}
