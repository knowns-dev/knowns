package search

import (
	"fmt"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// QdrantHitValidationContext provides canonical store and embedding identity
// checks for pointer-only Qdrant hits before snippets/context are assembled.
type QdrantHitValidationContext struct {
	Store              *storage.Store
	Pointer            *QdrantPointer
	ExpectedModel      string
	ExpectedDimensions int
}

// QdrantHitValidationResult reports whether one Qdrant hit is safe to use.
type QdrantHitValidationResult struct {
	Valid              bool     `json:"valid"`
	Stale              bool     `json:"stale,omitempty"`
	Reasons            []string `json:"reasons,omitempty"`
	ReindexRecommended bool     `json:"reindexRecommended,omitempty"`
}

// QdrantHitValidationSummary summarizes a validated Qdrant result set.
type QdrantHitValidationSummary struct {
	Checked            int      `json:"checked"`
	Dropped            int      `json:"dropped,omitempty"`
	ReindexRecommended bool     `json:"reindexRecommended,omitempty"`
	Reasons            []string `json:"reasons,omitempty"`
}

func (r QdrantHitValidationResult) reasonString() string {
	return strings.Join(r.Reasons, "; ")
}

// ValidateQdrantHitPayload validates pointer metadata and canonical source state
// for a Qdrant payload. Raw content is not read from Qdrant; snippets/context
// must come from canonical files after this validation passes.
func ValidateQdrantHitPayload(ctx QdrantHitValidationContext, payload map[string]any) (Chunk, QdrantHitValidationResult) {
	chunk := ChunkFromQdrantPayload(payload)
	result := QdrantHitValidationResult{Valid: true}
	fail := func(reason string) {
		result.Valid = false
		result.Stale = true
		result.ReindexRecommended = true
		result.Reasons = append(result.Reasons, reason)
	}
	if chunk.ID == "" {
		fail("missing chunk_id")
	}
	if payloadString(payload, qdrantPayloadSourceID) == "" {
		fail("missing source_id")
	}
	if payloadInt(payload, qdrantPayloadChunkVersion) != 0 && payloadInt(payload, qdrantPayloadChunkVersion) != ChunkVersion {
		fail(fmt.Sprintf("payload chunk_version %d != current %d", payloadInt(payload, qdrantPayloadChunkVersion), ChunkVersion))
	}
	if ctx.Pointer == nil {
		fail("missing qdrant pointer")
	} else {
		if ctx.Pointer.ChunkVersion != ChunkVersion {
			fail(fmt.Sprintf("pointer chunk version %d != current %d", ctx.Pointer.ChunkVersion, ChunkVersion))
		}
		if ctx.ExpectedModel != "" && ctx.Pointer.Embedding.Model != "" && ctx.Pointer.Embedding.Model != ctx.ExpectedModel {
			fail(fmt.Sprintf("pointer model %q != expected %q", ctx.Pointer.Embedding.Model, ctx.ExpectedModel))
		}
		if ctx.ExpectedDimensions > 0 && ctx.Pointer.Embedding.Dimensions > 0 && ctx.Pointer.Embedding.Dimensions != ctx.ExpectedDimensions {
			fail(fmt.Sprintf("pointer dimensions %d != expected %d", ctx.Pointer.Embedding.Dimensions, ctx.ExpectedDimensions))
		}
	}
	if ctx.Store == nil {
		fail("missing canonical store")
		return chunk, result
	}
	canonicalHash, found, err := canonicalContentHashForChunk(ctx.Store, chunk)
	if err != nil {
		fail(err.Error())
	} else if !found {
		fail("canonical source does not exist")
	} else if payloadHash := payloadString(payload, qdrantPayloadContentHash); payloadHash != "" && canonicalHash != payloadHash {
		fail("content hash mismatch")
	}
	return chunk, result
}

// QdrantScoredPayload is the raw score+payload form returned by Qdrant before
// canonical source validation maps it back to ScoredChunk.
type QdrantScoredPayload struct {
	Score   float64
	Payload map[string]any
}

// ValidateQdrantPayloads validates and maps raw Qdrant payloads, dropping stale
// hits before result assembly can read snippets/context from canonical sources.
func ValidateQdrantPayloads(ctx QdrantHitValidationContext, scored []QdrantScoredPayload) ([]ScoredChunk, QdrantHitValidationSummary) {
	summary := QdrantHitValidationSummary{Checked: len(scored)}
	out := make([]ScoredChunk, 0, len(scored))
	seenReason := map[string]bool{}
	for _, hit := range scored {
		chunk, validation := ValidateQdrantHitPayload(ctx, hit.Payload)
		if !validation.Valid {
			summary.Dropped++
			if validation.ReindexRecommended {
				summary.ReindexRecommended = true
			}
			for _, reason := range validation.Reasons {
				if !seenReason[reason] {
					seenReason[reason] = true
					summary.Reasons = append(summary.Reasons, reason)
				}
			}
			continue
		}
		out = append(out, ScoredChunk{Chunk: chunk, Score: hit.Score})
	}
	return out, summary
}

func canonicalContentHashForChunk(store *storage.Store, chunk Chunk) (string, bool, error) {
	switch chunk.Type {
	case ChunkTypeDoc:
		if chunk.DocPath == "" {
			return "", false, nil
		}
		doc, err := store.Docs.Get(chunk.DocPath)
		if err != nil {
			return "", false, nil
		}
		return contentHash(doc.Title + "\n" + doc.Description + "\n" + doc.Content), true, nil
	case ChunkTypeTask:
		if chunk.TaskID == "" {
			return "", false, nil
		}
		task, err := store.Tasks.Get(chunk.TaskID)
		if err != nil {
			return "", false, nil
		}
		return contentHash(taskContentForHash(task)), true, nil
	case ChunkTypeMemory:
		entry, err := memoryEntryForValidation(store, chunk)
		if err != nil || entry == nil {
			return "", false, nil
		}
		return contentHash(entry.Title + "\n" + entry.Category + "\n" + entry.Content), true, nil
	case ChunkTypeDecision:
		if chunk.DecisionID == "" {
			return "", false, nil
		}
		decision, err := store.Decisions.Get(chunk.DecisionID)
		if err != nil {
			return "", false, nil
		}
		return contentHash(decisionContentForHash(decision)), true, nil
	default:
		return "", false, fmt.Errorf("unsupported qdrant hit type %q", chunk.Type)
	}
}

func memoryEntryForValidation(store *storage.Store, chunk Chunk) (*models.MemoryEntry, error) {
	if chunk.MemoryID == "" {
		return nil, fmt.Errorf("memory_id is required")
	}
	if chunk.MemoryLayer != "" {
		return store.Memory.GetInLayer(chunk.MemoryID, chunk.MemoryLayer)
	}
	return store.Memory.Get(chunk.MemoryID)
}
