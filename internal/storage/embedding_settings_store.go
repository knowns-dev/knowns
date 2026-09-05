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

	// extra retains fields on this provider entry that this struct does not
	// model, the same way EmbeddingSettings.extra does at the top level, so a
	// user-defined entry survives a seeding round trip byte-identical (AC-6)
	// even where it carries fields this version of the CLI does not know
	// about.
	extra map[string]json.RawMessage `json:"-"`
}

// EmbeddingModel represents a model registered against a provider.
type EmbeddingModel struct {
	Provider   string `json:"provider"`   // ID key into EmbeddingProviders map
	Model      string `json:"model"`      // model name sent to API
	Dimensions int    `json:"dimensions"` // embedding vector size
	// MaxTokens is the model's context limit, used for chunk sizing. Zero
	// leaves the caller on its own conservative default.
	MaxTokens int `json:"maxTokens,omitempty"`
	// QueryPrefix and DocPrefix carry the markers an asymmetric or
	// instruction-aware model expects. They belong to the model rather than the
	// provider: the same endpoint can serve models with different conventions.
	QueryPrefix string `json:"queryPrefix,omitempty"`
	DocPrefix   string `json:"docPrefix,omitempty"`

	// extra retains fields on this model entry that this struct does not
	// model. See EmbeddingProvider.extra.
	extra map[string]json.RawMessage `json:"-"`
}

// embeddingProviderAlias/embeddingModelAlias have the same fields as their
// namesakes but none of their methods, so the custom codecs below can
// delegate to the default struct codec without recursing into themselves.
type embeddingProviderAlias EmbeddingProvider
type embeddingModelAlias EmbeddingModel

var knownEmbeddingProviderFields = map[string]bool{
	"name": true, "apiBase": true, "apiKey": true,
	"timeout": true, "batchSize": true, "retry": true,
}

var knownEmbeddingModelFields = map[string]bool{
	"provider": true, "model": true, "dimensions": true,
	"maxTokens": true, "queryPrefix": true, "docPrefix": true,
}

func extractExtraFields(data []byte, known map[string]bool) (map[string]json.RawMessage, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	var extra map[string]json.RawMessage
	for k, v := range raw {
		if known[k] {
			continue
		}
		if extra == nil {
			extra = make(map[string]json.RawMessage)
		}
		extra[k] = v
	}
	return extra, nil
}

func mergeExtraFields(base []byte, extra map[string]json.RawMessage) ([]byte, error) {
	if len(extra) == 0 {
		return base, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if _, exists := merged[k]; exists {
			continue
		}
		merged[k] = v
	}
	return json.Marshal(merged)
}

// UnmarshalJSON decodes the known fields normally and stashes any remaining
// keys in extra so Save can write them back unchanged.
func (p *EmbeddingProvider) UnmarshalJSON(data []byte) error {
	var aux embeddingProviderAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	extra, err := extractExtraFields(data, knownEmbeddingProviderFields)
	if err != nil {
		return err
	}
	aux.extra = extra
	*p = EmbeddingProvider(aux)
	return nil
}

// MarshalJSON encodes the known fields normally, then merges back any
// unmodeled keys captured by UnmarshalJSON.
func (p EmbeddingProvider) MarshalJSON() ([]byte, error) {
	base, err := json.Marshal(embeddingProviderAlias(p))
	if err != nil {
		return nil, err
	}
	return mergeExtraFields(base, p.extra)
}

// UnmarshalJSON decodes the known fields normally and stashes any remaining
// keys in extra so Save can write them back unchanged.
func (m *EmbeddingModel) UnmarshalJSON(data []byte) error {
	var aux embeddingModelAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	extra, err := extractExtraFields(data, knownEmbeddingModelFields)
	if err != nil {
		return err
	}
	aux.extra = extra
	*m = EmbeddingModel(aux)
	return nil
}

// MarshalJSON encodes the known fields normally, then merges back any
// unmodeled keys captured by UnmarshalJSON.
func (m EmbeddingModel) MarshalJSON() ([]byte, error) {
	base, err := json.Marshal(embeddingModelAlias(m))
	if err != nil {
		return nil, err
	}
	return mergeExtraFields(base, m.extra)
}

// EmbeddingSettings holds the global embedding provider and model registry.
type EmbeddingSettings struct {
	Providers             map[string]EmbeddingProvider `json:"embeddingProviders,omitempty"`
	Models                map[string]EmbeddingModel    `json:"embeddingModels,omitempty"`
	DefaultEmbeddingModel string                       `json:"defaultEmbeddingModel,omitempty"`
	ProjectDefaults       *ProjectDefaults             `json:"projectDefaults,omitempty"`

	// extra retains top-level fields present in the settings file that this
	// struct does not model. Seeding and migration write ~/.knowns/settings.json
	// on paths the user did not initiate (FR-16), so a load-and-save round
	// trip must not silently drop configuration a user (or a newer CLI
	// version) wrote by hand. Populated by UnmarshalJSON, replayed by
	// MarshalJSON, never touched otherwise.
	extra map[string]json.RawMessage `json:"-"`
}

// embeddingSettingsAlias has the same fields as EmbeddingSettings but none of
// its methods, so MarshalJSON/UnmarshalJSON below can delegate to the default
// struct codec without recursing into themselves.
type embeddingSettingsAlias EmbeddingSettings

// knownEmbeddingSettingsFields lists the top-level JSON keys EmbeddingSettings
// models directly. Anything else found on load is preserved verbatim in
// extra and re-emitted on save.
var knownEmbeddingSettingsFields = map[string]bool{
	"embeddingProviders":    true,
	"embeddingModels":       true,
	"defaultEmbeddingModel": true,
	"projectDefaults":       true,
}

// UnmarshalJSON decodes the known fields normally and stashes any remaining
// top-level keys in extra so Save can write them back unchanged.
func (s *EmbeddingSettings) UnmarshalJSON(data []byte) error {
	var aux embeddingSettingsAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	extra, err := extractExtraFields(data, knownEmbeddingSettingsFields)
	if err != nil {
		return err
	}
	aux.extra = extra
	*s = EmbeddingSettings(aux)
	return nil
}

// MarshalJSON encodes the known fields normally, then merges back any
// unmodeled top-level keys captured by UnmarshalJSON. A known field always
// wins over a same-named extra key.
func (s EmbeddingSettings) MarshalJSON() ([]byte, error) {
	base, err := json.Marshal(embeddingSettingsAlias(s))
	if err != nil {
		return nil, err
	}
	if len(s.extra) == 0 {
		return base, nil
	}
	var merged map[string]json.RawMessage
	if err := json.Unmarshal(base, &merged); err != nil {
		return nil, err
	}
	for k, v := range s.extra {
		if _, exists := merged[k]; exists {
			continue
		}
		merged[k] = v
	}
	return json.Marshal(merged)
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

// GlobalSkillsScopeDefault returns the machine-wide skills scope recorded in
// ~/.knowns/settings.json, or "" when none is set. Errors are reported as ""
// so a missing or unreadable global file simply means "no default".
func GlobalSkillsScopeDefault() string {
	settings, err := NewEmbeddingSettingsStore().Load()
	if err != nil || settings == nil || settings.ProjectDefaults == nil {
		return ""
	}
	return settings.ProjectDefaults.Settings.SkillsScope
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

// Load reads embedding settings from disk. Returns seeded default settings if
// the file doesn't exist.
//
// Every call merges the D2 canonical model/provider defaults (see
// embedding_registry_defaults.go) into the result in memory, never
// overwriting anything already present and never writing to disk or making a
// network call. This guarantees that any caller resolving `provider: ollama`
// — including on a fresh machine with no settings file at all — can resolve
// the default model and its provider without having gone through an explicit
// seeding step first (FR-5). Use Seed to persist the merged result to disk.
func (s *EmbeddingSettingsStore) Load() (*EmbeddingSettings, error) {
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			settings := &EmbeddingSettings{
				Providers: make(map[string]EmbeddingProvider),
				Models:    make(map[string]EmbeddingModel),
			}
			SeedDefaults(settings)
			return settings, nil
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
	if settings.ProjectDefaults != nil {
		if err := settings.ProjectDefaults.Settings.Normalize(); err != nil {
			return nil, fmt.Errorf("normalize project defaults: %w", err)
		}
		if err := settings.ProjectDefaults.Settings.Validate(); err != nil {
			return nil, fmt.Errorf("validate project defaults: %w", err)
		}
	}
	SeedDefaults(&settings)
	return &settings, nil
}

// Seed merges the D2 canonical model/provider defaults into the settings file
// and persists the result, without overwriting any entry the user already
// defined (AC-6). It is idempotent: repeated calls produce the same file
// (NFR-3), and it never adds an `api` provider entry (FR-5). This is the
// "registry seeding path" — the explicit, non-interactive counterpart to the
// interactive registration in cli/config.go — intended for callers such as
// init, doctor, or first-run setup that need the global registry populated on
// disk rather than only in memory.
func (s *EmbeddingSettingsStore) Seed() (*EmbeddingSettings, error) {
	settings, err := s.Load()
	if err != nil {
		return nil, err
	}
	// Load already seeded settings in memory; persist so the file on disk
	// reflects it too.
	if err := s.Save(settings); err != nil {
		return nil, err
	}
	return settings, nil
}

// Save writes embedding settings to disk, creating parent directories if needed.
func (s *EmbeddingSettingsStore) Save(settings *EmbeddingSettings) error {
	if settings == nil {
		return fmt.Errorf("embedding settings are required")
	}
	if settings.ProjectDefaults != nil {
		if err := settings.ProjectDefaults.Settings.Normalize(); err != nil {
			return fmt.Errorf("normalize project defaults: %w", err)
		}
		if err := settings.ProjectDefaults.Settings.Validate(); err != nil {
			return fmt.Errorf("validate project defaults: %w", err)
		}
	}
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
