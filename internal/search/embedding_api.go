package search

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/storage"
)

// APIEmbedder produces embedding vectors via an OpenAI-compatible /v1/embeddings endpoint.
type APIEmbedder struct {
	client     *http.Client
	config     APIEmbedderConfig
	retryOpts  storage.RetryConfig
	dimensions int
}

// APIEmbedderConfig specifies how to create an APIEmbedder.
type APIEmbedderConfig struct {
	APIBase    string // e.g. "http://localhost:11434/v1"
	APIKey     string // Bearer token (optional for local providers)
	Model      string // model name sent to API
	Dimensions int    // expected embedding dimensions
	Timeout    int    // seconds per request (default 30)
	BatchSize  int    // max texts per API call (default 64)
	Retry      storage.RetryConfig
}

// openaiEmbeddingRequest is the request body for /v1/embeddings.
type openaiEmbeddingRequest struct {
	Model string   `json:"model"`
	Input []string `json:"input"`
}

// openaiEmbeddingResponse is the response from /v1/embeddings.
type openaiEmbeddingResponse struct {
	Object string                    `json:"object"`
	Data   []openaiEmbeddingDatum    `json:"data"`
	Model  string                    `json:"model"`
	Usage  *openaiEmbeddingUsage     `json:"usage,omitempty"`
}

type openaiEmbeddingDatum struct {
	Object    string    `json:"object"`
	Index     int       `json:"index"`
	Embedding []float32 `json:"embedding"`
}

type openaiEmbeddingUsage struct {
	PromptTokens int `json:"prompt_tokens"`
	TotalTokens  int `json:"total_tokens"`
}

// NewAPIEmbedder creates an APIEmbedder with the given configuration.
func NewAPIEmbedder(cfg APIEmbedderConfig) (*APIEmbedder, error) {
	if cfg.APIBase == "" {
		return nil, fmt.Errorf("apiBase is required")
	}
	if cfg.Model == "" {
		return nil, fmt.Errorf("model is required")
	}
	if cfg.Dimensions <= 0 {
		return nil, fmt.Errorf("dimensions must be positive")
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 30
	}
	batchSize := cfg.BatchSize
	if batchSize <= 0 {
		batchSize = 64
	}
	retry := cfg.Retry
	if retry.MaxRetries <= 0 {
		retry.MaxRetries = 3
	}
	if retry.InitialDelay <= 0 {
		retry.InitialDelay = 1000
	}
	if retry.MaxDelay <= 0 {
		retry.MaxDelay = 30000
	}

	return &APIEmbedder{
		client: &http.Client{
			Timeout: time.Duration(timeout) * time.Second,
		},
		config: APIEmbedderConfig{
			APIBase:    cfg.APIBase,
			APIKey:     cfg.APIKey,
			Model:      cfg.Model,
			Dimensions: cfg.Dimensions,
			Timeout:    timeout,
			BatchSize:  batchSize,
			Retry:      retry,
		},
		retryOpts:  retry,
		dimensions: cfg.Dimensions,
	}, nil
}

// Embed returns the document embedding for a single text.
func (e *APIEmbedder) Embed(text string) ([]float32, error) {
	return e.EmbedDocument(text)
}

// EmbedDocument returns the document embedding for a single text.
func (e *APIEmbedder) EmbedDocument(text string) ([]float32, error) {
	vecs, err := e.embedBatchRaw([]string{text})
	if err != nil {
		return nil, err
	}
	return vecs[0], nil
}

// EmbedQuery returns the query embedding for a single text.
func (e *APIEmbedder) EmbedQuery(text string) ([]float32, error) {
	// OpenAI-compatible APIs don't distinguish query/doc at the API level;
	// prefix handling is done by the model itself.
	return e.EmbedDocument(text)
}

// EmbedBatch returns document embeddings for multiple texts.
func (e *APIEmbedder) EmbedBatch(texts []string) ([][]float32, error) {
	return e.embedSorted(texts)
}

// EmbedDocumentBatch returns document embeddings for multiple texts.
func (e *APIEmbedder) EmbedDocumentBatch(texts []string) ([][]float32, error) {
	return e.embedSorted(texts)
}

// EmbedQueryBatch returns query embeddings for multiple texts.
func (e *APIEmbedder) EmbedQueryBatch(texts []string) ([][]float32, error) {
	return e.embedSorted(texts)
}

// Dimensions returns the embedding vector dimensionality.
func (e *APIEmbedder) Dimensions() int {
	return e.dimensions
}

// ModelConfig returns an EmbeddingModelConfig for compatibility with existing code.
func (e *APIEmbedder) ModelConfig() EmbeddingModelConfig {
	return EmbeddingModelConfig{
		Name:       e.config.Model,
		Dimensions: e.dimensions,
		MaxTokens:  512, // reasonable default for API models
	}
}

// GetTokenizer returns nil; API handles tokenization internally.
func (e *APIEmbedder) GetTokenizer() Tokenizer {
	return nil
}

// Close is a no-op for the API embedder (HTTP client doesn't need cleanup).
func (e *APIEmbedder) Close() {}

// IsReachable checks if the API endpoint is reachable by sending a minimal request.
func (e *APIEmbedder) IsReachable() bool {
	_, err := e.embedBatchRaw([]string{"test"})
	return err == nil
}

// embedSorted sorts texts by length, batches them, embeds, and returns results in original order.
func (e *APIEmbedder) embedSorted(texts []string) ([][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}

	// Create index mapping for reordering results.
	type indexed struct {
		idx  int
		text string
	}
	items := make([]indexed, len(texts))
	for i, t := range texts {
		items[i] = indexed{idx: i, text: t}
	}

	// Sort by text length (shorter first → less padding waste in API).
	sort.Slice(items, func(i, j int) bool {
		return len(items[i].text) < len(items[j].text)
	})

	// Batch and embed.
	batchSize := e.config.BatchSize
	results := make([][]float32, len(texts))

	for start := 0; start < len(items); start += batchSize {
		end := start + batchSize
		if end > len(items) {
			end = len(items)
		}

		batch := make([]string, end-start)
		for i, item := range items[start:end] {
			batch[i] = item.text
		}

		vecs, err := e.embedBatchRaw(batch)
		if err != nil {
			return nil, fmt.Errorf("embed batch [%d:%d]: %w", start, end, err)
		}

		// Place results back in original order.
		for i, vec := range vecs {
			results[items[start+i].idx] = vec
		}
	}

	return results, nil
}

// embedBatchRaw sends a single batch to the API with retry logic.
func (e *APIEmbedder) embedBatchRaw(texts []string) ([][]float32, error) {
	reqBody := openaiEmbeddingRequest{
		Model: e.config.Model,
		Input: texts,
	}

	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	var lastErr error
	for attempt := 0; attempt <= e.retryOpts.MaxRetries; attempt++ {
		if attempt > 0 {
			delay := e.backoffDelay(attempt)
			time.Sleep(delay)
		}

		vecs, retryable, err := e.doRequest(bodyBytes)
		if err == nil {
			return vecs, nil
		}
		lastErr = err
		if !retryable {
			return nil, err
		}
	}

	return nil, fmt.Errorf("embedding API failed after %d retries: %w", e.retryOpts.MaxRetries, lastErr)
}

// doRequest performs a single HTTP request and returns vectors, whether to retry, and any error.
func (e *APIEmbedder) doRequest(body []byte) ([][]float32, bool, error) {
	url := strings.TrimRight(e.config.APIBase, "/")
	if !strings.HasSuffix(url, "/embeddings") {
		url += "/embeddings"
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, false, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if e.config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+e.config.APIKey)
	}

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, true, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, true, fmt.Errorf("read response: %w", err)
	}

	// Rate limited — retryable.
	if resp.StatusCode == http.StatusTooManyRequests {
		return nil, true, fmt.Errorf("rate limited (HTTP 429)")
	}

	// Server errors — retryable.
	if resp.StatusCode >= 500 {
		return nil, true, fmt.Errorf("server error (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	// Client errors (except 429) — not retryable.
	if resp.StatusCode != http.StatusOK {
		return nil, false, fmt.Errorf("API error (HTTP %d): %s", resp.StatusCode, truncate(string(respBody), 200))
	}

	var result openaiEmbeddingResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, false, fmt.Errorf("parse response: %w", err)
	}

	// Sort by index to ensure correct ordering.
	sort.Slice(result.Data, func(i, j int) bool {
		return result.Data[i].Index < result.Data[j].Index
	})

	vecs := make([][]float32, len(result.Data))
	for i, d := range result.Data {
		vecs[i] = d.Embedding
	}

	return vecs, false, nil
}

// backoffDelay calculates exponential backoff delay for the given attempt.
func (e *APIEmbedder) backoffDelay(attempt int) time.Duration {
	delay := float64(e.retryOpts.InitialDelay) * math.Pow(2, float64(attempt-1))
	if delay > float64(e.retryOpts.MaxDelay) {
		delay = float64(e.retryOpts.MaxDelay)
	}
	return time.Duration(delay) * time.Millisecond
}

// truncate shortens a string to maxLen characters.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
