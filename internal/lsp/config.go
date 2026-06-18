package lsp

import (
	"maps"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

type Config struct {
	Languages map[string]LanguageConfig
}

type LanguageConfig struct {
	Enabled     *bool
	Binary      string
	Version     string
	Backend     string
	ProjectPath string
	Settings    map[string]any
}

func ConfigFromProject(project *models.Project) Config {
	return ConfigFromProjectWithDefaults(project, nil)
}

func ConfigFromProjectWithDefaults(project *models.Project, defaults *storage.ProjectDefaults) Config {
	var cfg Config
	if defaults != nil {
		cfg = ConfigFromSettings(defaults.Settings)
	}
	if project == nil || project.Settings.LSP == nil {
		return cfg
	}
	return cfg.Merge(ConfigFromSettings(project.Settings))
}

func ConfigFromSettings(settings models.ProjectSettings) Config {
	if settings.LSP == nil {
		return Config{}
	}
	languages := make(map[string]LanguageConfig, len(settings.LSP.Languages))
	for name, entry := range settings.LSP.Languages {
		languages[name] = LanguageConfig{
			Enabled:     entry.Enabled,
			Binary:      entry.Binary,
			Version:     entry.Version,
			Backend:     entry.Backend,
			ProjectPath: entry.ProjectPath,
			Settings:    cloneSettings(entry.Settings),
		}
	}
	return Config{Languages: languages}
}

func (c Config) Merge(override Config) Config {
	if len(c.Languages) == 0 && len(override.Languages) == 0 {
		return Config{}
	}
	merged := Config{Languages: make(map[string]LanguageConfig, len(c.Languages)+len(override.Languages))}
	for lang, entry := range c.Languages {
		merged.Languages[lang] = entry.clone()
	}
	for lang, entry := range override.Languages {
		base := merged.Languages[lang]
		if entry.Enabled != nil {
			base.Enabled = entry.Enabled
		}
		if entry.Binary != "" {
			base.Binary = entry.Binary
		}
		if entry.Version != "" {
			base.Version = entry.Version
		}
		if entry.Backend != "" {
			base.Backend = entry.Backend
		}
		if entry.ProjectPath != "" {
			base.ProjectPath = entry.ProjectPath
		}
		if len(entry.Settings) > 0 {
			base.Settings = cloneSettings(base.Settings)
			if base.Settings == nil {
				base.Settings = map[string]any{}
			}
			maps.Copy(base.Settings, entry.Settings)
		}
		merged.Languages[lang] = base
	}
	return merged
}

func (lc LanguageConfig) clone() LanguageConfig {
	lc.Settings = cloneSettings(lc.Settings)
	return lc
}

func cloneSettings(settings map[string]any) map[string]any {
	if settings == nil {
		return nil
	}
	return maps.Clone(settings)
}

func (c Config) Enabled(language string) bool {
	entry, ok := c.Languages[language]
	if !ok || entry.Enabled == nil {
		return true
	}
	return *entry.Enabled
}

func (c Config) BinaryOverride(language string) string {
	entry, ok := c.Languages[language]
	if !ok {
		return ""
	}
	return entry.Binary
}

func (c Config) VersionOverride(language string) string {
	entry, ok := c.Languages[language]
	if !ok {
		return ""
	}
	return entry.Version
}

func (c Config) BackendOverride(language string) string {
	entry, ok := c.Languages[language]
	if !ok {
		return ""
	}
	return entry.Backend
}

func (c Config) ProjectPathOverride(language string) string {
	entry, ok := c.Languages[language]
	if !ok {
		return ""
	}
	return entry.ProjectPath
}

func (c Config) LanguageSettings(language string) map[string]any {
	entry, ok := c.Languages[language]
	if !ok {
		return nil
	}
	return entry.Settings
}

func (c Config) IsDisabled(language string) bool {
	entry, ok := c.Languages[language]
	if !ok {
		return false
	}
	if entry.Enabled == nil {
		return false
	}
	return !*entry.Enabled
}
