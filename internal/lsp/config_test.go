package lsp

import (
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestConfigFromProject(t *testing.T) {
	falseValue := false
	project := &models.Project{Settings: models.ProjectSettings{LSP: &models.LSPSettings{Languages: map[string]models.LSPLanguageSettings{"go": {Enabled: &falseValue, Binary: "custom-gopls"}}}}}
	cfg := ConfigFromProject(project)
	if cfg.Enabled("go") {
		t.Fatal("go enabled, want disabled")
	}
	if got := cfg.BinaryOverride("go"); got != "custom-gopls" {
		t.Fatalf("binary = %q, want custom-gopls", got)
	}
	if !cfg.Enabled("rust") {
		t.Fatal("missing language disabled, want enabled")
	}
}

func TestVersionOverride(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		"go": {Version: "1.21.0"},
	}}

	if got := cfg.VersionOverride("go"); got != "1.21.0" {
		t.Fatalf("VersionOverride(go) = %q, want 1.21.0", got)
	}
	if got := cfg.VersionOverride("rust"); got != "" {
		t.Fatalf("VersionOverride(rust) = %q, want empty", got)
	}
}

func TestLanguageSettings(t *testing.T) {
	settings := map[string]any{
		"analyses":   map[string]any{"unusedparams": true},
		"buildFlags": []any{"-tags=integration"},
	}
	cfg := Config{Languages: map[string]LanguageConfig{
		"go": {Settings: settings},
	}}

	got := cfg.LanguageSettings("go")
	if got == nil {
		t.Fatal("LanguageSettings(go) = nil, want non-nil")
	}
	if _, ok := got["analyses"]; !ok {
		t.Fatal("LanguageSettings(go) missing 'analyses' key")
	}

	if cfg.LanguageSettings("rust") != nil {
		t.Fatal("LanguageSettings(rust) should be nil for missing language")
	}

	// Language in config but no settings
	cfg2 := Config{Languages: map[string]LanguageConfig{
		"python": {Binary: "pyright"},
	}}
	if cfg2.LanguageSettings("python") != nil {
		t.Fatal("LanguageSettings(python) should be nil when no settings configured")
	}
}

func TestIsDisabled(t *testing.T) {
	trueValue := true
	falseValue := false

	cfg := Config{Languages: map[string]LanguageConfig{
		"go":     {Enabled: &falseValue},
		"rust":   {Enabled: &trueValue},
		"python": {}, // Enabled is nil
	}}

	// Explicitly disabled
	if !cfg.IsDisabled("go") {
		t.Fatal("IsDisabled(go) = false, want true")
	}

	// Explicitly enabled
	if cfg.IsDisabled("rust") {
		t.Fatal("IsDisabled(rust) = true, want false")
	}

	// Enabled is nil (not explicitly set)
	if cfg.IsDisabled("python") {
		t.Fatal("IsDisabled(python) = true, want false (nil means not disabled)")
	}

	// Language not in config at all
	if cfg.IsDisabled("java") {
		t.Fatal("IsDisabled(java) = true, want false (missing language)")
	}
}

func TestConfigFromProjectWithNewFields(t *testing.T) {
	falseValue := false
	settings := map[string]any{"formatting": true}
	project := &models.Project{Settings: models.ProjectSettings{LSP: &models.LSPSettings{
		Languages: map[string]models.LSPLanguageSettings{
			"go": {
				Enabled:  &falseValue,
				Binary:   "custom-gopls",
				Version:  "0.15.0",
				Settings: settings,
			},
		},
	}}}

	cfg := ConfigFromProject(project)

	if got := cfg.VersionOverride("go"); got != "0.15.0" {
		t.Fatalf("VersionOverride(go) = %q, want 0.15.0", got)
	}
	if got := cfg.LanguageSettings("go"); got == nil {
		t.Fatal("LanguageSettings(go) = nil, want non-nil")
	} else if _, ok := got["formatting"]; !ok {
		t.Fatal("LanguageSettings(go) missing 'formatting' key")
	}
	if !cfg.IsDisabled("go") {
		t.Fatal("IsDisabled(go) = false, want true")
	}
}

func TestConfigFromProjectWithDefaultsProjectOverridesGlobal(t *testing.T) {
	globalEnabled := true
	projectEnabled := false
	defaults := &storage.ProjectDefaults{Settings: models.ProjectSettings{LSP: &models.LSPSettings{
		Languages: map[string]models.LSPLanguageSettings{
			CSharpLanguageID: {
				Enabled:     &globalEnabled,
				Backend:     CSharpBackendRoslyn,
				ProjectPath: "global.sln",
				Settings:    map[string]any{"globalOnly": true, "shared": "global"},
			},
		},
	}}}
	project := &models.Project{Settings: models.ProjectSettings{LSP: &models.LSPSettings{
		Languages: map[string]models.LSPLanguageSettings{
			CSharpLanguageID: {
				Enabled:     &projectEnabled,
				Backend:     CSharpBackendOmni,
				ProjectPath: "project.sln",
				Settings:    map[string]any{"projectOnly": true, "shared": "project"},
			},
		},
	}}}

	cfg := ConfigFromProjectWithDefaults(project, defaults)
	if cfg.Enabled(CSharpLanguageID) {
		t.Fatal("Enabled(csharp) = true, want project override false")
	}
	if got := cfg.BackendOverride(CSharpLanguageID); got != CSharpBackendOmni {
		t.Fatalf("BackendOverride(csharp) = %q, want %q", got, CSharpBackendOmni)
	}
	if got := cfg.ProjectPathOverride(CSharpLanguageID); got != "project.sln" {
		t.Fatalf("ProjectPathOverride(csharp) = %q, want project.sln", got)
	}
	settings := cfg.LanguageSettings(CSharpLanguageID)
	if settings["globalOnly"] != true || settings["projectOnly"] != true || settings["shared"] != "project" {
		t.Fatalf("merged settings = %#v, want global+project with project shared value", settings)
	}
}

func TestBackendAndProjectPathOverrides(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {Backend: CSharpBackendCSharp, ProjectPath: "src/App.sln"},
	}}
	if got := cfg.BackendOverride(CSharpLanguageID); got != CSharpBackendCSharp {
		t.Fatalf("BackendOverride(csharp) = %q, want %q", got, CSharpBackendCSharp)
	}
	if got := cfg.ProjectPathOverride(CSharpLanguageID); got != "src/App.sln" {
		t.Fatalf("ProjectPathOverride(csharp) = %q, want src/App.sln", got)
	}
}
