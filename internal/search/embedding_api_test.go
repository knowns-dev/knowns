package search

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// embedderTestServer records the inputs it is asked to embed and answers with
// vectors of the requested width.
func embedderTestServer(t *testing.T, dims int, seen *[][]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req openaiEmbeddingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		*seen = append(*seen, req.Input)
		resp := openaiEmbeddingResponse{Object: "list", Model: req.Model}
		for i := range req.Input {
			resp.Data = append(resp.Data, openaiEmbeddingDatum{
				Object:    "embedding",
				Index:     i,
				Embedding: make([]float32, dims),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// An asymmetric model is trained with distinct query and passage markers, and
// the OpenAI embeddings API cannot express that distinction itself. Embedding
// both sides identically silently discards it, so the prefixes must reach the
// request body and must not leak into the wrong side.
func TestAPIEmbedderAppliesAsymmetricPrefixes(t *testing.T) {
	var seen [][]string
	srv := embedderTestServer(t, 4, &seen)
	embedder, err := NewAPIEmbedder(APIEmbedderConfig{
		APIBase:     srv.URL,
		Model:       "test-model",
		Dimensions:  4,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	})
	if err != nil {
		t.Fatalf("NewAPIEmbedder() error = %v", err)
	}

	if _, err := embedder.EmbedQuery("authentication flow"); err != nil {
		t.Fatalf("EmbedQuery() error = %v", err)
	}
	if _, err := embedder.EmbedDocument("authentication flow"); err != nil {
		t.Fatalf("EmbedDocument() error = %v", err)
	}
	if len(seen) != 2 {
		t.Fatalf("requests = %d, want 2", len(seen))
	}
	if got := seen[0][0]; got != "query: authentication flow" {
		t.Fatalf("query input = %q", got)
	}
	if got := seen[1][0]; got != "passage: authentication flow" {
		t.Fatalf("document input = %q", got)
	}
}

// The batch paths carry the same asymmetry as the single-text paths. Index
// writes and searches both go through them, so a prefix applied to only one
// shape would embed the corpus and the query differently.
func TestAPIEmbedderAppliesPrefixesToBatches(t *testing.T) {
	var seen [][]string
	srv := embedderTestServer(t, 4, &seen)
	embedder, err := NewAPIEmbedder(APIEmbedderConfig{
		APIBase:     srv.URL,
		Model:       "test-model",
		Dimensions:  4,
		QueryPrefix: "query: ",
		DocPrefix:   "passage: ",
	})
	if err != nil {
		t.Fatalf("NewAPIEmbedder() error = %v", err)
	}

	texts := []string{"alpha", "beta"}
	if _, err := embedder.EmbedQueryBatch(texts); err != nil {
		t.Fatalf("EmbedQueryBatch() error = %v", err)
	}
	if _, err := embedder.EmbedDocumentBatch(texts); err != nil {
		t.Fatalf("EmbedDocumentBatch() error = %v", err)
	}
	for _, in := range seen[0] {
		if !strings.HasPrefix(in, "query: ") {
			t.Fatalf("query batch input %q lacks the query prefix", in)
		}
	}
	for _, in := range seen[1] {
		if !strings.HasPrefix(in, "passage: ") {
			t.Fatalf("document batch input %q lacks the document prefix", in)
		}
	}
	// The caller's slice is reused for storage and logging, where the prefix
	// must not appear.
	if texts[0] != "alpha" || texts[1] != "beta" {
		t.Fatalf("caller slice was mutated: %#v", texts)
	}
}

// A model with no prefixes configured must be sent the text unchanged, so
// symmetric models are not silently poisoned with a marker they never saw in
// training.
func TestAPIEmbedderWithoutPrefixesSendsTextUnchanged(t *testing.T) {
	var seen [][]string
	srv := embedderTestServer(t, 4, &seen)
	embedder, err := NewAPIEmbedder(APIEmbedderConfig{
		APIBase:    srv.URL,
		Model:      "test-model",
		Dimensions: 4,
	})
	if err != nil {
		t.Fatalf("NewAPIEmbedder() error = %v", err)
	}
	if _, err := embedder.EmbedQuery("plain"); err != nil {
		t.Fatalf("EmbedQuery() error = %v", err)
	}
	if got := seen[0][0]; got != "plain" {
		t.Fatalf("input = %q, want unchanged", got)
	}
}

// MaxTokens drives chunk sizing. A constant here truncated long-context models
// to a fraction of what they accept, so the configured value must win and the
// fallback must only apply when nothing is configured.
func TestAPIEmbedderModelConfigMaxTokens(t *testing.T) {
	for _, test := range []struct {
		name       string
		configured int
		want       int
	}{
		{"configured limit is used", 32768, 32768},
		{"unset falls back", 0, defaultAPIMaxTokens},
		{"negative falls back", -1, defaultAPIMaxTokens},
	} {
		t.Run(test.name, func(t *testing.T) {
			embedder, err := NewAPIEmbedder(APIEmbedderConfig{
				APIBase:    "http://127.0.0.1:1",
				Model:      "test-model",
				Dimensions: 4,
				MaxTokens:  test.configured,
			})
			if err != nil {
				t.Fatalf("NewAPIEmbedder() error = %v", err)
			}
			if got := embedder.ModelConfig().MaxTokens; got != test.want {
				t.Fatalf("MaxTokens = %d, want %d", got, test.want)
			}
		})
	}
}
