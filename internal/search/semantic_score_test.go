package search

import (
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

// TestMergeKeepsCosineForAHitFoundByBothLayers covers the strongest kind of
// match. mergeResults keeps the KEYWORD record when a source is found by both
// layers and only adds to its fused rank, so a field present only on the
// semantic record was dropped: the memory that matched best on every signal
// was the one left with no similarity.
func TestMergeKeepsCosineForAHitFoundByBothLayers(t *testing.T) {
	kw := []models.SearchResult{{Type: "memory", ID: "m1", MemoryStore: "global-store", Score: 3.2}}
	sem := []models.SearchResult{{Type: "memory", ID: "m1", MemoryStore: "global-store", Score: 0.71, SemanticScore: 0.71}}

	merged := mergeResults(kw, sem, 0)
	if len(merged) != 1 {
		t.Fatalf("merged = %d results, want the two records folded into one", len(merged))
	}
	if merged[0].SemanticScore != 0.71 {
		t.Fatalf("SemanticScore = %v, want 0.71 carried over from the semantic record", merged[0].SemanticScore)
	}
	if len(merged[0].MatchedBy) != 2 {
		t.Fatalf("MatchedBy = %v, want both layers", merged[0].MatchedBy)
	}
}

// TestSemanticScoreIsTheBestChunkNotTheMultiChunkBonus pins what the field
// means. Score adds 10% for every extra matching chunk, which favours long
// sources; SemanticScore must be the best chunk's cosine alone, or a long
// memory would clear the relevance floor on length.
func TestSemanticScoreIsTheBestChunkNotTheMultiChunkBonus(t *testing.T) {
	e := &Engine{}
	scored := []ScoredChunk{
		{Chunk: Chunk{ID: "memory:m1:chunk:content", Type: ChunkTypeMemory, MemoryID: "m1", MemoryStore: "global-store"}, Score: 0.70},
		{Chunk: Chunk{ID: "memory:m1:chunk:content:1", Type: ChunkTypeMemory, MemoryID: "m1", MemoryStore: "global-store"}, Score: 0.60},
	}

	results, err := e.scoredChunksToResults(scored, SearchOptions{}, "semantic", "q")
	if err != nil {
		t.Fatalf("scoredChunksToResults: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want the two chunks folded into one source", len(results))
	}
	if results[0].SemanticScore != 0.70 {
		t.Fatalf("SemanticScore = %v, want the best chunk's cosine 0.70", results[0].SemanticScore)
	}
	if results[0].Score <= 0.70 {
		t.Fatalf("Score = %v; expected it to keep its multi-chunk bonus, which is exactly why it cannot carry a threshold", results[0].Score)
	}

	// A keyword hit has no cosine and must not pretend to.
	kw, err := e.scoredChunksToResults(scored, SearchOptions{}, "keyword", "q")
	if err != nil {
		t.Fatalf("keyword scoredChunksToResults: %v", err)
	}
	if kw[0].SemanticScore != 0 {
		t.Fatalf("keyword SemanticScore = %v, want 0", kw[0].SemanticScore)
	}
}
