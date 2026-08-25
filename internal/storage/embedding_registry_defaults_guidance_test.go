package storage

import (
	"strings"
	"testing"
)

// TestRecommendedModels_NamesAllThreeSeededModels is AC's "names all three
// seeded models with the tradeoff that distinguishes each, and gives the
// install and pull commands" requirement, read directly off D2Models.
func TestRecommendedModels_NamesAllThreeSeededModels(t *testing.T) {
	guidance := RecommendedModels()
	if len(guidance) != 3 {
		t.Fatalf("expected 3 recommended models, got %d", len(guidance))
	}

	seen := map[string]ModelGuidance{}
	for _, g := range guidance {
		seen[g.ID] = g
	}

	for _, id := range []string{"qwen3-embedding:0.6b", "nomic-embed-text", "all-minilm"} {
		g, ok := seen[id]
		if !ok {
			t.Fatalf("RecommendedModels missing entry for %q", id)
		}
		if strings.TrimSpace(g.Tradeoff) == "" {
			t.Errorf("%s: Tradeoff is empty", id)
		}
		if g.InstallLocation != OllamaInstallURL {
			t.Errorf("%s: InstallLocation = %q, want %q", id, g.InstallLocation, OllamaInstallURL)
		}
		if want := "ollama pull " + id; g.PullCommand != want {
			t.Errorf("%s: PullCommand = %q, want %q", id, g.PullCommand, want)
		}
		if g.Dimensions <= 0 {
			t.Errorf("%s: Dimensions not populated (%d)", id, g.Dimensions)
		}
	}

	// The three tradeoffs must actually distinguish the models from each
	// other, not restate a generic blurb.
	if seen["qwen3-embedding:0.6b"].Tradeoff == seen["nomic-embed-text"].Tradeoff ||
		seen["nomic-embed-text"].Tradeoff == seen["all-minilm"].Tradeoff ||
		seen["qwen3-embedding:0.6b"].Tradeoff == seen["all-minilm"].Tradeoff {
		t.Error("tradeoffs must differ per model, not share generic text")
	}
}

// TestRecommendedModels_DerivedFromD2Models is the AC-15 property test: it
// mutates the canonical D2Models table (as a later task adding or removing a
// D2 model would) and asserts RecommendedModels reflects the change without
// any edit to RecommendedModels itself. A surface that restated the model
// list independently — instead of calling RecommendedModels — would not be
// caught by this test failing, but RecommendedModels itself failing this
// property would prove the accessor is not actually reading D2Models.
func TestRecommendedModels_DerivedFromD2Models(t *testing.T) {
	original := D2Models
	defer func() { D2Models = original }()

	D2Models = append(append([]D2ModelDefinition{}, original...), D2ModelDefinition{
		ID:       "fake-test-model",
		Model:    EmbeddingModel{Provider: OllamaProviderID, Model: "fake-test-model", Dimensions: 42},
		Tradeoff: "a fake tradeoff added only for this test",
	})

	guidance := RecommendedModels()
	if len(guidance) != len(original)+1 {
		t.Fatalf("expected %d entries after appending to D2Models, got %d", len(original)+1, len(guidance))
	}

	var found bool
	for _, g := range guidance {
		if g.ID == "fake-test-model" {
			found = true
			if g.Tradeoff != "a fake tradeoff added only for this test" {
				t.Errorf("appended model's Tradeoff not carried through: %q", g.Tradeoff)
			}
			if g.PullCommand != "ollama pull fake-test-model" {
				t.Errorf("appended model's PullCommand wrong: %q", g.PullCommand)
			}
		}
	}
	if !found {
		t.Error("RecommendedModels did not pick up a model appended to D2Models")
	}
}

// TestOllamaStateGuidance_FirstThreeStatesNameNextStepAndKeywordFallback
// covers FR-10/AC-14: the three non-ready states must each name their own
// specific next step (not a shared generic message) and each must state
// that keyword search continues to work regardless.
func TestOllamaStateGuidance_FirstThreeStatesNameNextStepAndKeywordFallback(t *testing.T) {
	states := []OllamaState{OllamaNotInstalled, OllamaNotRunning, OllamaModelMissing}
	descriptions := map[OllamaState]string{}

	for _, s := range states {
		g := OllamaStateGuidance(s, "qwen3-embedding:0.6b")
		if !strings.Contains(g.Description, "Keyword search") {
			t.Errorf("state %v: Description does not reassure that keyword search still works: %q", s, g.Description)
		}
		descriptions[s] = g.Description
	}

	// Each state's next step must be distinguishable from the others'.
	if descriptions[OllamaNotInstalled] == descriptions[OllamaNotRunning] ||
		descriptions[OllamaNotRunning] == descriptions[OllamaModelMissing] ||
		descriptions[OllamaNotInstalled] == descriptions[OllamaModelMissing] {
		t.Error("the three states must carry distinct guidance, not one generic message")
	}

	notInstalled := OllamaStateGuidance(OllamaNotInstalled, "")
	if !strings.Contains(notInstalled.Description, OllamaInstallURL) {
		t.Errorf("OllamaNotInstalled guidance must name the install location: %q", notInstalled.Description)
	}

	notRunning := OllamaStateGuidance(OllamaNotRunning, "")
	if notRunning.Command == "" {
		t.Error("OllamaNotRunning guidance should name a concrete next command")
	}

	missing := OllamaStateGuidance(OllamaModelMissing, "nomic-embed-text")
	if missing.Command != "ollama pull nomic-embed-text" {
		t.Errorf("OllamaModelMissing Command = %q, want the pull command for the configured model", missing.Command)
	}
	if !strings.Contains(missing.Description, "nomic-embed-text") {
		t.Errorf("OllamaModelMissing Description must name the missing model: %q", missing.Description)
	}
}

// TestOllamaStateGuidance_DefaultsToD2DefaultModel covers FR-11: a caller
// that passes no model ID still gets guidance naming the default model and
// the command to obtain it.
func TestOllamaStateGuidance_DefaultsToD2DefaultModel(t *testing.T) {
	g := OllamaStateGuidance(OllamaModelMissing, "")
	if !strings.Contains(g.Description, D2DefaultModelID) {
		t.Errorf("empty modelID should fall back to the D2 default (%s) in Description: %q", D2DefaultModelID, g.Description)
	}
	if want := "ollama pull " + D2DefaultModelID; g.Command != want {
		t.Errorf("Command = %q, want %q", g.Command, want)
	}
}

// TestOllamaStateGuidance_ReadyStateHasNoNextStep covers the fourth FR-10
// state: ready, with no pending action.
func TestOllamaStateGuidance_ReadyStateHasNoNextStep(t *testing.T) {
	g := OllamaStateGuidance(OllamaReady, "qwen3-embedding:0.6b")
	if g.Command != "" {
		t.Errorf("OllamaReady should have no pending command, got %q", g.Command)
	}
	if !strings.Contains(g.Description, "ready") && !strings.Contains(g.Description, "Ready") {
		t.Errorf("OllamaReady Description should say search is ready: %q", g.Description)
	}
}
