package models

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
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
	DefaultAssignee     string   `json:"defaultAssignee,omitempty"`
	DefaultPriority     string   `json:"defaultPriority"`
	DefaultLabels       []string `json:"defaultLabels,omitempty"`
	DefaultTaskIDPrefix string   `json:"defaultTaskIdPrefix,omitempty"`

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

	// RuntimeMemory configures bounded memory injection for supported runtimes.
	RuntimeMemory *RuntimeMemorySettings `json:"runtimeMemory,omitempty"`

	// RuntimeWatch configures automatic Task/Doc filesystem reconciliation
	// demand for long-lived clients. A nil value preserves the default policy.
	RuntimeWatch *RuntimeWatchSettings `json:"runtimeWatch,omitempty"`

	// Permissions configures the AI permission policy for this project.
	// When nil, the implicit default preset (read-write-no-delete) is used.
	Permissions *permissions.PermissionConfig `json:"permissions,omitempty"`

	// LSP configures language server enable/disable and binary overrides.
	LSP *LSPSettings `json:"lsp,omitempty"`
}

// Normalize canonicalizes settings that accept human-friendly input.
func (s *ProjectSettings) Normalize() error {
	prefix, err := NormalizeTaskIDPrefix(s.DefaultTaskIDPrefix)
	if err != nil {
		return fmt.Errorf("settings.defaultTaskIdPrefix: %w", err)
	}
	s.DefaultTaskIDPrefix = prefix
	return nil
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
	if _, err := NormalizeTaskIDPrefix(s.DefaultTaskIDPrefix); err != nil {
		return fmt.Errorf("settings.defaultTaskIdPrefix: %w", err)
	}
	settings := s.EffectiveTaskLifecycle()
	if _, err := ParseTaskLifecycleDuration(settings.ArchiveAfter); err != nil {
		return fmt.Errorf("settings.taskLifecycle.archiveAfter: %w", err)
	}
	if settings.PurgeAfter != nil {
		if _, err := ParseTaskLifecycleDuration(*settings.PurgeAfter); err != nil {
			return fmt.Errorf("settings.taskLifecycle.purgeAfter: %w", err)
		}
	}
	if err := s.ValidateSemanticVectorStore(); err != nil {
		return err
	}
	if err := s.ValidateRuntimeWatch(); err != nil {
		return err
	}
	return nil
}

// ValidateRuntimeWatch rejects malformed project watcher grace periods while
// allowing an omitted value to inherit the default policy.
func (s ProjectSettings) ValidateRuntimeWatch() error {
	if s.RuntimeWatch == nil || strings.TrimSpace(s.RuntimeWatch.GracePeriod) == "" {
		return nil
	}
	grace := strings.TrimSpace(s.RuntimeWatch.GracePeriod)
	parsed, err := time.ParseDuration(grace)
	if err != nil {
		return fmt.Errorf("settings.runtimeWatch.gracePeriod: invalid duration %q: %w", s.RuntimeWatch.GracePeriod, err)
	}
	if parsed < 0 {
		return fmt.Errorf("settings.runtimeWatch.gracePeriod: duration must not be negative")
	}
	return nil
}

// ValidateSemanticVectorStore validates the project semantic vector store
// settings when present.
func (s ProjectSettings) ValidateSemanticVectorStore() error {
	if s.SemanticSearch == nil {
		return nil
	}
	return s.SemanticSearch.ValidateVectorStore()
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

// RuntimeWatchSettings configures project-scoped knowledge watcher leases.
// Enabled defaults to true for backwards-compatible automatic reconciliation;
// clients must still be listed as eligible before they request watch demand.
type RuntimeWatchSettings struct {
	Enabled         *bool    `json:"enabled,omitempty"`
	EligibleClients []string `json:"eligibleClients,omitempty"`
	GracePeriod     string   `json:"gracePeriod,omitempty"`
}

// DefaultRuntimeWatchSettings returns the project watch policy used when a
// project has no explicit runtimeWatch block.
func DefaultRuntimeWatchSettings() RuntimeWatchSettings {
	enabled := true
	return RuntimeWatchSettings{
		Enabled:         &enabled,
		EligibleClients: []string{"mcp", "opencode"},
		GracePeriod:     "30s",
	}
}

// EffectiveRuntimeWatch resolves omitted project watch settings to defaults.
func (s ProjectSettings) EffectiveRuntimeWatch() RuntimeWatchSettings {
	settings := DefaultRuntimeWatchSettings()
	if s.RuntimeWatch == nil {
		return settings
	}
	if s.RuntimeWatch.Enabled != nil {
		enabled := *s.RuntimeWatch.Enabled
		settings.Enabled = &enabled
	}
	if s.RuntimeWatch.EligibleClients != nil {
		settings.EligibleClients = append([]string(nil), s.RuntimeWatch.EligibleClients...)
	}
	if s.RuntimeWatch.GracePeriod != "" {
		settings.GracePeriod = s.RuntimeWatch.GracePeriod
	}
	return settings
}

// Semantic vector store backend identifiers (spec D1/D4/D9).
const (
	// SemanticVectorBackendQdrant is the default managed/external Qdrant backend.
	SemanticVectorBackendQdrant = "qdrant"
	// SemanticVectorBackendSQLite is the legacy temporary fallback backend.
	SemanticVectorBackendSQLite = "sqlite"
	// SemanticVectorBackendNone is the explicit vector-store opt-out.
	SemanticVectorBackendNone = "none"
)

// Semantic vector store provisioning modes (spec D2).
const (
	// SemanticVectorStoreModeManaged uses a Knowns-managed local Qdrant binary
	// under the configured managed root (~/.knowns/runtime/qdrant by default).
	SemanticVectorStoreModeManaged = "managed"
	// SemanticVectorStoreModeExternal connects to a user-provided Qdrant URL
	// without managing any local Qdrant process.
	SemanticVectorStoreModeExternal = "external"
)

// Semantic vector store install policies (spec D10).
const (
	// SemanticVectorStoreInstallLazy installs the managed binary only on first
	// semantic use; init never installs or starts anything.
	SemanticVectorStoreInstallLazy = "lazy"
	// SemanticVectorStoreInstallNow installs eagerly (used by explicit
	// blocking commands such as doctor --fix or qdrant install).
	SemanticVectorStoreInstallNow = "now"
)

// Default semantic vector store values used when nothing is configured.
const (
	// DefaultSemanticVectorSchemaVersion is the qdrant.json pointer schema version.
	DefaultSemanticVectorSchemaVersion = 1
	// DefaultSemanticVectorBackend is Qdrant for new semantic-enabled projects.
	DefaultSemanticVectorBackend = SemanticVectorBackendQdrant
	// DefaultSemanticVectorMode is managed local Qdrant.
	DefaultSemanticVectorMode = SemanticVectorStoreModeManaged
	// DefaultSemanticVectorInstall is lazy install (spec D10).
	DefaultSemanticVectorInstall = SemanticVectorStoreInstallLazy
	// DefaultSemanticManagedRoot is the managed Qdrant runtime root (spec D2).
	DefaultSemanticManagedRoot = "~/.knowns/runtime/qdrant"
	// DefaultSemanticVectorRetentionGenerations keeps max 1 inactive generation (spec D7).
	DefaultSemanticVectorRetentionGenerations = 1
	// DefaultSemanticVectorRetentionTTL retains inactive generations for 72h (spec D7).
	DefaultSemanticVectorRetentionTTL = "72h"
)

// Environment variables that override semantic vector store resolution.
// Precedence is env override > project config > global settings > defaults.
const (
	// EnvSemanticVectorEnabled globally toggles semantic vector search
	// ("1"/"true"/"0"/"false"/...).
	EnvSemanticVectorEnabled = "KNOWNS_SEMANTIC_VECTOR_ENABLED"
	// EnvSemanticVectorBackend overrides the vector backend
	// ("qdrant", "sqlite", "none").
	EnvSemanticVectorBackend = "KNOWNS_SEMANTIC_VECTOR_BACKEND"
	// EnvSemanticVectorMode overrides the provisioning mode
	// ("managed", "external").
	EnvSemanticVectorMode = "KNOWNS_SEMANTIC_VECTOR_MODE"
	// EnvSemanticVectorInstall overrides the install policy ("lazy", "now").
	EnvSemanticVectorInstall = "KNOWNS_SEMANTIC_VECTOR_INSTALL"
	// EnvSemanticVectorManagedRoot overrides the managed Qdrant runtime root.
	EnvSemanticVectorManagedRoot = "KNOWNS_SEMANTIC_VECTOR_MANAGED_ROOT"
	// EnvQdrantURL points at an external Qdrant endpoint and implies external mode.
	EnvQdrantURL = "KNOWNS_QDRANT_URL"
	// EnvSemanticQdrantURL is the semantic-scoped alias for EnvQdrantURL.
	EnvSemanticQdrantURL = "KNOWNS_SEMANTIC_QDRANT_URL"
)

// SemanticVectorStoreRetentionSettings controls cleanup of old collection
// generations after a successful Qdrant generation swap (spec D7).
type SemanticVectorStoreRetentionSettings struct {
	// PreviousGenerations is the maximum number of inactive generations kept
	// for rollback (default 1; 0 disables rollback retention). A nil pointer
	// means the field was omitted and should inherit the default; an explicit
	// pointer to 0 disables rollback retention.
	PreviousGenerations *int `json:"previousGenerations,omitempty"`
	// PreviousGenerationTTL is how long an inactive generation is retained
	// before automatic cleanup (default "72h").
	PreviousGenerationTTL string `json:"previousGenerationTTL,omitempty"`
}

// SemanticVectorStoreSettings configures the semantic vector backend
// (spec qdrant-default-vector-backend). All fields are additive and
// backward compatible; zero values resolve to defaults at runtime.
type SemanticVectorStoreSettings struct {
	// Backend selects the vector backend: "qdrant" (default), "sqlite"
	// (legacy temporary fallback), or "none" (explicit opt-out).
	Backend string `json:"backend,omitempty"`

	// Mode selects provisioning: "managed" (default) or "external".
	Mode string `json:"mode,omitempty"`

	// ExternalURL is the Qdrant endpoint used when Mode is "external"
	// (e.g. "http://127.0.0.1:6333"). Required for external mode.
	ExternalURL string `json:"externalURL,omitempty"`

	// ManagedRoot is the local runtime root for the managed Qdrant binary
	// (default "~/.knowns/runtime/qdrant").
	ManagedRoot string `json:"managedRoot,omitempty"`

	// Install controls when the managed binary is installed: "lazy"
	// (default, first semantic use) or "now" (explicit commands only).
	Install string `json:"install,omitempty"`

	// Retention holds old-generation cleanup policy (spec D7).
	Retention *SemanticVectorStoreRetentionSettings `json:"retention,omitempty"`
}

// SemanticSearchSettings configures the optional embedding-based search index.
type SemanticSearchSettings struct {
	Enabled bool   `json:"enabled,omitempty"`
	Model   string `json:"model"`

	// Provider selects the embedding backend: "local" (default, ONNX),
	// "ollama", or "api" (OpenAI-compatible endpoint configured in
	// ~/.knowns/settings.json).
	Provider string `json:"provider,omitempty"`

	// HuggingFaceID is the full HuggingFace model identifier
	// (e.g., "Xenova/gte-small"). Used only when Provider is "local" or empty.
	HuggingFaceID string `json:"huggingFaceId,omitempty"`

	// Dimensions is the embedding vector size for the chosen model.
	Dimensions int `json:"dimensions,omitempty"`

	// MaxTokens is the maximum token count accepted by the model.
	MaxTokens int `json:"maxTokens,omitempty"`

	// VectorStore configures the semantic vector backend. When nil, defaults
	// resolve to managed Qdrant with lazy install for semantic-enabled
	// projects (spec: qdrant-default-vector-backend, D2/D10).
	VectorStore *SemanticVectorStoreSettings `json:"vectorStore,omitempty"`
}

// DefaultSemanticVectorStoreRetentionSettings returns the built-in retention
// policy: max 1 inactive generation retained for 72 hours (spec D7).
func DefaultSemanticVectorStoreRetentionSettings() SemanticVectorStoreRetentionSettings {
	return SemanticVectorStoreRetentionSettings{
		PreviousGenerations:   semanticVectorRetentionGenerationsPtr(DefaultSemanticVectorRetentionGenerations),
		PreviousGenerationTTL: DefaultSemanticVectorRetentionTTL,
	}
}

func semanticVectorRetentionGenerationsPtr(v int) *int {
	return &v
}

// DefaultSemanticVectorStoreSettings returns the built-in vector store
// defaults: managed Qdrant, lazy install, default runtime root, retention
// policy (spec D2/D7/D10).
func DefaultSemanticVectorStoreSettings() SemanticVectorStoreSettings {
	retention := DefaultSemanticVectorStoreRetentionSettings()
	return SemanticVectorStoreSettings{
		Backend:     DefaultSemanticVectorBackend,
		Mode:        DefaultSemanticVectorMode,
		ManagedRoot: DefaultSemanticManagedRoot,
		Install:     DefaultSemanticVectorInstall,
		Retention:   &retention,
	}
}

// DefaultSemanticVectorStoreSettingsPtr returns a pointer to the built-in
// vector store defaults, for embedding into config blocks at init time.
func DefaultSemanticVectorStoreSettingsPtr() *SemanticVectorStoreSettings {
	settings := DefaultSemanticVectorStoreSettings()
	return &settings
}

// DeclaredSemanticVectorStoreSettingsPtr returns the vector store declaration
// `knowns init` writes into project config (spec D10): backend and
// provisioning mode only. Fields that merely mirror runtime defaults
// (ManagedRoot, Install, Retention) are deliberately omitted. Stamping them
// pins each project to whatever the defaults were at init time, because
// mergeVectorStoreSettings lets project values win over defaults; omitting
// them lets ResolveSemanticVectorStore keep supplying the current defaults.
func DeclaredSemanticVectorStoreSettingsPtr() *SemanticVectorStoreSettings {
	return &SemanticVectorStoreSettings{
		Backend: DefaultSemanticVectorBackend,
		Mode:    DefaultSemanticVectorMode,
	}
}

// envLookupFunc abstracts environment lookups so vector store resolution can
// be tested deterministically. nil resolves to os.Getenv.
type envLookupFunc func(string) string

// osEnvLookup is the default environment lookup used by resolution.
func osEnvLookup(key string) string { return os.Getenv(key) }

// SemanticVectorStoreResolution is the effective vector store configuration
// after applying env override > project config > global settings > defaults
// precedence (spec qdrant-default-vector-backend).
type SemanticVectorStoreResolution struct {
	// Enabled reports whether semantic vector search is enabled. Unconfigured
	// stores (no project or global semantic settings) default to false,
	// preserving keyword-only behavior for existing projects.
	Enabled bool
	// OptedOut is true when semantic vector search was explicitly disabled via
	// env, project config, global config, or the "none" backend.
	OptedOut bool
	// Backend is the resolved vector backend: "qdrant", "sqlite", or "none".
	Backend string
	// Mode is the resolved provisioning mode: "managed" or "external".
	Mode string
	// ExternalURL is the resolved external Qdrant endpoint (external mode only).
	ExternalURL string
	// ManagedRoot is the resolved managed Qdrant runtime root.
	ManagedRoot string
	// Install is the resolved install policy: "lazy" or "now".
	Install string
	// Retention is the resolved old-generation cleanup policy.
	Retention SemanticVectorStoreRetentionSettings
}

// ResolveSemanticVectorStore computes the effective semantic vector store
// configuration with env override > project config > global settings >
// defaults precedence. project and global may be nil; lookup may be nil to
// read real environment variables.
func ResolveSemanticVectorStore(project, global *SemanticSearchSettings, lookup envLookupFunc) SemanticVectorStoreResolution {
	if lookup == nil {
		lookup = osEnvLookup
	}

	vs := DefaultSemanticVectorStoreSettings()
	retention := DefaultSemanticVectorStoreRetentionSettings()
	vs.Retention = &retention

	res := SemanticVectorStoreResolution{Retention: retention}

	// Enabled: project > global > default (off when unconfigured).
	switch {
	case project != nil:
		res.Enabled = project.Enabled
	case global != nil:
		res.Enabled = global.Enabled
	}

	// Explicit opt-out via semantic settings.
	switch {
	case project != nil && !project.Enabled:
		res.OptedOut = true
	case project == nil && global != nil && !global.Enabled:
		res.OptedOut = true
	}

	// Merge global settings, then project settings, then env overrides.
	if global != nil {
		mergeVectorStoreSettings(&vs, global.VectorStore)
	}
	if project != nil {
		mergeVectorStoreSettings(&vs, project.VectorStore)
	}

	if v := strings.TrimSpace(lookup(EnvSemanticVectorEnabled)); v != "" {
		enabled := envBool(v)
		res.Enabled = enabled
		// Env explicitly wins over project/global opt-out.
		res.OptedOut = !enabled
	}
	if v := strings.TrimSpace(lookup(EnvSemanticVectorBackend)); v != "" {
		vs.Backend = strings.ToLower(v)
	}
	if v := strings.TrimSpace(lookup(EnvSemanticVectorMode)); v != "" {
		vs.Mode = strings.ToLower(v)
	}
	if v := strings.TrimSpace(lookup(EnvSemanticVectorInstall)); v != "" {
		vs.Install = strings.ToLower(v)
	}
	if v := strings.TrimSpace(lookup(EnvSemanticVectorManagedRoot)); v != "" {
		vs.ManagedRoot = v
	}
	if v := strings.TrimSpace(lookup(EnvQdrantURL)); v != "" {
		vs.ExternalURL = v
		vs.Mode = SemanticVectorStoreModeExternal
	} else if v := strings.TrimSpace(lookup(EnvSemanticQdrantURL)); v != "" {
		vs.ExternalURL = v
		vs.Mode = SemanticVectorStoreModeExternal
	}

	res.Backend = vs.Backend
	res.Mode = vs.Mode
	res.ExternalURL = vs.ExternalURL
	res.ManagedRoot = vs.ManagedRoot
	res.Install = vs.Install
	if vs.Retention != nil {
		res.Retention = *vs.Retention
	}

	// The "none" backend is the explicit vector-store opt-out and forces
	// keyword-only behavior regardless of the enabled flag.
	if res.Backend == SemanticVectorBackendNone {
		res.OptedOut = true
		res.Enabled = false
	}
	return res
}

// mergeVectorStoreSettings overlays set src fields onto dst, preserving
// existing/default values for fields omitted from partial blocks.
func mergeVectorStoreSettings(dst *SemanticVectorStoreSettings, src *SemanticVectorStoreSettings) {
	if src == nil {
		return
	}
	if src.Backend != "" {
		dst.Backend = src.Backend
	}
	if src.Mode != "" {
		dst.Mode = src.Mode
	}
	if src.ExternalURL != "" {
		dst.ExternalURL = src.ExternalURL
	}
	if src.ManagedRoot != "" {
		dst.ManagedRoot = src.ManagedRoot
	}
	if src.Install != "" {
		dst.Install = src.Install
	}
	if src.Retention != nil {
		r := cloneSemanticVectorStoreRetentionSettings(dst.Retention)
		if src.Retention.PreviousGenerations != nil {
			r.PreviousGenerations = semanticVectorRetentionGenerationsPtr(*src.Retention.PreviousGenerations)
		}
		if src.Retention.PreviousGenerationTTL != "" {
			r.PreviousGenerationTTL = src.Retention.PreviousGenerationTTL
		}
		dst.Retention = &r
	}
}

func cloneSemanticVectorStoreRetentionSettings(src *SemanticVectorStoreRetentionSettings) SemanticVectorStoreRetentionSettings {
	var clone SemanticVectorStoreRetentionSettings
	if src == nil {
		clone = DefaultSemanticVectorStoreRetentionSettings()
	} else {
		clone = *src
		if src.PreviousGenerations != nil {
			clone.PreviousGenerations = semanticVectorRetentionGenerationsPtr(*src.PreviousGenerations)
		}
	}
	return clone
}

// envBool parses common boolean environment values.
func envBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on", "enabled":
		return true
	default:
		return false
	}
}

// ValidateVectorStore rejects malformed semantic vector store settings while
// permitting zero-value (unset) fields that resolve to defaults.
func (s *SemanticSearchSettings) ValidateVectorStore() error {
	if s == nil || s.VectorStore == nil {
		return nil
	}
	vs := s.VectorStore
	switch vs.Backend {
	case "", SemanticVectorBackendQdrant, SemanticVectorBackendSQLite, SemanticVectorBackendNone:
	default:
		return fmt.Errorf("settings.semanticSearch.vectorStore.backend: unsupported backend %q", vs.Backend)
	}
	switch vs.Mode {
	case "", SemanticVectorStoreModeManaged, SemanticVectorStoreModeExternal:
	default:
		return fmt.Errorf("settings.semanticSearch.vectorStore.mode: unsupported mode %q", vs.Mode)
	}
	if vs.Mode == SemanticVectorStoreModeExternal && strings.TrimSpace(vs.ExternalURL) == "" {
		return fmt.Errorf("settings.semanticSearch.vectorStore: mode %q requires externalURL", SemanticVectorStoreModeExternal)
	}
	switch vs.Install {
	case "", SemanticVectorStoreInstallLazy, SemanticVectorStoreInstallNow:
	default:
		return fmt.Errorf("settings.semanticSearch.vectorStore.install: unsupported install policy %q", vs.Install)
	}
	if vs.Retention != nil {
		if vs.Retention.PreviousGenerations != nil && *vs.Retention.PreviousGenerations < 0 {
			return fmt.Errorf("settings.semanticSearch.vectorStore.retention.previousGenerations: must not be negative")
		}
		if ttl := strings.TrimSpace(vs.Retention.PreviousGenerationTTL); ttl != "" {
			if _, err := ParseTaskLifecycleDuration(ttl); err != nil {
				return fmt.Errorf("settings.semanticSearch.vectorStore.retention.previousGenerationTTL: %w", err)
			}
		}
	}
	return nil
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
