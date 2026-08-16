package models

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestGitTrackingDefaultsTrackDecisions(t *testing.T) {
	defaults := GitTrackingDefaults()
	if defaults.Decisions == nil || !*defaults.Decisions {
		t.Fatalf("GitTrackingDefaults decisions = %v, want true", defaults.Decisions)
	}
	if defaults.Memories == nil || *defaults.Memories {
		t.Fatalf("GitTrackingDefaults memories = %v, want false", defaults.Memories)
	}
}

func TestGitTrackingModeDefaultsGitIgnoredTrackDecisions(t *testing.T) {
	defaults := GitTrackingModeDefaults("git-ignored")
	if defaults.Decisions == nil || !*defaults.Decisions {
		t.Fatalf("GitTrackingModeDefaults(git-ignored) decisions = %v, want true", defaults.Decisions)
	}
	if defaults.Memories == nil || *defaults.Memories {
		t.Fatalf("GitTrackingModeDefaults(git-ignored) memories = %v, want false", defaults.Memories)
	}
}

func TestDefaultTaskLifecycleSettings(t *testing.T) {
	settings := DefaultTaskLifecycleSettings()
	if !settings.ExcludeDoneFromDefaultRetrieval || !settings.AutoArchive {
		t.Fatalf("default lifecycle booleans = %#v, want both enabled", settings)
	}
	if settings.ArchiveAfter != "30d" {
		t.Fatalf("ArchiveAfter = %q, want 30d", settings.ArchiveAfter)
	}
	if settings.PurgeAfter != nil {
		t.Fatalf("PurgeAfter = %v, want disabled (nil)", settings.PurgeAfter)
	}
}

func TestTaskLifecycleSettingsPartialJSONUsesFieldDefaults(t *testing.T) {
	var project Project
	err := json.Unmarshal([]byte(`{
		"name":"legacy",
		"settings":{"taskLifecycle":{"autoArchive":false}}
	}`), &project)
	if err != nil {
		t.Fatalf("Unmarshal partial lifecycle config: %v", err)
	}

	settings := project.Settings.EffectiveTaskLifecycle()
	if settings.AutoArchive {
		t.Fatal("AutoArchive = true, want explicit false")
	}
	if !settings.ExcludeDoneFromDefaultRetrieval {
		t.Fatal("ExcludeDoneFromDefaultRetrieval = false, want omitted-field default true")
	}
	if settings.ArchiveAfter != "30d" {
		t.Fatalf("ArchiveAfter = %q, want omitted-field default 30d", settings.ArchiveAfter)
	}
	if err := project.Settings.Validate(); err != nil {
		t.Fatalf("Validate partial lifecycle config: %v", err)
	}
}

func TestParseTaskLifecycleDuration(t *testing.T) {
	tests := []struct {
		value string
		want  time.Duration
	}{
		{value: "30d", want: 30 * 24 * time.Hour},
		{value: "0s", want: 0},
		{value: "12h", want: 12 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			got, err := ParseTaskLifecycleDuration(tt.value)
			if err != nil {
				t.Fatalf("ParseTaskLifecycleDuration(%q): %v", tt.value, err)
			}
			if got != tt.want {
				t.Fatalf("duration = %s, want %s", got, tt.want)
			}
		})
	}

	for _, value := range []string{"", "-1h", "-1d", "later"} {
		t.Run("invalid_"+value, func(t *testing.T) {
			if _, err := ParseTaskLifecycleDuration(value); err == nil {
				t.Fatalf("ParseTaskLifecycleDuration(%q) succeeded, want error", value)
			}
		})
	}
}

func TestRuntimeWatchGracePeriodValidation(t *testing.T) {
	tests := []struct {
		name      string
		grace     string
		wantError string
	}{
		{name: "valid", grace: "45s"},
		{name: "zero", grace: "0s"},
		{name: "empty-inherits-default", grace: ""},
		{name: "negative", grace: "-1s", wantError: "must not be negative"},
		{name: "malformed", grace: "soon", wantError: "invalid duration"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			settings := ProjectSettings{RuntimeWatch: &RuntimeWatchSettings{GracePeriod: tt.grace}}
			err := settings.Validate()
			if tt.wantError == "" {
				if err != nil {
					t.Fatalf("Validate() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantError) {
				t.Fatalf("Validate() = %v, want error containing %q", err, tt.wantError)
			}
			if !strings.Contains(err.Error(), "settings.runtimeWatch.gracePeriod") {
				t.Fatalf("Validate() = %v, want actionable runtimeWatch path", err)
			}
		})
	}
}

// envMapLookup returns an envLookupFunc backed by a map so vector store
// resolution tests are deterministic regardless of the host environment.
func envMapLookup(m map[string]string) envLookupFunc {
	return func(key string) string { return m[key] }
}

func semanticVectorRetentionGenerationsValue(retention *SemanticVectorStoreRetentionSettings) int {
	if retention == nil || retention.PreviousGenerations == nil {
		return 0
	}
	return *retention.PreviousGenerations
}

func TestDefaultSemanticVectorStoreSettings(t *testing.T) {
	settings := DefaultSemanticVectorStoreSettings()
	if settings.Backend != SemanticVectorBackendQdrant {
		t.Fatalf("backend = %q, want %q", settings.Backend, SemanticVectorBackendQdrant)
	}
	if settings.Mode != SemanticVectorStoreModeManaged {
		t.Fatalf("mode = %q, want %q", settings.Mode, SemanticVectorStoreModeManaged)
	}
	if settings.Install != SemanticVectorStoreInstallLazy {
		t.Fatalf("install = %q, want %q", settings.Install, SemanticVectorStoreInstallLazy)
	}
	if settings.ManagedRoot != DefaultSemanticManagedRoot {
		t.Fatalf("managedRoot = %q, want %q", settings.ManagedRoot, DefaultSemanticManagedRoot)
	}
	if settings.Retention == nil {
		t.Fatal("retention = nil, want defaults")
	}
	if got := semanticVectorRetentionGenerationsValue(settings.Retention); got != DefaultSemanticVectorRetentionGenerations {
		t.Fatalf("retention.previousGenerations = %d, want %d", got, DefaultSemanticVectorRetentionGenerations)
	}
	if settings.Retention.PreviousGenerationTTL != DefaultSemanticVectorRetentionTTL {
		t.Fatalf("retention.previousGenerationTTL = %q, want %q", settings.Retention.PreviousGenerationTTL, DefaultSemanticVectorRetentionTTL)
	}
	if ptr := DefaultSemanticVectorStoreSettingsPtr(); ptr == nil || ptr.Backend != settings.Backend || ptr.Mode != settings.Mode || ptr.Install != settings.Install || ptr.ManagedRoot != settings.ManagedRoot || ptr.Retention == nil || semanticVectorRetentionGenerationsValue(ptr.Retention) != semanticVectorRetentionGenerationsValue(settings.Retention) || ptr.Retention.PreviousGenerationTTL != settings.Retention.PreviousGenerationTTL {
		t.Fatalf("DefaultSemanticVectorStoreSettingsPtr = %#v, want defaults", ptr)
	}
}

func TestSemanticVectorStoreJSONRoundTrip(t *testing.T) {
	project := Project{
		Name: "p",
		Settings: ProjectSettings{
			SemanticSearch: &SemanticSearchSettings{
				Enabled:  true,
				Model:    "gte-small",
				Provider: "local",
				VectorStore: &SemanticVectorStoreSettings{
					Backend:     SemanticVectorBackendQdrant,
					Mode:        SemanticVectorStoreModeManaged,
					ManagedRoot: "~/.knowns/runtime/qdrant",
					Install:     SemanticVectorStoreInstallLazy,
					Retention: &SemanticVectorStoreRetentionSettings{
						PreviousGenerations:   semanticVectorRetentionGenerationsPtr(2),
						PreviousGenerationTTL: "24h",
					},
				},
			},
		},
	}
	data, err := json.Marshal(project)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !bytes.Contains(data, []byte(`"vectorStore"`)) {
		t.Fatalf("marshal output missing vectorStore block: %s", data)
	}
	var loaded Project
	if err := json.Unmarshal(data, &loaded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	vs := loaded.Settings.SemanticSearch.VectorStore
	if vs == nil {
		t.Fatal("vectorStore = nil after round trip")
	}
	if vs.Backend != SemanticVectorBackendQdrant || vs.Mode != SemanticVectorStoreModeManaged ||
		vs.Install != SemanticVectorStoreInstallLazy || vs.Retention == nil ||
		semanticVectorRetentionGenerationsValue(vs.Retention) != 2 || vs.Retention.PreviousGenerationTTL != "24h" {
		t.Fatalf("vectorStore after round trip = %#v", vs)
	}
	if err := loaded.Settings.Validate(); err != nil {
		t.Fatalf("Validate after round trip: %v", err)
	}
}

func TestSemanticVectorStoreValidation(t *testing.T) {
	tests := []struct {
		name    string
		vs      SemanticVectorStoreSettings
		wantErr bool
	}{
		{name: "defaults-ok", vs: DefaultSemanticVectorStoreSettings()},
		{name: "partial-ok", vs: SemanticVectorStoreSettings{}},
		{name: "external-with-url-ok", vs: SemanticVectorStoreSettings{Mode: SemanticVectorStoreModeExternal, ExternalURL: "http://127.0.0.1:6333"}},
		{name: "external-without-url", vs: SemanticVectorStoreSettings{Mode: SemanticVectorStoreModeExternal}, wantErr: true},
		{name: "bad-backend", vs: SemanticVectorStoreSettings{Backend: "pinecone"}, wantErr: true},
		{name: "bad-mode", vs: SemanticVectorStoreSettings{Mode: "remote"}, wantErr: true},
		{name: "bad-install", vs: SemanticVectorStoreSettings{Install: "always"}, wantErr: true},
		{name: "negative-retention", vs: SemanticVectorStoreSettings{Retention: &SemanticVectorStoreRetentionSettings{PreviousGenerations: semanticVectorRetentionGenerationsPtr(-1)}}, wantErr: true},
		{name: "bad-ttl", vs: SemanticVectorStoreSettings{Retention: &SemanticVectorStoreRetentionSettings{PreviousGenerationTTL: "tomorrow"}}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (&SemanticSearchSettings{VectorStore: &tt.vs}).ValidateVectorStore()
			if tt.wantErr && err == nil {
				t.Fatalf("ValidateVectorStore(%#v) succeeded, want error", tt.vs)
			}
			if !tt.wantErr && err != nil {
				t.Fatalf("ValidateVectorStore(%#v) = %v, want nil", tt.vs, err)
			}
		})
	}
}

func TestResolveSemanticVectorStoreDefaults(t *testing.T) {
	res := ResolveSemanticVectorStore(nil, nil, envMapLookup(nil))
	if res.Enabled {
		t.Fatal("Enabled = true for unconfigured store, want false (keyword-only)")
	}
	if res.OptedOut {
		t.Fatal("OptedOut = true for unconfigured store, want false (not explicitly opted out)")
	}
	if res.Backend != SemanticVectorBackendQdrant {
		t.Fatalf("backend = %q, want qdrant default", res.Backend)
	}
	if res.Mode != SemanticVectorStoreModeManaged {
		t.Fatalf("mode = %q, want managed default", res.Mode)
	}
	if res.Install != SemanticVectorStoreInstallLazy {
		t.Fatalf("install = %q, want lazy default", res.Install)
	}
	if res.ManagedRoot != DefaultSemanticManagedRoot {
		t.Fatalf("managedRoot = %q, want default", res.ManagedRoot)
	}
	if semanticVectorRetentionGenerationsValue(&res.Retention) != DefaultSemanticVectorRetentionGenerations || res.Retention.PreviousGenerationTTL != DefaultSemanticVectorRetentionTTL {
		t.Fatalf("retention = %#v, want defaults", res.Retention)
	}
}

func TestResolveSemanticVectorStorePrecedence(t *testing.T) {
	global := &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{Backend: SemanticVectorBackendSQLite}}
	project := &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{Backend: SemanticVectorBackendQdrant, Mode: SemanticVectorStoreModeExternal, ExternalURL: "http://localhost:6333"}}

	// Project overrides global.
	res := ResolveSemanticVectorStore(project, global, envMapLookup(nil))
	if res.Backend != SemanticVectorBackendQdrant || res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "http://localhost:6333" {
		t.Fatalf("project precedence resolution = %#v", res)
	}
	if !res.Enabled || res.OptedOut {
		t.Fatalf("enabled=%v optedOut=%v, want enabled and not opted out", res.Enabled, res.OptedOut)
	}

	// Global used when project has no vector store block.
	projectNoVS := &SemanticSearchSettings{Enabled: true}
	res = ResolveSemanticVectorStore(projectNoVS, global, envMapLookup(nil))
	if res.Backend != SemanticVectorBackendSQLite {
		t.Fatalf("global fallback backend = %q, want sqlite", res.Backend)
	}

	// Env overrides project.
	res = ResolveSemanticVectorStore(project, nil, envMapLookup(map[string]string{
		EnvSemanticVectorBackend: "sqlite",
	}))
	if res.Backend != SemanticVectorBackendSQLite {
		t.Fatalf("env backend override = %q, want sqlite", res.Backend)
	}
	if res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "http://localhost:6333" {
		t.Fatalf("env override should preserve project mode/URL, got %#v", res)
	}
}

func TestResolveSemanticVectorStoreExplicitZeroRetention(t *testing.T) {
	project := &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{
		Retention: &SemanticVectorStoreRetentionSettings{PreviousGenerations: semanticVectorRetentionGenerationsPtr(0)},
	}}
	res := ResolveSemanticVectorStore(project, nil, envMapLookup(nil))
	if got := semanticVectorRetentionGenerationsValue(&res.Retention); got != 0 {
		t.Fatalf("retention.previousGenerations = %d, want explicit zero", got)
	}
	if res.Retention.PreviousGenerationTTL != DefaultSemanticVectorRetentionTTL {
		t.Fatalf("retention.previousGenerationTTL = %q, want default TTL", res.Retention.PreviousGenerationTTL)
	}

	data, err := json.Marshal(project)
	if err != nil {
		t.Fatalf("marshal project with explicit zero retention: %v", err)
	}
	if !bytes.Contains(data, []byte(`"previousGenerations":0`)) {
		t.Fatalf("explicit zero previousGenerations did not round-trip into JSON: %s", data)
	}
	var decoded SemanticSearchSettings
	if err := json.Unmarshal([]byte(`{"enabled":true,"vectorStore":{"retention":{"previousGenerations":0}}}`), &decoded); err != nil {
		t.Fatalf("unmarshal explicit zero retention: %v", err)
	}
	if decoded.VectorStore == nil || decoded.VectorStore.Retention == nil || decoded.VectorStore.Retention.PreviousGenerations == nil || *decoded.VectorStore.Retention.PreviousGenerations != 0 {
		t.Fatalf("decoded explicit zero retention = %#v", decoded.VectorStore)
	}
}

func TestResolveSemanticVectorStoreLayeredRetention(t *testing.T) {
	global := &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{
		Retention: &SemanticVectorStoreRetentionSettings{PreviousGenerations: semanticVectorRetentionGenerationsPtr(0)},
	}}
	project := &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{
		Retention: &SemanticVectorStoreRetentionSettings{PreviousGenerationTTL: "24h"},
	}}
	res := ResolveSemanticVectorStore(project, global, envMapLookup(nil))
	if got := semanticVectorRetentionGenerationsValue(&res.Retention); got != 0 {
		t.Fatalf("layered retention.previousGenerations = %d, want global explicit zero preserved", got)
	}
	if res.Retention.PreviousGenerationTTL != "24h" {
		t.Fatalf("layered retention.previousGenerationTTL = %q, want project override", res.Retention.PreviousGenerationTTL)
	}
}

func TestResolveSemanticVectorStoreOptOut(t *testing.T) {
	tests := []struct {
		name        string
		project     *SemanticSearchSettings
		global      *SemanticSearchSettings
		env         map[string]string
		wantEnabled bool
		wantOptOut  bool
	}{
		{
			name:        "project-disabled",
			project:     &SemanticSearchSettings{Enabled: false},
			wantEnabled: false,
			wantOptOut:  true,
		},
		{
			name:        "global-disabled-fallback",
			global:      &SemanticSearchSettings{Enabled: false},
			wantEnabled: false,
			wantOptOut:  true,
		},
		{
			name:        "global-disabled-overridden-by-project",
			project:     &SemanticSearchSettings{Enabled: true},
			global:      &SemanticSearchSettings{Enabled: false},
			wantEnabled: true,
			wantOptOut:  false,
		},
		{
			name:        "backend-none",
			project:     &SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{Backend: SemanticVectorBackendNone}},
			wantEnabled: false,
			wantOptOut:  true,
		},
		{
			name:        "env-disabled",
			project:     &SemanticSearchSettings{Enabled: true},
			env:         map[string]string{EnvSemanticVectorEnabled: "false"},
			wantEnabled: false,
			wantOptOut:  true,
		},
		{
			name:        "env-enabled-overrides-project-opt-out",
			project:     &SemanticSearchSettings{Enabled: false},
			env:         map[string]string{EnvSemanticVectorEnabled: "1"},
			wantEnabled: true,
			wantOptOut:  false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := ResolveSemanticVectorStore(tt.project, tt.global, envMapLookup(tt.env))
			if res.Enabled != tt.wantEnabled {
				t.Fatalf("Enabled = %v, want %v (res=%#v)", res.Enabled, tt.wantEnabled, res)
			}
			if res.OptedOut != tt.wantOptOut {
				t.Fatalf("OptedOut = %v, want %v (res=%#v)", res.OptedOut, tt.wantOptOut, res)
			}
		})
	}
}

func TestResolveSemanticVectorStoreExternalMode(t *testing.T) {
	// Project-level external mode with URL.
	res := ResolveSemanticVectorStore(
		&SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{Mode: SemanticVectorStoreModeExternal, ExternalURL: "http://qdrant.internal:6333"}},
		nil, envMapLookup(nil),
	)
	if res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "http://qdrant.internal:6333" {
		t.Fatalf("project external resolution = %#v", res)
	}

	// Env URL implies external mode (env > project managed default).
	res = ResolveSemanticVectorStore(
		&SemanticSearchSettings{Enabled: true, VectorStore: &SemanticVectorStoreSettings{Mode: SemanticVectorStoreModeManaged}},
		nil, envMapLookup(map[string]string{EnvQdrantURL: "http://127.0.0.1:6333"}),
	)
	if res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "http://127.0.0.1:6333" {
		t.Fatalf("env URL resolution = %#v", res)
	}

	// Semantic-scoped URL alias.
	res = ResolveSemanticVectorStore(nil, nil, envMapLookup(map[string]string{EnvSemanticQdrantURL: "http://127.0.0.1:6334"}))
	if res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "http://127.0.0.1:6334" {
		t.Fatalf("alias env URL resolution = %#v", res)
	}

	// Env mode external without URL.
	res = ResolveSemanticVectorStore(nil, nil, envMapLookup(map[string]string{EnvSemanticVectorMode: SemanticVectorStoreModeExternal}))
	if res.Mode != SemanticVectorStoreModeExternal || res.ExternalURL != "" {
		t.Fatalf("env mode external resolution = %#v", res)
	}
}
