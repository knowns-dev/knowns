package search

import (
	"strings"
	"testing"
)

// longContextEmbedder reports a context limit far above the 512-token fallback
// that the removed EmbeddingModels table used to hand out. qwen3-embedding:0.6b
// is registered at 32768 tokens, so this is a real configuration rather than a
// hypothetical one.
type longContextEmbedder struct {
	stubEmbedder
	maxTokens int
}

func (e longContextEmbedder) ModelConfig() EmbeddingModelConfig {
	return EmbeddingModelConfig{Name: "long-context", Dimensions: 1, MaxTokens: e.maxTokens}
}

// TestChunkMaxTokensFollowsEmbedderContextLimit is AC-18 of spec
// ollama-only-embedding, and it is the only thing that proves FR-12 landed.
//
// The failure this guards against is silent. Chunk sizing used to resolve
// through EmbeddingModels keyed by model name; once that table was removed, a
// lookup left behind would simply miss and every model would chunk at the 512
// fallback — no compile error, no failing test, just long-context models
// truncated to a fraction of what they accept. A green suite does not detect
// it, because the old tests were written against the old table.
//
// So this asserts the value actually reaches the chunker, not merely that the
// embedder can report it.
func TestChunkMaxTokensFollowsEmbedderContextLimit(t *testing.T) {
	const configured = 32768

	svc := &IndexService{embedder: longContextEmbedder{maxTokens: configured}}
	if got := svc.chunkMaxTokens(); got != configured {
		t.Fatalf("chunkMaxTokens() = %d, want %d — chunk sizing is not resolving through the embedder's model config", got, configured)
	}

	// The fixture has to match how ChunkDocument actually splits: per heading
	// section, and within an oversize section by paragraph. A single huge
	// paragraph is indivisible and would chunk identically at both limits,
	// proving nothing. So this is a heading with many paragraphs, large
	// enough that 512 tokens must break it up while the configured limit
	// holds it whole. Chunk count is the observable difference between the
	// two, so it is what the assertion rests on.
	content := "## Section\n\n" + strings.Repeat("the quick brown fox jumps over the lazy dog.\n\n", 400)

	atConfigured := ChunkDocument(content, "doc.md", "Doc", "", svc.chunkMaxTokens(), nil)
	atFallback := ChunkDocument(content, "doc.md", "Doc", "", 512, nil)

	if len(atFallback.Chunks) <= 1 {
		t.Fatalf("fixture is too small to distinguish the limits: 512-token chunking produced %d chunk(s); lengthen the document", len(atFallback.Chunks))
	}
	if len(atConfigured.Chunks) >= len(atFallback.Chunks) {
		t.Fatalf("chunks at the configured %d-token limit = %d, at the 512 fallback = %d; the configured limit is not being honoured",
			configured, len(atConfigured.Chunks), len(atFallback.Chunks))
	}
}

// TestChunkMaxTokensFallsBackWithoutAConfiguredLimit guards the other side, so
// the fix above cannot be "return a large constant". An embedder that reports
// no limit must still get the conservative default.
func TestChunkMaxTokensFallsBackWithoutAConfiguredLimit(t *testing.T) {
	svc := &IndexService{embedder: stubEmbedder{}}
	if got := svc.chunkMaxTokens(); got != 512 {
		t.Fatalf("chunkMaxTokens() with no configured limit = %d, want the 512 fallback", got)
	}

	var nilEmbedder *IndexService = &IndexService{}
	if got := nilEmbedder.chunkMaxTokens(); got != 512 {
		t.Fatalf("chunkMaxTokens() with no embedder = %d, want the 512 fallback", got)
	}
}
