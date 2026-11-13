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
	// split is set for a store-linked project, whose config.json syncs with
	// the team: settings owned by one person or one machine live elsewhere
	// (store spec D13). Nil for in-repo projects, which keep every setting in
	// config.json.
	split *configSplit
}

func (cs *ConfigStore) configPath() string {
	return filepath.Join(cs.root, "config.json")
}

// Load reads and returns the project configuration. For a store-linked
// project the personal and machine settings are overlaid from their homes.
func (cs *ConfigStore) Load() (*models.Project, error) {
	raw, err := cs.loadMerged()
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	var p models.Project
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := p.Settings.Normalize(); err != nil {
		return nil, fmt.Errorf("normalize config: %w", err)
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
	if err := project.Settings.Normalize(); err != nil {
		return fmt.Errorf("normalize config: %w", err)
	}
	if err := project.Settings.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	if cs.split == nil {
		return writeCanonicalJSON(cs.configPath(), project)
	}
	raw, err := toGenericMap(project)
	if err != nil {
		return fmt.Errorf("save config: %w", err)
	}
	return cs.writeTeam(raw)
}

// Get retrieves a single config value using dot-notation
// (e.g., "settings.serverPort", "settings.defaultAssignee").
// The config file is re-read from disk on each call.
func (cs *ConfigStore) Get(key string) (any, error) {
	raw, err := cs.loadMerged()
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
	raw, err := cs.loadMerged()
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
	if err := project.Settings.Normalize(); err != nil {
		return fmt.Errorf("normalize config: %w", err)
	}
	if err := project.Settings.Validate(); err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	// Persist the canonical (uppercased/trimmed) prefix so raw-map writes do not
	// keep the human-friendly input form.
	if key == "settings.defaultTaskIdPrefix" || project.Settings.DefaultTaskIDPrefix != "" {
		setNestedKey(raw, "settings.defaultTaskIdPrefix", project.Settings.DefaultTaskIDPrefix)
	}
	return cs.writeTeam(raw)
}

// writeTeam writes config.json in its one canonical form. For a store-linked
// project it first moves personal and machine settings to their homes, so
// the synced file carries team policy only.
func (cs *ConfigStore) writeTeam(raw map[string]any) error {
	if cs.split != nil {
		if err := cs.split.storeOwned(raw); err != nil {
			return err
		}
	}
	return writeCanonicalJSON(cs.configPath(), raw)
}

// loadMerged reads config.json as a generic map and, for a store-linked
// project, overlays personal and machine settings from their homes.
func (cs *ConfigStore) loadMerged() (map[string]any, error) {
	raw, err := cs.loadRaw()
	if err != nil {
		return nil, err
	}
	if cs.split != nil {
		cs.split.overlay(raw)
	}
	return raw, nil
}

// loadRaw reads config.json into a generic map to support dot-notation access
// without losing unknown/future fields.
func (cs *ConfigStore) loadRaw() (map[string]any, error) {
	data, err := os.ReadFile(cs.configPath())
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	m, err := decodeGenericObject(data)
	if err != nil {
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
		// A freshly initialized project starts fully migrated: nothing about
		// it needs the resolution knowns migrate exists to apply, so it
		// should never trigger the FR-4 unmigrated notice.
		SchemaVersion: CurrentSchemaVersion(),
	}
	return writeCanonicalJSON(cs.configPath(), p)
}
