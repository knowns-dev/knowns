package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestLocalONNXModelChoicesShowDownloadStatus(t *testing.T) {
	home := t.TempDir()
	oldHome := os.Getenv("HOME")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatalf("set HOME: %v", err)
	}
	t.Cleanup(func() { _ = os.Setenv("HOME", oldHome) })

	model := findSupportedModel("gte-small")
	if model == nil {
		t.Fatal("missing gte-small model")
	}
	installedPath := filepath.Join(home, ".knowns", "models", model.HuggingFace, "onnx", "model_quantized.onnx")
	if err := os.MkdirAll(filepath.Dir(installedPath), 0755); err != nil {
		t.Fatalf("mkdir model dir: %v", err)
	}
	if err := os.WriteFile(installedPath, []byte("onnx"), 0644); err != nil {
		t.Fatalf("write model file: %v", err)
	}

	choices := localONNXModelChoices("gte-small")
	var installedLabel, missingLabel string
	for _, choice := range choices {
		switch choice.Model.ID {
		case "gte-small":
			installedLabel = choice.Label
		case "gte-base":
			missingLabel = choice.Label
		}
	}
	if !strings.Contains(installedLabel, "downloaded") || !strings.Contains(installedLabel, "current") {
		t.Fatalf("expected installed current label, got %q", installedLabel)
	}
	if !strings.Contains(missingLabel, "not downloaded") {
		t.Fatalf("expected missing label, got %q", missingLabel)
	}
}

func TestSaveLocalONNXSemanticSettingsPersistsFullConfig(t *testing.T) {
	store, project := newConfigTestProject(t)
	model := findSupportedModel("gte-small")
	if model == nil {
		t.Fatal("missing gte-small model")
	}

	if err := saveLocalONNXSemanticSettings(store, project, model); err != nil {
		t.Fatalf("save local ONNX settings: %v", err)
	}

	saved, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load saved config: %v", err)
	}
	ss := saved.Settings.SemanticSearch
	if ss == nil {
		t.Fatal("expected semantic search settings")
	}
	if !ss.Enabled || ss.Provider != "local" || ss.Model != model.ID {
		t.Fatalf("unexpected semantic config: %#v", ss)
	}
	if ss.HuggingFaceID != model.HuggingFace || ss.Dimensions != model.Dimensions || ss.MaxTokens != model.MaxTokens {
		t.Fatalf("expected full model metadata, got %#v", ss)
	}
}

func TestApplyLocalONNXSelectionDeclineLeavesConfigUnchanged(t *testing.T) {
	home := t.TempDir()
	oldHome := os.Getenv("HOME")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatalf("set HOME: %v", err)
	}
	t.Cleanup(func() { _ = os.Setenv("HOME", oldHome) })

	store, project := newConfigTestProject(t)
	project.Settings.SemanticSearch = &models.SemanticSearchSettings{
		Enabled:       true,
		Provider:      "local",
		Model:         "gte-small",
		HuggingFaceID: "Xenova/gte-small",
		Dimensions:    384,
		MaxTokens:     512,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	saved, err := applyLocalONNXSelection(store, project, "gte-base", func(*embeddingModel) (bool, error) {
		return false, nil
	})
	if err != nil {
		t.Fatalf("apply selection: %v", err)
	}
	if saved {
		t.Fatal("expected declined selection to skip save")
	}

	loaded, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got := loaded.Settings.SemanticSearch.Model; got != "gte-small" {
		t.Fatalf("expected previous model to remain, got %q", got)
	}
}

func TestApplyLocalONNXSelectionDownloadsMissingModelBeforeSave(t *testing.T) {
	home := t.TempDir()
	oldHome := os.Getenv("HOME")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatalf("set HOME: %v", err)
	}
	t.Cleanup(func() { _ = os.Setenv("HOME", oldHome) })

	store, project := newConfigTestProject(t)
	oldSetup := runSemanticSetupForSettings
	var downloaded string
	runSemanticSetupForSettings = func(modelID string, force ...bool) error {
		downloaded = modelID
		return nil
	}
	t.Cleanup(func() { runSemanticSetupForSettings = oldSetup })

	saved, err := applyLocalONNXSelection(store, project, "gte-base", func(*embeddingModel) (bool, error) {
		return true, nil
	})
	if err != nil {
		t.Fatalf("apply selection: %v", err)
	}
	if !saved {
		t.Fatal("expected approved selection to save")
	}
	if downloaded != "gte-base" {
		t.Fatalf("expected download for gte-base, got %q", downloaded)
	}

	loaded, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got := loaded.Settings.SemanticSearch.Model; got != "gte-base" {
		t.Fatalf("expected selected model, got %q", got)
	}
	if loaded.Settings.SemanticSearch.Dimensions != 768 {
		t.Fatalf("expected gte-base dimensions, got %d", loaded.Settings.SemanticSearch.Dimensions)
	}
}

func TestProviderSettingsForAPIAndOllamaRemainMinimal(t *testing.T) {
	for _, provider := range []string{"api", "ollama"} {
		ss := &models.SemanticSearchSettings{Enabled: true, Provider: provider, Model: "embed-model"}
		if ss.HuggingFaceID != "" || ss.Dimensions != 0 || ss.MaxTokens != 0 {
			t.Fatalf("expected %s provider config to remain provider/model only, got %#v", provider, ss)
		}
	}
}

func newConfigTestProject(t *testing.T) (*storage.Store, *models.Project) {
	t.Helper()
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("config-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load project: %v", err)
	}
	return store, project
}
