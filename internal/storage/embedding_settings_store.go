// Package storage — EmbeddingSettingsStore manages global embedding provider
// and model configuration at ~/.knowns/settings.json.
// API keys and provider credentials live here (never in project config).
package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/howznguyen/knowns/internal/models"
)

// RetryConfig configures exponential backoff for API rate limiting.
type RetryConfig struct {
	MaxRetries   int `json:"maxRetries"`
	InitialDelay int `json:"initialDelay"` // milliseconds
	MaxDelay     int `json:"maxDelay"`     // milliseconds
}

// EmbeddingProvider represents a registered OpenAI-compatible embedding API endpoint.
type EmbeddingProvider struct {
	Name      string      `json:"name"`
	APIBase   string      `json:"apiBase"`
	APIKey    string      `json:"apiKey,omitempty"`
	Timeout   int         `json:"timeout,omitempty"`   // seconds, default 30
	BatchSize int         `json:"batchSize,omitempty"` // texts per request, default 64
	Retry     RetryConfig `json:"retry,omitempty"`
}

// EmbeddingModel represents a model registered against a provider.
type EmbeddingModel struct {
	Provider   string `json:"provider"`   // ID key into EmbeddingProviders map
	Model      string `json:"model"`      // model name sent to API
	Dimensions int    `json:"dimensions"` // embedding vector size
}

// EmbeddingSettings holds the global embedding provider and model registry.
type EmbeddingSettings struct {
	Providers             map[string]EmbeddingProvider `json:"embeddingProviders,omitempty"`
	Models                map[string]EmbeddingModel    `json:"embeddingModels,omitempty"`
	DefaultEmbeddingModel string                       `json:"defaultEmbeddingModel,omitempty"`
	ProjectDefaults       *ProjectDefaults             `json:"projectDefaults,omitempty"`
}

// ProjectDefaults are user-level defaults applied by future `knowns init` runs.
type ProjectDefaults struct {
	ProjectName string                 `json:"projectName,omitempty"`
	Settings    models.ProjectSettings `json:"settings,omitempty"`
}

// EmbeddingSettingsStore reads and writes ~/.knowns/settings.json.
type EmbeddingSettingsStore struct {
	filePath string
}

// NewEmbeddingSettingsStore creates a store with the default path (~/.knowns/settings.json).
func NewEmbeddingSettingsStore() *EmbeddingSettingsStore {
	home, _ := os.UserHomeDir()
	return &EmbeddingSettingsStore{
		filePath: filepath.Join(home, ".knowns", "settings.json"),
	}
}

// NewEmbeddingSettingsStoreWithPath creates a store with a custom path (for testing).
func NewEmbeddingSettingsStoreWithPath(path string) *EmbeddingSettingsStore {
	return &EmbeddingSettingsStore{filePath: path}
}

// Path returns the file path of the settings file.
func (s *EmbeddingSettingsStore) Path() string {
	return s.filePath
}

// Load reads embedding settings from disk. Returns empty settings if file doesn't exist.
func (s *EmbeddingSettingsStore) Load() (*EmbeddingSettings, error) {
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return &EmbeddingSettings{
				Providers: make(map[string]EmbeddingProvider),
				Models:    make(map[string]EmbeddingModel),
			}, nil
		}
		return nil, fmt.Errorf("read embedding settings: %w", err)
	}
	var settings EmbeddingSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, fmt.Errorf("parse embedding settings: %w", err)
	}
	if settings.Providers == nil {
		settings.Providers = make(map[string]EmbeddingProvider)
	}
	if settings.Models == nil {
		settings.Models = make(map[string]EmbeddingModel)
	}
	return &settings, nil
}

// Save writes embedding settings to disk, creating parent directories if needed.
func (s *EmbeddingSettingsStore) Save(settings *EmbeddingSettings) error {
	if err := os.MkdirAll(filepath.Dir(s.filePath), 0755); err != nil {
		return fmt.Errorf("create settings dir: %w", err)
	}
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal embedding settings: %w", err)
	}
	return os.WriteFile(s.filePath, data, 0644)
}

// GetProvider returns the provider with the given ID, or an error if not found.
func (s *EmbeddingSettings) GetProvider(id string) (EmbeddingProvider, error) {
	p, ok := s.Providers[id]
	if !ok {
		return EmbeddingProvider{}, fmt.Errorf("embedding provider %q not found", id)
	}
	return p, nil
}

// GetModel returns the model with the given ID, or an error if not found.
func (s *EmbeddingSettings) GetModel(id string) (EmbeddingModel, error) {
	m, ok := s.Models[id]
	if !ok {
		return EmbeddingModel{}, fmt.Errorf("embedding model %q not found", id)
	}
	return m, nil
}

// AddProvider registers a new provider. Returns error if ID already exists.
func (s *EmbeddingSettings) AddProvider(id string, provider EmbeddingProvider) error {
	if _, exists := s.Providers[id]; exists {
		return fmt.Errorf("embedding provider %q already exists", id)
	}
	s.Providers[id] = provider
	return nil
}

// UpdateProvider updates an existing provider. Returns error if not found.
func (s *EmbeddingSettings) UpdateProvider(id string, provider EmbeddingProvider) error {
	if _, exists := s.Providers[id]; !exists {
		return fmt.Errorf("embedding provider %q not found", id)
	}
	s.Providers[id] = provider
	return nil
}

// RemoveProvider removes a provider by ID. Returns error if models still reference it.
func (s *EmbeddingSettings) RemoveProvider(id string) error {
	if _, exists := s.Providers[id]; !exists {
		return fmt.Errorf("embedding provider %q not found", id)
	}
	// Check if any models reference this provider.
	for modelID, model := range s.Models {
		if model.Provider == id {
			return fmt.Errorf("cannot remove provider %q: model %q still references it", id, modelID)
		}
	}
	delete(s.Providers, id)
	return nil
}

// AddModel registers a new model. Returns error if ID already exists or provider not found.
func (s *EmbeddingSettings) AddModel(id string, model EmbeddingModel) error {
	if _, exists := s.Models[id]; exists {
		return fmt.Errorf("embedding model %q already exists", id)
	}
	if _, exists := s.Providers[model.Provider]; !exists {
		return fmt.Errorf("provider %q not found; register it first with 'knowns provider add'", model.Provider)
	}
	s.Models[id] = model
	return nil
}

// RemoveModel removes a model by ID. Returns error if it's the default model.
func (s *EmbeddingSettings) RemoveModel(id string) error {
	if _, exists := s.Models[id]; !exists {
		return fmt.Errorf("embedding model %q not found", id)
	}
	if s.DefaultEmbeddingModel == id {
		return fmt.Errorf("cannot remove model %q: it is the default embedding model", id)
	}
	delete(s.Models, id)
	return nil
}

// ProviderDefaults returns a provider with sensible defaults filled in.
func ProviderDefaults() EmbeddingProvider {
	return EmbeddingProvider{
		Timeout:   30,
		BatchSize: 64,
		Retry: RetryConfig{
			MaxRetries:   3,
			InitialDelay: 1000,
			MaxDelay:     30000,
		},
	}
}

// WithDefaults returns a copy of the provider with zero-value fields filled from defaults.
func (p EmbeddingProvider) WithDefaults() EmbeddingProvider {
	defaults := ProviderDefaults()
	if p.Timeout <= 0 {
		p.Timeout = defaults.Timeout
	}
	if p.BatchSize <= 0 {
		p.BatchSize = defaults.BatchSize
	}
	if p.Retry.MaxRetries <= 0 {
		p.Retry.MaxRetries = defaults.Retry.MaxRetries
	}
	if p.Retry.InitialDelay <= 0 {
		p.Retry.InitialDelay = defaults.Retry.InitialDelay
	}
	if p.Retry.MaxDelay <= 0 {
		p.Retry.MaxDelay = defaults.Retry.MaxDelay
	}
	return p
}
