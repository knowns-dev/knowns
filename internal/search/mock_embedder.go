package search

import (
	"crypto/sha256"
	"encoding/binary"
	"math"
	"os"
	"strings"
)

// EnvMockEmbedder switches semantic search onto a deterministic in-process
// embedder. It exists so CI can gate the semantic and hybrid retrieval paths
// without an Ollama runtime, a model download, or a network call.
const EnvMockEmbedder = "KNOWNS_EMBED_MOCK"

// mockEmbedderDimensions is small enough to keep fixtures and baselines cheap
// and large enough that unrelated texts do not collide into the same direction.
const mockEmbedderDimensions = 32

// MockEmbedderEnabled reports whether the deterministic embedder is requested.
func MockEmbedderEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvMockEmbedder))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// mockEmbedder derives a vector from the text itself, so the same text always
// embeds to the same direction and different texts embed to different ones.
//
// The distinction from the constant-vector stub used in unit tests matters. A
// stub that answers every input with the same vector makes every document score
// identically, so ranking becomes arbitrary and an evaluation over it measures
// nothing. Deriving the vector from a hash of the text keeps ranking well
// defined and reproducible on any machine.
//
// What this gates is behaviour, not quality. These vectors carry no meaning, so
// "search quality improvements" and "improve search quality" point in unrelated
// directions and human relevance judgements do not survive. A baseline recorded
// against this embedder answers "does the ranking pipeline still behave the way
// it did", which is what catches a change to the similarity threshold, the RRF
// constant, the candidate window, or tie-breaking. It does not answer whether
// retrieval is any good; that still needs real embeddings.
type mockEmbedder struct{}

// NewMockEmbedder returns the deterministic embedder used when EnvMockEmbedder
// is set.
func NewMockEmbedder() EmbedderProvider { return mockEmbedder{} }

func (mockEmbedder) vector(text string) []float32 {
	vec := make([]float32, mockEmbedderDimensions)
	// One hash per block of 8 dimensions, chained so every dimension depends on
	// the whole text rather than on a prefix of it.
	sum := sha256.Sum256([]byte(text))
	var norm float64
	for i := 0; i < mockEmbedderDimensions; i++ {
		if i > 0 && i%8 == 0 {
			sum = sha256.Sum256(sum[:])
		}
		offset := (i % 8) * 4
		bits := binary.BigEndian.Uint32(sum[offset : offset+4])
		// Map into [-1, 1) so vectors spread across the sphere instead of
		// crowding one octant, which would make every cosine similarity high.
		v := float64(bits)/float64(math.MaxUint32)*2 - 1
		vec[i] = float32(v)
		norm += v * v
	}
	if norm == 0 {
		vec[0] = 1
		return vec
	}
	inv := float32(1 / math.Sqrt(norm))
	for i := range vec {
		vec[i] *= inv
	}
	return vec
}

func (m mockEmbedder) Embed(text string) ([]float32, error)         { return m.vector(text), nil }
func (m mockEmbedder) EmbedDocument(text string) ([]float32, error) { return m.vector(text), nil }
func (m mockEmbedder) EmbedQuery(text string) ([]float32, error)    { return m.vector(text), nil }

func (m mockEmbedder) EmbedBatch(texts []string) ([][]float32, error) {
	out := make([][]float32, len(texts))
	for i, t := range texts {
		out[i] = m.vector(t)
	}
	return out, nil
}

func (m mockEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error) {
	return m.EmbedBatch(texts)
}
func (m mockEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error) {
	return m.EmbedBatch(texts)
}

func (mockEmbedder) Dimensions() int { return mockEmbedderDimensions }

func (mockEmbedder) ModelConfig() EmbeddingModelConfig {
	return EmbeddingModelConfig{Name: "mock-deterministic", Dimensions: mockEmbedderDimensions, MaxTokens: 8192}
}

func (mockEmbedder) GetTokenizer() Tokenizer { return nil }
func (mockEmbedder) Close()                  {}
