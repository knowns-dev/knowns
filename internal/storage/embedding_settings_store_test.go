package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// TestLoad_SeedsDefaultsOnFreshMachine covers AC-5: on a machine with no
// ~/.knowns/settings.json, resolving the default model must succeed and
// return 1024 dimensions, and resolving its provider must succeed too, all
// without any network call. Load never makes an HTTP request, so a passing
// test here is sufficient proof no network call occurred.
func TestLoad_SeedsDefaultsOnFreshMachine(t *testing.T) {
	dir := t.TempDir()
	store := NewEmbeddingSettingsStoreWithPath(filepath.Join(dir, "settings.json"))

	settings, err := store.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}

	model, err := settings.GetModel(D2DefaultModelID)
	if err != nil {
		t.Fatalf("GetModel(%q) error = %v", D2DefaultModelID, err)
	}
	if model.Dimensions != 1024 {
		t.Errorf("default model dimensions = %d, want 1024", model.Dimensions)
	}
	if D2DefaultModelID != "qwen3-embedding:0.6b" {
		t.Errorf("D2DefaultModelID = %q, want %q", D2DefaultModelID, "qwen3-embedding:0.6b")
	}

	provider, err := settings.GetProvider(model.Provider)
	if err != nil {
		t.Fatalf("GetProvider(%q) error = %v", model.Provider, err)
	}
	if provider.APIBase == "" {
		t.Error("seeded ollama provider has empty APIBase")
	}

	// The nomic-embed-text and all-minilm models must be present too (D2/FR-5).
	for _, id := range []string{"nomic-embed-text", "all-minilm"} {
		if _, err := settings.GetModel(id); err != nil {
			t.Errorf("GetModel(%q) error = %v, want seeded", id, err)
		}
	}

	// FR-5: no api provider is seeded.
	if _, exists := settings.Providers["api"]; exists {
		t.Error("api provider must not be seeded")
	}

	// Load() must not write to disk.
	if _, err := os.Stat(store.Path()); !os.IsNotExist(err) {
		t.Errorf("Load() must not create the settings file; stat err = %v", err)
	}
}

// TestSeedDefaults_DoesNotOverwriteUserEntry covers AC-6 / Scenario 4: a
// user-defined registry entry with the same key as a seeded model must
// survive seeding byte-identical.
func TestSeedDefaults_DoesNotOverwriteUserEntry(t *testing.T) {
	userModel := EmbeddingModel{
		Provider:   "api",
		Model:      "custom-all-minilm",
		Dimensions: 999,
		MaxTokens:  111,
	}
	userProvider := EmbeddingProvider{
		Name:    "My Custom Ollama",
		APIBase: "http://example.internal:9999/v1",
	}

	settings := &EmbeddingSettings{
		Providers: map[string]EmbeddingProvider{
			OllamaProviderID: userProvider,
		},
		Models: map[string]EmbeddingModel{
			"all-minilm": userModel,
		},
	}

	SeedDefaults(settings)

	if got := settings.Models["all-minilm"]; !reflect.DeepEqual(got, userModel) {
		t.Errorf("user-defined all-minilm model was overwritten: got %+v, want %+v", got, userModel)
	}
	if got := settings.Providers[OllamaProviderID]; !reflect.DeepEqual(got, userProvider) {
		t.Errorf("user-defined ollama provider was overwritten: got %+v, want %+v", got, userProvider)
	}

	// The other two D2 models must still have been seeded around the user's entry.
	if _, err := settings.GetModel("qwen3-embedding:0.6b"); err != nil {
		t.Errorf("default model not seeded alongside user entry: %v", err)
	}
	if _, err := settings.GetModel("nomic-embed-text"); err != nil {
		t.Errorf("nomic-embed-text not seeded alongside user entry: %v", err)
	}
}

// TestSeedDefaults_UserSetDefaultModelPreserved ensures seeding does not
// clobber a user's own choice of default embedding model.
func TestSeedDefaults_UserSetDefaultModelPreserved(t *testing.T) {
	settings := &EmbeddingSettings{DefaultEmbeddingModel: "nomic-embed-text"}
	SeedDefaults(settings)
	if settings.DefaultEmbeddingModel != "nomic-embed-text" {
		t.Errorf("DefaultEmbeddingModel = %q, want unchanged %q", settings.DefaultEmbeddingModel, "nomic-embed-text")
	}
}

// TestSeedDefaults_Idempotent covers NFR-3: seeding must be idempotent across
// repeated runs.
func TestSeedDefaults_Idempotent(t *testing.T) {
	settings := &EmbeddingSettings{
		Providers: make(map[string]EmbeddingProvider),
		Models:    make(map[string]EmbeddingModel),
	}

	if changed := SeedDefaults(settings); !changed {
		t.Fatal("first SeedDefaults() call reported no change on empty settings")
	}
	first, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal after first seed: %v", err)
	}
	modelCount := len(settings.Models)
	providerCount := len(settings.Providers)

	if changed := SeedDefaults(settings); changed {
		t.Error("second SeedDefaults() call reported a change; seeding is not idempotent")
	}
	second, err := json.Marshal(settings)
	if err != nil {
		t.Fatalf("marshal after second seed: %v", err)
	}

	if string(first) != string(second) {
		t.Errorf("seeded settings changed on repeated call:\nfirst:  %s\nsecond: %s", first, second)
	}
	if len(settings.Models) != modelCount {
		t.Errorf("model count changed on repeated seed: %d -> %d", modelCount, len(settings.Models))
	}
	if len(settings.Providers) != providerCount {
		t.Errorf("provider count changed on repeated seed: %d -> %d", providerCount, len(settings.Providers))
	}
}

// TestStoreSeed_IdempotentAcrossRuns covers NFR-3 at the store (disk) level:
// calling Seed() repeatedly against the same file produces byte-identical
// output.
func TestStoreSeed_IdempotentAcrossRuns(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	store := NewEmbeddingSettingsStoreWithPath(path)

	if _, err := store.Seed(); err != nil {
		t.Fatalf("first Seed() error = %v", err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after first seed: %v", err)
	}

	if _, err := store.Seed(); err != nil {
		t.Fatalf("second Seed() error = %v", err)
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after second seed: %v", err)
	}

	if string(first) != string(second) {
		t.Errorf("Seed() is not idempotent on disk:\nfirst:  %s\nsecond: %s", first, second)
	}
}

// TestStoreSeed_PreservesUnknownFields covers FR-16 / AC-24: a settings file
// containing a field the current struct does not model must still contain
// that field after seeding has written the file.
func TestStoreSeed_PreservesUnknownFields(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")

	handWritten := map[string]any{
		"someFutureField": "the-user-or-a-newer-cli-wrote-this",
		"embeddingModels": map[string]any{
			"all-minilm": map[string]any{
				"provider":         "api",
				"model":            "custom",
				"dimensions":       42,
				"futureModelField": "kept-too",
			},
		},
	}
	data, err := json.Marshal(handWritten)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	store := NewEmbeddingSettingsStoreWithPath(path)
	if _, err := store.Seed(); err != nil {
		t.Fatalf("Seed() error = %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read seeded file: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal seeded file: %v", err)
	}

	got, ok := out["someFutureField"]
	if !ok {
		t.Fatal("top-level someFutureField was dropped by seeding")
	}
	if got != "the-user-or-a-newer-cli-wrote-this" {
		t.Errorf("someFutureField = %v, want unchanged value", got)
	}

	// The user's custom all-minilm entry must also have survived, including
	// its own unmodeled field, and must not have been replaced by the D2
	// default all-minilm entry.
	models, ok := out["embeddingModels"].(map[string]any)
	if !ok {
		t.Fatal("embeddingModels missing or wrong type after seeding")
	}
	allMinilm, ok := models["all-minilm"].(map[string]any)
	if !ok {
		t.Fatal("all-minilm entry missing after seeding")
	}
	if allMinilm["provider"] != "api" {
		t.Errorf("user's all-minilm provider overwritten: got %v, want %q", allMinilm["provider"], "api")
	}
	if allMinilm["futureModelField"] != "kept-too" {
		t.Errorf("nested unmodeled field on all-minilm was dropped: got %v", allMinilm["futureModelField"])
	}
}

// TestD2Models_TableShape guards the canonical table's basic invariants:
// exactly one default, and that default is the 1024-dimension model AC-5
// requires.
func TestD2Models_TableShape(t *testing.T) {
	if len(D2Models) != 3 {
		t.Fatalf("D2Models has %d entries, want 3", len(D2Models))
	}
	defaults := 0
	for _, m := range D2Models {
		if m.Model.Provider != OllamaProviderID {
			t.Errorf("model %q has provider %q, want %q", m.ID, m.Model.Provider, OllamaProviderID)
		}
		if m.Default {
			defaults++
			if m.ID != "qwen3-embedding:0.6b" || m.Model.Dimensions != 1024 {
				t.Errorf("default model = %q (%d dims), want qwen3-embedding:0.6b (1024 dims)", m.ID, m.Model.Dimensions)
			}
		}
	}
	if defaults != 1 {
		t.Errorf("D2Models has %d entries marked Default, want exactly 1", defaults)
	}
}
