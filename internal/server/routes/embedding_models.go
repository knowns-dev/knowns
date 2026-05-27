package routes

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// EmbeddingModelRoutes handles embedding model catalog endpoints.
type EmbeddingModelRoutes struct{}

type embeddingModelsResponse struct {
	Local      []embeddingModelInfo `json:"local"`
	API        []embeddingModelInfo `json:"api"`
	Configured []embeddingModelInfo `json:"configured"`
}

type embeddingModelInfo struct {
	Name          string `json:"name"`
	HuggingFaceID string `json:"huggingFaceId,omitempty"`
	Dimensions    int    `json:"dimensions"`
	MaxTokens     int    `json:"maxTokens,omitempty"`
	Installed     *bool  `json:"installed,omitempty"`
	Source        string `json:"source,omitempty"`
	Provider      string `json:"provider,omitempty"`
	ID            string `json:"id,omitempty"`
	Model         string `json:"model,omitempty"`
}

type embeddingModelTestRequest struct {
	APIBase string `json:"apiBase"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

type embeddingModelTestResponse struct {
	Success    bool   `json:"success"`
	Dimensions int    `json:"dimensions,omitempty"`
	Model      string `json:"model,omitempty"`
	Error      string `json:"error,omitempty"`
}

type openAIEmbeddingResponse struct {
	Data []struct {
		Embedding []float64 `json:"embedding"`
		Index     int       `json:"index"`
	} `json:"data"`
}

// Register wires embedding model routes onto r.
func (emr *EmbeddingModelRoutes) Register(r chi.Router) {
	r.Get("/embedding-models", emr.list)
	r.Post("/embedding-models/test", emr.test)
}

func (emr *EmbeddingModelRoutes) test(w http.ResponseWriter, r *http.Request) {
	var req embeddingModelTestRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.APIBase == "" || req.Model == "" {
		respondError(w, http.StatusBadRequest, "apiBase and model are required")
		return
	}

	embedURL := req.APIBase
	if embedURL[len(embedURL)-1] != '/' {
		embedURL += "/"
	}
	embedURL += "embeddings"

	payload := map[string]interface{}{
		"model": req.Model,
		"input": []string{"test"},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to build request body")
		return
	}

	httpReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, embedURL, bytes.NewReader(body))
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to create request")
		return
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if req.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+req.APIKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(httpReq)
	if err != nil {
		respondJSON(w, http.StatusOK, embeddingModelTestResponse{
			Success: false,
			Error:   err.Error(),
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respondJSON(w, http.StatusOK, embeddingModelTestResponse{
			Success: false,
			Error:   "HTTP " + resp.Status,
		})
		return
	}

	var embResp openAIEmbeddingResponse
	if err := json.NewDecoder(resp.Body).Decode(&embResp); err != nil {
		respondJSON(w, http.StatusOK, embeddingModelTestResponse{
			Success: false,
			Error:   "failed to parse response: " + err.Error(),
		})
		return
	}

	if len(embResp.Data) == 0 || len(embResp.Data[0].Embedding) == 0 {
		respondJSON(w, http.StatusOK, embeddingModelTestResponse{
			Success: false,
			Error:   "no embedding returned",
		})
		return
	}

	respondJSON(w, http.StatusOK, embeddingModelTestResponse{
		Success:    true,
		Dimensions: len(embResp.Data[0].Embedding),
		Model:      req.Model,
	})
}

func (emr *EmbeddingModelRoutes) list(w http.ResponseWriter, r *http.Request) {
	configured, err := loadConfiguredEmbeddingModels()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, embeddingModelsResponse{
		Local:      listLocalEmbeddingModels(),
		API:        listOllamaEmbeddingModels(),
		Configured: configured,
	})
}

func listLocalEmbeddingModels() []embeddingModelInfo {
	models := make([]embeddingModelInfo, 0, len(search.EmbeddingModels))
	for name, cfg := range search.EmbeddingModels {
		installed := localEmbeddingModelInstalled(cfg.HuggingFaceID)
		models = append(models, embeddingModelInfo{
			Name:          name,
			HuggingFaceID: cfg.HuggingFaceID,
			Dimensions:    cfg.Dimensions,
			MaxTokens:     cfg.MaxTokens,
			Installed:     &installed,
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models
}

func localEmbeddingModelInstalled(huggingFaceID string) bool {
	if huggingFaceID == "" {
		return false
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false
	}
	base := filepath.Join(home, ".knowns", "models", filepath.FromSlash(huggingFaceID), "onnx")
	for _, file := range []string{"model_quantized.onnx", "model.onnx"} {
		if info, err := os.Stat(filepath.Join(base, file)); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}

func listOllamaEmbeddingModels() []embeddingModelInfo {
	detector := search.NewOllamaDetector("")
	models, err := detector.ListEmbeddingModels()
	if err != nil {
		return []embeddingModelInfo{}
	}

	result := make([]embeddingModelInfo, 0, len(models))
	for _, model := range models {
		result = append(result, embeddingModelInfo{
			Name:       model.Name,
			Dimensions: model.Dimensions,
			Source:     "ollama",
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func loadConfiguredEmbeddingModels() ([]embeddingModelInfo, error) {
	settings, err := storage.NewEmbeddingSettingsStore().Load()
	if err != nil {
		return nil, err
	}

	models := make([]embeddingModelInfo, 0, len(settings.Models))
	for id, model := range settings.Models {
		models = append(models, embeddingModelInfo{
			ID:         id,
			Name:       id,
			Provider:   model.Provider,
			Model:      model.Model,
			Dimensions: model.Dimensions,
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}
