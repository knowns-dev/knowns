package storage

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

// ConfigStore reads and writes .knowns/config.json.
type ConfigStore struct {
	root string
}

func (cs *ConfigStore) configPath() string {
	return filepath.Join(cs.root, "config.json")
}

// Load reads and returns the project configuration.
func (cs *ConfigStore) Load() (*models.Project, error) {
	data, err := os.ReadFile(cs.configPath())
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	var p models.Project
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := p.Settings.Validate(); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}
	return &p, nil
}

// Save writes the project configuration to disk.
func (cs *ConfigStore) Save(project *models.Project) error {
	if project == nil {
		return fmt.Errorf("save config: project is required")
	}
	if err := project.Settings.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return writeJSON(cs.configPath(), project)
}

// Get retrieves a single config value using dot-notation
// (e.g., "settings.serverPort", "settings.defaultAssignee").
// The config file is re-read from disk on each call.
func (cs *ConfigStore) Get(key string) (any, error) {
	raw, err := cs.loadRaw()
	if err != nil {
		return nil, err
	}
	v, ok := getNestedKey(raw, key)
	if !ok {
		return nil, fmt.Errorf("config key %q not found", key)
	}
	return v, nil
}

// Set updates a single config value using dot-notation and persists the change.
func (cs *ConfigStore) Set(key string, value any) error {
	raw, err := cs.loadRaw()
	if err != nil {
		return err
	}
	setNestedKey(raw, key, value)
	data, err := json.Marshal(raw)
	if err != nil {
		return fmt.Errorf("marshal config for validation: %w", err)
	}
	var project models.Project
	if err := json.Unmarshal(data, &project); err != nil {
		return fmt.Errorf("parse config for validation: %w", err)
	}
	if err := project.Settings.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return writeJSON(cs.configPath(), raw)
}

// loadRaw reads config.json into a generic map to support dot-notation access
// without losing unknown/future fields.
func (cs *ConfigStore) loadRaw() (map[string]any, error) {
	data, err := os.ReadFile(cs.configPath())
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	return m, nil
}

// initDefault writes a minimal default config.json for a new project.
func (cs *ConfigStore) initDefault(name string) error {
	if name == "" {
		name = "knowns"
	}
	p := models.Project{
		Name:      name,
		ID:        sanitizeTitle(name),
		CreatedAt: time.Now().UTC(),
		Settings:  models.DefaultProjectSettings(),
	}
	return writeJSON(cs.configPath(), p)
}

// GetOpenCodeServerConfig returns the OpenCode server configuration if set.
func (cs *ConfigStore) GetOpenCodeServerConfig() *models.OpenCodeServerConfig {
	proj, err := cs.Load()
	if err != nil {
		return nil
	}
	return proj.Settings.OpenCodeServerConfig
}
