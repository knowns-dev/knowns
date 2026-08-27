package storage

import "github.com/howznguyen/knowns/internal/models"

// legacySemanticProvider is the pre-Ollama-only default provider value. An
// explicit "local" and an omitted provider meant the same thing (see
// models.SemanticSearchSettings.Provider's doc comment: "local" is the
// default), so both resolve the same way.
const legacySemanticProvider = "local"

// ResolveSemanticSearch returns settings resolved per spec
// ollama-only-embedding D1/FR-3: a project declaring provider: local (or
// omitting provider, its historical default) resolves in memory as though it
// declared provider: ollama with the D2 default model, independent of what
// is installed, pulled, or configured on the machine (D9). Any other
// provider is returned unchanged.
//
// The input is never mutated and nothing is written to disk: nil in, nil
// out; otherwise a resolved copy is returned. This is the resolver-accessor
// pattern ConfigStore.Load already establishes for legacy lifecycle defaults
// (see EffectiveTaskLifecycle and
// TestConfigStoreLoadsLegacyLifecycleDefaultsWithoutRewriting) — mutating
// the loaded struct in place would make an unrelated later Save() persist a
// change the user never asked for, which breaks D1.
func ResolveSemanticSearch(settings *models.SemanticSearchSettings) *models.SemanticSearchSettings {
	if settings == nil {
		return nil
	}
	resolved := *settings
	if resolved.Provider != legacySemanticProvider && resolved.Provider != "" {
		return &resolved
	}

	def := d2DefaultModel()
	resolved.Provider = OllamaProviderID
	resolved.Model = def.ID
	resolved.Dimensions = def.Model.Dimensions
	resolved.MaxTokens = def.Model.MaxTokens
	// HuggingFaceID only ever meant something for provider "local"; it does
	// not describe an Ollama model, so a resolved-in-memory view drops it
	// rather than carry over a now-meaningless field.
	resolved.HuggingFaceID = ""
	return &resolved
}

// d2DefaultModel returns the full D2Models entry for D2DefaultModelID, so
// resolution never hardcodes the default model's dimensions or max tokens
// separately from the canonical D2Models table.
func d2DefaultModel() D2ModelDefinition {
	for _, m := range D2Models {
		if m.ID == D2DefaultModelID {
			return m
		}
	}
	panic("storage: D2DefaultModelID not found in D2Models")
}

// init registers ResolveSemanticSearch as the implementation
// models.ProjectSettings.EffectiveSemanticSearch() delegates to (spec
// ollama-only-embedding D1/FR-3). Any binary that imports internal/storage
// — effectively every command in this tree — gets this registered before
// main() runs, since Go runs every imported package's init() first.
func init() {
	models.RegisterSemanticSearchResolver(ResolveSemanticSearch)
}
