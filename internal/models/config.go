package models

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/permissions"
)

// Project is the root configuration stored in .knowns/config.json.
type Project struct {
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	CreatedAt time.Time       `json:"createdAt"`
	Settings  ProjectSettings `json:"settings"`
}

// ProjectSettings holds all user-configurable options for a project.
type LSPSettings struct {
	Enabled   *bool                          `json:"enabled,omitempty"`
	Languages map[string]LSPLanguageSettings `json:"languages,omitempty"`
}

type LSPLanguageSettings struct {
	Enabled     *bool          `json:"enabled,omitempty"`
	Binary      string         `json:"binary,omitempty"`
	Version     string         `json:"version,omitempty"`
	Backend     string         `json:"backend,omitempty"`
	ProjectPath string         `json:"projectPath,omitempty"`
	Settings    map[string]any `json:"settings,omitempty"`
}

// GitTracking holds per-section git tracking toggles. A nil pointer means
// "use the default for this section" (tasks/docs/templates/decisions=true, memories=false).
type GitTracking struct {
	Tasks     *bool `json:"tasks,omitempty"`
	Docs      *bool `json:"docs,omitempty"`
	Templates *bool `json:"templates,omitempty"`
	Memories  *bool `json:"memories,omitempty"`
	Decisions *bool `json:"decisions,omitempty"`
}

// GitTrackingDefaults returns the default per-section tracking values.
func GitTrackingDefaults() GitTracking {
	t, d, tmpl, dec := true, true, true, true
	m := false
	return GitTracking{
		Tasks:     &t,
		Docs:      &d,
		Templates: &tmpl,
		Memories:  &m,
		Decisions: &dec,
	}
}

// GitTrackingDefaults returns defaults suitable for a given mode string.
func GitTrackingModeDefaults(mode string) GitTracking {
	switch mode {
	case "git-ignored":
		// In git-ignored mode, docs, templates, tasks, and decisions are tracked
		// by default. Memories remain off.
		t, d, tmpl, dec := true, true, true, true
		m := false
		return GitTracking{Tasks: &t, Docs: &d, Templates: &tmpl, Memories: &m, Decisions: &dec}
	default:
		// git-tracked and any other mode: same as GitTrackingDefaults.
		return GitTrackingDefaults()
	}
}

type ProjectSettings struct {
	DefaultAssignee string   `json:"defaultAssignee,omitempty"`
	DefaultPriority string   `json:"defaultPriority"`
	DefaultLabels   []string `json:"defaultLabels,omitempty"`

	// TaskLifecycle is canonical for this project. A nil value is supported for
	// backward compatibility and resolves to DefaultTaskLifecycleSettings.
	TaskLifecycle *TaskLifecycleSettings `json:"taskLifecycle,omitempty"`

	// CodeIntelligenceIgnore is an optional list of repo-relative paths or
	// glob-like patterns skipped by code ingest in addition to .gitignore.
	CodeIntelligenceIgnore []string `json:"codeIntelligenceIgnore,omitempty"`

	// TimeFormat is "12h" or "24h".
	TimeFormat string `json:"timeFormat,omitempty"`

	// Editor is the preferred editor command (e.g., "code", "vim", "nano").
	Editor string `json:"editor,omitempty"`

	// GitTrackingMode controls whether .knowns/ files are git-tracked.
	// Allowed values: "git-tracked", "git-ignored", "none".
	GitTrackingMode string `json:"gitTrackingMode,omitempty"`

	// GitTracking holds per-section git tracking toggles that override the
	// default behavior of GitTrackingMode. When nil, mode defaults apply.
	GitTracking *GitTracking `json:"gitTracking,omitempty"`

	// Statuses is the ordered list of valid task statuses for this project.
	Statuses []string `json:"statuses"`

	StatusColors map[string]string `json:"statusColors,omitempty"`

	// VisibleColumns lists which status columns are shown in the board view.
	VisibleColumns []string `json:"visibleColumns,omitempty"`

	SemanticSearch *SemanticSearchSettings `json:"semanticSearch,omitempty"`

	// ServerPort overrides the default HTTP server port when non-zero.
	ServerPort int `json:"serverPort,omitempty"`

	// Platforms is the list of AI platforms enabled for this project.
	// Supported values: "claude-code", "opencode", "gemini", "copilot", "agents".
	// If empty, all platforms are treated as enabled (backwards-compatible default).
	Platforms []string `json:"platforms,omitempty"`

	// EnableChatUI controls whether the Chat UI (powered by OpenCode web) is
	// shown in the browser. When nil/unset the UI defaults to showing it.
	EnableChatUI *bool `json:"enableChatUI,omitempty"`

	// OpenCodeServerConfig holds settings for connecting to OpenCode server.
	OpenCodeServerConfig *OpenCodeServerConfig `json:"opencodeServer,omitempty"`

	// OpenCodeModels holds project-level model manager preferences for OpenCode.
	OpenCodeModels *OpenCodeModelSettings `json:"opencodeModels,omitempty"`

	// RuntimeMemory configures bounded memory injection for supported runtimes.
	RuntimeMemory *RuntimeMemorySettings `json:"runtimeMemory,omitempty"`

	// Permissions configures the AI permission policy for this project.
	// When nil, the implicit default preset (read-write-no-delete) is used.
	Permissions *permissions.PermissionConfig `json:"permissions,omitempty"`

	// LSP configures language server enable/disable and binary overrides.
	LSP *LSPSettings `json:"lsp,omitempty"`
}

// TaskLifecycleSettings configures Task visibility and retention. AutoArchive
// is the explicit enable/disable switch; a zero ArchiveAfter duration therefore
// remains distinct from disabled archival. A nil PurgeAfter disables purging.
type TaskLifecycleSettings struct {
	ExcludeDoneFromDefaultRetrieval bool    `json:"excludeDoneFromDefaultRetrieval"`
	AutoArchive                     bool    `json:"autoArchive"`
	ArchiveAfter                    string  `json:"archiveAfter"`
	PurgeAfter                      *string `json:"purgeAfter"`
}

// UnmarshalJSON lets project/global configuration specify a partial lifecycle
// block without turning omitted true defaults into false or losing 30d.
func (s *TaskLifecycleSettings) UnmarshalJSON(data []byte) error {
	var raw struct {
		ExcludeDoneFromDefaultRetrieval *bool           `json:"excludeDoneFromDefaultRetrieval"`
		AutoArchive                     *bool           `json:"autoArchive"`
		ArchiveAfter                    *string         `json:"archiveAfter"`
		PurgeAfter                      json.RawMessage `json:"purgeAfter"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}

	settings := DefaultTaskLifecycleSettings()
	if raw.ExcludeDoneFromDefaultRetrieval != nil {
		settings.ExcludeDoneFromDefaultRetrieval = *raw.ExcludeDoneFromDefaultRetrieval
	}
	if raw.AutoArchive != nil {
		settings.AutoArchive = *raw.AutoArchive
	}
	if raw.ArchiveAfter != nil {
		settings.ArchiveAfter = *raw.ArchiveAfter
	}
	if len(raw.PurgeAfter) > 0 && !bytes.Equal(bytes.TrimSpace(raw.PurgeAfter), []byte("null")) {
		var purgeAfter string
		if err := json.Unmarshal(raw.PurgeAfter, &purgeAfter); err != nil {
			return fmt.Errorf("purgeAfter: %w", err)
		}
		settings.PurgeAfter = &purgeAfter
	}
	*s = settings
	return nil
}

// DefaultTaskLifecycleSettings returns the built-in project lifecycle policy.
func DefaultTaskLifecycleSettings() TaskLifecycleSettings {
	return TaskLifecycleSettings{
		ExcludeDoneFromDefaultRetrieval: true,
		AutoArchive:                     true,
		ArchiveAfter:                    "30d",
		PurgeAfter:                      nil,
	}
}

// EffectiveTaskLifecycle returns project-local lifecycle settings or built-in
// defaults for legacy projects that do not yet persist the settings block.
func (s ProjectSettings) EffectiveTaskLifecycle() TaskLifecycleSettings {
	if s.TaskLifecycle == nil {
		return DefaultTaskLifecycleSettings()
	}
	return cloneTaskLifecycleSettings(*s.TaskLifecycle)
}

// Validate rejects malformed lifecycle durations while permitting zero delay.
func (s ProjectSettings) Validate() error {
	settings := s.EffectiveTaskLifecycle()
	if _, err := ParseTaskLifecycleDuration(settings.ArchiveAfter); err != nil {
		return fmt.Errorf("settings.taskLifecycle.archiveAfter: %w", err)
	}
	if settings.PurgeAfter != nil {
		if _, err := ParseTaskLifecycleDuration(*settings.PurgeAfter); err != nil {
			return fmt.Errorf("settings.taskLifecycle.purgeAfter: %w", err)
		}
	}
	return nil
}

// ParseTaskLifecycleDuration parses Go duration strings plus an integer day
// suffix (for example "30d"). Negative and empty durations are rejected.
func ParseTaskLifecycleDuration(value string) (time.Duration, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, fmt.Errorf("duration is required")
	}

	var (
		duration time.Duration
		err      error
	)
	if strings.HasSuffix(value, "d") {
		daysText := strings.TrimSuffix(value, "d")
		var days int64
		days, err = strconv.ParseInt(daysText, 10, 64)
		if err == nil {
			const day = 24 * time.Hour
			if days < 0 {
				err = fmt.Errorf("duration must not be negative")
			} else if days > int64((time.Duration(1<<63-1))/day) {
				err = fmt.Errorf("duration overflows")
			} else {
				duration = time.Duration(days) * day
			}
		}
	} else {
		duration, err = time.ParseDuration(value)
	}
	if err != nil {
		return 0, fmt.Errorf("invalid duration %q: %w", value, err)
	}
	if duration < 0 {
		return 0, fmt.Errorf("duration must not be negative")
	}
	return duration, nil
}

func cloneTaskLifecycleSettings(settings TaskLifecycleSettings) TaskLifecycleSettings {
	clone := settings
	if settings.PurgeAfter != nil {
		purgeAfter := *settings.PurgeAfter
		clone.PurgeAfter = &purgeAfter
	}
	return clone
}

// RuntimeMemorySettings configures runtime-level memory injection.
type RuntimeMemorySettings struct {
	// Mode controls runtime memory behavior: off, auto, manual, debug.
	Mode string `json:"mode,omitempty"`

	// Capture controls runtime memory auto-capture independently from Mode.
	Capture string `json:"capture,omitempty"`

	// MaxItems limits the number of injected memory items.
	MaxItems int `json:"maxItems,omitempty"`

	// MaxBytes caps the serialized memory payload size.
	MaxBytes int `json:"maxBytes,omitempty"`
}

// OpenCodeServerConfig holds settings for the OpenCode server API.
type OpenCodeServerConfig struct {
	// Mode controls whether Knowns manages the runtime itself or attaches to an
	// already running external OpenCode server. Supported values: "managed",
	// "external". Empty defaults to managed for backward compatibility.
	Mode string `json:"mode,omitempty"`

	// Host is the OpenCode server hostname (default: 127.0.0.1).
	Host string `json:"host,omitempty"`

	// Port is the OpenCode server port (default: 4096).
	Port int `json:"port,omitempty"`

	// Password is the authentication password (optional).
	Password string `json:"password,omitempty"`
}

// OpenCodeModelSettings stores project-level model manager preferences.
type OpenCodeModelSettings struct {
	Version         int               `json:"version"`
	DefaultModel    *OpenCodeModelRef `json:"defaultModel,omitempty"`
	VariantModels   map[string]string `json:"variantModels,omitempty"`
	ActiveModels    []string          `json:"activeModels,omitempty"`
	HiddenProviders []string          `json:"hiddenProviders,omitempty"`
}

// OpenCodeModelRef identifies a concrete OpenCode model.
type OpenCodeModelRef struct {
	ProviderID string `json:"providerID"`
	ModelID    string `json:"modelID"`
}

// SemanticSearchSettings configures the optional embedding-based search index.
type SemanticSearchSettings struct {
	Enabled bool   `json:"enabled,omitempty"`
	Model   string `json:"model"`

	// Provider selects the embedding backend: "local" (default, ONNX) or "api"
	// (OpenAI-compatible endpoint configured in ~/.knowns/settings.json).
	Provider string `json:"provider,omitempty"`

	// HuggingFaceID is the full HuggingFace model identifier
	// (e.g., "Xenova/gte-small"). Used only when Provider is "local" or empty.
	HuggingFaceID string `json:"huggingFaceId,omitempty"`

	// Dimensions is the embedding vector size for the chosen model.
	Dimensions int `json:"dimensions,omitempty"`

	// MaxTokens is the maximum token count accepted by the model.
	MaxTokens int `json:"maxTokens,omitempty"`
}

// DefaultProjectSettings returns a ProjectSettings value populated with the
// same defaults that the TypeScript CLI uses when initialising a new project.
func DefaultProjectSettings() ProjectSettings {
	taskLifecycle := DefaultTaskLifecycleSettings()
	return ProjectSettings{
		DefaultPriority: "medium",
		TaskLifecycle:   &taskLifecycle,
		Statuses:        DefaultStatuses(),
		StatusColors: map[string]string{
			"todo":        "gray",
			"in-progress": "blue",
			"in-review":   "purple",
			"done":        "green",
			"blocked":     "red",
			"on-hold":     "yellow",
			"urgent":      "orange",
		},
		VisibleColumns: []string{
			"todo",
			"in-progress",
			"blocked",
			"done",
			"in-review",
		},
	}
}
