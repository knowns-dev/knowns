package search

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// OllamaDefaultBase is the default Ollama API base URL.
	OllamaDefaultBase = "http://localhost:11434"
	// ollamaDetectTimeout is the timeout for detection requests.
	ollamaDetectTimeout = 5 * time.Second
)

// OllamaVersion holds the version response from Ollama.
type OllamaVersion struct {
	Version string `json:"version"`
}

// OllamaModel represents a model from the /api/tags response.
type OllamaModel struct {
	Name       string `json:"name"`
	ModifiedAt string `json:"modified_at"`
	Size       int64  `json:"size"`
}

// OllamaTagsResponse is the response from GET /api/tags.
type OllamaTagsResponse struct {
	Models []OllamaModel `json:"models"`
}

// OllamaModelInfo holds model details from POST /api/show.
type OllamaModelInfo struct {
	ModelInfo map[string]interface{} `json:"model_info"`
	Details   struct {
		Family            string   `json:"family"`
		Families          []string `json:"families"`
		ParameterSize     string   `json:"parameter_size"`
		QuantizationLevel string   `json:"quantization_level"`
	} `json:"details"`
	Template string `json:"template"`
}

// OllamaEmbeddingModel represents a detected embedding-capable model.
type OllamaEmbeddingModel struct {
	Name       string // model name (e.g. "nomic-embed-text:latest")
	ShortName  string // without tag (e.g. "nomic-embed-text")
	Dimensions int    // embedding vector size
	Size       int64  // model file size in bytes
}

// OllamaDetector provides methods to detect and query a running Ollama instance.
type OllamaDetector struct {
	baseURL string
	client  *http.Client
}

// NewOllamaDetector creates a detector targeting the given base URL.
func NewOllamaDetector(baseURL string) *OllamaDetector {
	if baseURL == "" {
		baseURL = OllamaDefaultBase
	}
	return &OllamaDetector{
		baseURL: strings.TrimRight(baseURL, "/"),
		client:  &http.Client{Timeout: ollamaDetectTimeout},
	}
}

// IsRunning checks if Ollama is reachable by pinging /api/version.
func (d *OllamaDetector) IsRunning() (bool, string) {
	resp, err := d.client.Get(d.baseURL + "/api/version")
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, ""
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, ""
	}

	var ver OllamaVersion
	if err := json.Unmarshal(body, &ver); err != nil {
		return false, ""
	}
	return true, ver.Version
}

// ListModels returns all models available in Ollama.
func (d *OllamaDetector) ListModels() ([]OllamaModel, error) {
	resp, err := d.client.Get(d.baseURL + "/api/tags")
	if err != nil {
		return nil, fmt.Errorf("list ollama models: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama /api/tags returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read ollama tags response: %w", err)
	}

	var tags OllamaTagsResponse
	if err := json.Unmarshal(body, &tags); err != nil {
		return nil, fmt.Errorf("parse ollama tags: %w", err)
	}
	return tags.Models, nil
}

// ShowModel returns detailed info for a specific model.
func (d *OllamaDetector) ShowModel(name string) (*OllamaModelInfo, error) {
	reqBody, _ := json.Marshal(map[string]string{"name": name})
	resp, err := d.client.Post(d.baseURL+"/api/show", "application/json", strings.NewReader(string(reqBody)))
	if err != nil {
		return nil, fmt.Errorf("show ollama model %q: %w", name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ollama /api/show %q returned HTTP %d", name, resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read ollama show response: %w", err)
	}

	var info OllamaModelInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return nil, fmt.Errorf("parse ollama show: %w", err)
	}
	return &info, nil
}

// GetEmbeddingDimensions extracts the embedding_length from model info.
func (d *OllamaDetector) GetEmbeddingDimensions(info *OllamaModelInfo) int {
	if info == nil || info.ModelInfo == nil {
		return 0
	}
	// Look for embedding_length in model_info (common key for embedding models).
	if v, ok := info.ModelInfo["general.embedding_length"]; ok {
		return toInt(v)
	}
	// Fallback: some models use different key patterns.
	for key, val := range info.ModelInfo {
		if strings.Contains(key, "embedding_length") || strings.Contains(key, "embedding.length") {
			if d := toInt(val); d > 0 {
				return d
			}
		}
	}
	return 0
}

// IsEmbeddingModel determines if a model is embedding-capable.
// Embedding models typically have no template (they don't generate text)
// and have an embedding_length in their model_info.
func (d *OllamaDetector) IsEmbeddingModel(info *OllamaModelInfo) bool {
	if info == nil {
		return false
	}
	// Primary signal: has embedding_length in model_info.
	if d.GetEmbeddingDimensions(info) > 0 {
		return true
	}
	// Secondary signal: no template means it's not a chat/generation model.
	// But this alone isn't sufficient — some models just lack templates.
	return false
}

// ListEmbeddingModels returns only embedding-capable models with their dimensions.
func (d *OllamaDetector) ListEmbeddingModels() ([]OllamaEmbeddingModel, error) {
	models, err := d.ListModels()
	if err != nil {
		return nil, err
	}

	var result []OllamaEmbeddingModel
	for _, m := range models {
		info, err := d.ShowModel(m.Name)
		if err != nil {
			continue // skip models we can't inspect
		}
		if !d.IsEmbeddingModel(info) {
			continue
		}
		dims := d.GetEmbeddingDimensions(info)
		shortName := m.Name
		if idx := strings.LastIndex(shortName, ":"); idx > 0 {
			shortName = shortName[:idx]
		}
		result = append(result, OllamaEmbeddingModel{
			Name:       m.Name,
			ShortName:  shortName,
			Dimensions: dims,
			Size:       m.Size,
		})
	}
	return result, nil
}

// toInt converts a JSON number (float64) to int.
func toInt(v interface{}) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}
