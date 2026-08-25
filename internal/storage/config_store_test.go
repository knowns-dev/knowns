package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestConfigStoreLoadsLegacyLifecycleDefaultsWithoutRewriting(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"]}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load legacy config: %v", err)
	}
	if project.Settings.TaskLifecycle != nil {
		t.Fatalf("Load materialized legacy lifecycle block: %#v", project.Settings.TaskLifecycle)
	}
	effective := project.Settings.EffectiveTaskLifecycle()
	if !effective.AutoArchive || effective.ArchiveAfter != "30d" {
		t.Fatalf("effective legacy lifecycle = %#v, want built-in defaults", effective)
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save legacy config: %v", err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile saved config: %v", err)
	}
	if strings.Contains(string(data), "taskLifecycle") {
		t.Fatalf("unrelated save rewrote legacy lifecycle config:\n%s", data)
	}
}

// TestConfigStoreResolvesLegacyLocalProviderWithoutRewriting is AC-3: a
// provider: local project resolves to provider: ollama with the D2 default
// model in memory on every read, and the file on disk stays byte-identical
// — including after an unrelated Save(), the same guarantee
// TestConfigStoreLoadsLegacyLifecycleDefaultsWithoutRewriting proves for
// legacy lifecycle defaults (spec ollama-only-embedding D1).
func TestConfigStoreResolvesLegacyLocalProviderWithoutRewriting(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile before Load: %v", err)
	}

	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load legacy config: %v", err)
	}

	// The loaded struct itself must still say "local" — resolution must not
	// mutate what Load returns, or an unrelated Save() below would persist
	// the resolved value.
	if project.Settings.SemanticSearch == nil || project.Settings.SemanticSearch.Provider != "local" {
		t.Fatalf("Load mutated stored semantic settings: %#v", project.Settings.SemanticSearch)
	}

	resolved := ResolveSemanticSearch(project.Settings.SemanticSearch)
	if resolved.Provider != OllamaProviderID {
		t.Fatalf("resolved Provider = %q, want %q", resolved.Provider, OllamaProviderID)
	}
	if resolved.Model != D2DefaultModelID {
		t.Fatalf("resolved Model = %q, want D2 default %q", resolved.Model, D2DefaultModelID)
	}
	if resolved.Dimensions != 1024 {
		t.Fatalf("resolved Dimensions = %d, want 1024 (D2 default)", resolved.Dimensions)
	}

	// File must be byte-identical immediately after Load...
	afterLoad, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Load: %v", err)
	}
	if string(afterLoad) != string(before) {
		t.Fatalf("Load rewrote the file:\nbefore=%s\nafter=%s", before, afterLoad)
	}

	// ...and after an unrelated Save(), the scenario D1 exists to prevent
	// (e.g. `knowns config set` on an unrelated key).
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save legacy config: %v", err)
	}
	afterSave, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Save: %v", err)
	}
	if !strings.Contains(string(afterSave), `"provider": "local"`) {
		t.Fatalf("unrelated Save() rewrote provider away from local:\n%s", afterSave)
	}
	if strings.Contains(string(afterSave), `"provider": "`+OllamaProviderID+`"`) {
		t.Fatalf("unrelated Save() persisted the resolved ollama provider:\n%s", afterSave)
	}
}

// TestProjectSettingsEffectiveSemanticSearchResolvesLegacyLocalProvider is
// AC-3's first clause: "Loading a project config with provider: local
// yields resolved settings with provider: ollama and the D2 default model."
// This exercises the actual production read path -- the
// ProjectSettings.EffectiveSemanticSearch() accessor callers use (mirroring
// EffectiveTaskLifecycle) -- rather than calling ResolveSemanticSearch
// directly, and specifically a config carrying a STALE dimensions value
// (384, the multilingual-e5-small dimension) that must not survive
// resolution: carrying 384 onto a 1024-dimension model would corrupt an
// index. The file on disk stays byte-identical throughout.
func TestProjectSettingsEffectiveSemanticSearchResolvesLegacyLocalProvider(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile before Load: %v", err)
	}

	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load legacy config: %v", err)
	}

	effective := project.Settings.EffectiveSemanticSearch()
	if effective == nil {
		t.Fatal("EffectiveSemanticSearch returned nil for a configured provider: local project")
	}
	if effective.Provider != OllamaProviderID {
		t.Fatalf("effective Provider = %q, want %q", effective.Provider, OllamaProviderID)
	}
	if effective.Model != D2DefaultModelID {
		t.Fatalf("effective Model = %q, want D2 default %q", effective.Model, D2DefaultModelID)
	}
	// The load-bearing assertion: the stale 384-dim override from the local
	// ONNX config must not survive onto the (1024-dim) D2 default model.
	if effective.Dimensions != 1024 {
		t.Fatalf("effective Dimensions = %d, want 1024 (D2 default), not the stale 384 the file carried", effective.Dimensions)
	}
	if effective.MaxTokens != 32768 {
		t.Fatalf("effective MaxTokens = %d, want the D2 default model's own max tokens, not the stale 512 the file carried", effective.MaxTokens)
	}
	if effective.HuggingFaceID != "" {
		t.Fatalf("effective HuggingFaceID = %q, want dropped for a resolved ollama config", effective.HuggingFaceID)
	}

	// The loaded struct itself is untouched: EffectiveSemanticSearch must
	// not mutate the receiver, or a later unrelated Save() would persist
	// the resolved value into a file the user never asked to change (D1).
	if project.Settings.SemanticSearch.Provider != "local" || project.Settings.SemanticSearch.Dimensions != 384 {
		t.Fatalf("EffectiveSemanticSearch mutated the loaded struct: %#v", project.Settings.SemanticSearch)
	}

	afterLoad, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Load: %v", err)
	}
	if string(afterLoad) != string(before) {
		t.Fatalf("Load/EffectiveSemanticSearch rewrote the file:\nbefore=%s\nafter=%s", before, afterLoad)
	}

	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save legacy config: %v", err)
	}
	afterSave, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Save: %v", err)
	}
	if !strings.Contains(string(afterSave), `"dimensions": 384`) {
		t.Fatalf("unrelated Save() rewrote the stale dimensions away from 384:\n%s", afterSave)
	}
}

func TestConfigStoreRejectsInvalidLifecycleDurations(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	invalid := `{"name":"invalid","settings":{"taskLifecycle":{"archiveAfter":"-1d"}}}`
	if err := os.WriteFile(configPath, []byte(invalid), 0o644); err != nil {
		t.Fatalf("WriteFile invalid config: %v", err)
	}
	store := NewStore(root)
	if _, err := store.Config.Load(); err == nil || !strings.Contains(err.Error(), "archiveAfter") {
		t.Fatalf("Load invalid lifecycle error = %v, want archiveAfter validation", err)
	}

	settings := models.DefaultProjectSettings()
	settings.TaskLifecycle.ArchiveAfter = "tomorrow"
	if err := store.Config.Save(&models.Project{Name: "invalid", Settings: settings}); err == nil {
		t.Fatal("Save invalid lifecycle config succeeded, want error")
	}
}

func TestConfigStoreSetRejectsInvalidLifecycleWithoutMutation(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	if err := store.Init("config-set"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	configPath := filepath.Join(root, "config.json")
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile before Set: %v", err)
	}
	if err := store.Config.Set("settings.taskLifecycle.archiveAfter", "-2h"); err == nil {
		t.Fatal("Set invalid lifecycle duration succeeded, want error")
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Set: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("invalid Set mutated config:\nbefore=%s\nafter=%s", before, after)
	}
}

func TestConfigStoreNormalizesTaskIDPrefix(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	if err := store.Init("prefix-config"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	if err := store.Config.Set("settings.defaultTaskIdPrefix", " kn "); err != nil {
		t.Fatalf("Set task ID prefix: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if project.Settings.DefaultTaskIDPrefix != "KN" {
		t.Fatalf("DefaultTaskIDPrefix = %q, want KN", project.Settings.DefaultTaskIDPrefix)
	}
	// The canonical form must be what landed on disk, not the raw input.
	raw, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(raw), `"defaultTaskIdPrefix": "KN"`) {
		t.Fatalf("config.json did not persist the canonical prefix:\n%s", raw)
	}

	before := raw
	if err := store.Config.Set("settings.defaultTaskIdPrefix", "1bad"); err == nil {
		t.Fatal("Set invalid task ID prefix succeeded, want error")
	}
	after, err := os.ReadFile(filepath.Join(root, "config.json"))
	if err != nil {
		t.Fatalf("ReadFile after invalid Set: %v", err)
	}
	if string(after) != string(before) {
		t.Fatal("invalid task ID prefix mutated config")
	}
}

// TestConfigStoreLoadsHuggingFaceIDWithoutFailureOrWarning is AC-29's second
// half: a config that still carries huggingFaceId (not yet migrated, or a
// hand-edited file) must load cleanly — no error, and no warning logged —
// even though `knowns migrate --write` drops the field going forward.
func TestConfigStoreLoadsHuggingFaceIDWithoutFailureOrWarning(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"],"semanticSearch":{"enabled":true,"provider":"local","model":"multilingual-e5-small","huggingFaceId":"Xenova/multilingual-e5-small","dimensions":384,"maxTokens":512}}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load config carrying huggingFaceId returned an error: %v", err)
	}
	if project.Settings.SemanticSearch == nil || project.Settings.SemanticSearch.HuggingFaceID != "Xenova/multilingual-e5-small" {
		t.Fatalf("Load did not preserve huggingFaceId on an unmigrated config: %#v", project.Settings.SemanticSearch)
	}
}
