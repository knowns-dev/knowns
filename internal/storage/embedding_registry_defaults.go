package storage

import "fmt"

// This file is the single canonical home for Locked Decision D2 of the
// ollama-only-embedding spec: the three Apache-2.0, Ollama-native embedding
// models seeded into every user's global registry, and which one is the
// default. FR-9 (task OLM-JF91HA) extends the entries below with guidance
// fields — a tradeoff blurb, install location, and pull command — so that
// setup, `doctor`, `init`, and the published docs all resolve their model
// recommendations from this one table instead of restating them. Add those
// fields to D2ModelDefinition and to the literals in D2Models; do not create
// a second list elsewhere.
//
// FR-9/FR-10/FR-11 (D6): this file is also the single origin of the guidance
// text setup, `doctor`, and `init` show for Ollama's four states —
// OllamaNotInstalled, OllamaNotRunning, OllamaModelMissing, OllamaReady — via
// OllamaStateGuidance, and of the per-model guidance (tradeoff, install
// location, pull command) via RecommendedModels. Consuming surfaces are
// wired by task OLM-XJKSB7 (init/setup) and OLM-K4NHTY (doctor); both call
// these two functions rather than restate D2Models locally.

// OllamaProviderID is the registry key the D2 models are seeded against, and
// the provider ID the interactive flow in cli/config.go already uses.
const OllamaProviderID = "ollama"

// OllamaHostBase is the single origin of Ollama's default local endpoint.
// It lives in storage rather than search because the dependency runs that
// way — search imports storage — so search derives its own OllamaDefaultBase
// from this constant. Defining it in both places behind a "keep in sync"
// comment is exactly the drift FR-9 exists to prevent.
const OllamaHostBase = "http://localhost:11434"

// OllamaGuidanceDocsURL is where a user reads the full Ollama embedding
// guidance: the prose home FR-9 designates for the recommended models, the
// install and pull commands, and the shape of a third-party provider entry.
// It lives here with the rest of the guidance data so a surface that tells
// the user where to read more cannot drift from the surfaces that summarise
// it — the same single-origin rule FR-9 applies to the model list itself.
const OllamaGuidanceDocsURL = "https://knowns.sh/docs"

// ollamaProviderAPIBase is the OpenAI-compatible embeddings endpoint Ollama
// serves, derived from OllamaHostBase rather than restated.
const ollamaProviderAPIBase = OllamaHostBase + "/v1"

// OllamaInstallURL is the FR-9 "install location" fact: the one place every
// guidance surface (setup, doctor, init, and the published docs) sends a
// user to install Ollama. It is a single value, not per-model, because all
// three D2 models run on the same Ollama runtime.
const OllamaInstallURL = "https://ollama.com/download"

// D2ModelDefinition describes one of the three models Locked Decision D2
// seeds into the global registry. ID is both the registry key and the model
// name passed to Ollama (e.g. "ollama pull <ID>"). Default marks the single
// entry FR-5 designates as the default resolved for `provider: ollama` when
// no more specific model is configured. Tradeoff is the one-line fact that
// distinguishes this model from the other two D2 entries (FR-9): it must
// name what is actually different — dimensions, context window, and a
// size/speed/quality tradeoff — not a generic blurb that could describe any
// embedding model.
type D2ModelDefinition struct {
	ID       string
	Default  bool
	Model    EmbeddingModel
	Tradeoff string
}

// PullCommand is the exact `ollama pull` invocation for this model — the
// FR-9 "pull command" fact, derived from ID rather than hand-typed at each
// call site.
func (d D2ModelDefinition) PullCommand() string {
	return pullCommandFor(d.ID)
}

// pullCommandFor is the single origin of the pull-command format. Both the
// per-model guidance and the state guidance below render through it, so the
// command cannot drift between the two the way FR-9 exists to prevent.
func pullCommandFor(modelID string) string {
	return "ollama pull " + modelID
}

// D2Models is the canonical, single-source D2 model table. Real dimensions,
// context limits, and prefixes were sourced from each model's own
// documentation rather than assumed:
//
//   - qwen3-embedding:0.6b: 1024-dimension output (AC-5), 32k-token context.
//     Instruction-aware/asymmetric: Qwen's model card recommends prefixing
//     queries with "Instruct: {task}\nQuery: " and leaving documents
//     unprefixed. Source: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B,
//     https://ollama.com/library/qwen3-embedding.
//   - nomic-embed-text: 768 dimensions, 8192-token context. Asymmetric,
//     requires "search_query: " / "search_document: " prefixes. Source:
//     https://huggingface.co/nomic-ai/nomic-embed-text-v1.5,
//     https://ollama.com/library/nomic-embed-text. These values already match
//     the "nomic-embed-text-v1.5" entry the (now-removed) ONNX table carried
//     at internal/search/types.go.
//   - all-minilm: 384 dimensions. Ollama's default tag serves the L6-v2
//     variant, whose own model card documents a 256 word-piece truncation
//     limit despite the underlying encoder supporting longer input, so
//     MaxTokens is 256, not 512. Symmetric: no query/document prefix needed.
//     Source: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2,
//     https://ollama.com/library/all-minilm. Matches the "all-MiniLM-L6-v2"
//     entry the ONNX table carried.
var D2Models = []D2ModelDefinition{
	{
		ID:      "qwen3-embedding:0.6b",
		Default: true,
		Model: EmbeddingModel{
			Provider:    OllamaProviderID,
			Model:       "qwen3-embedding:0.6b",
			Dimensions:  1024,
			MaxTokens:   32768,
			QueryPrefix: "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ",
		},
		Tradeoff: "Best retrieval quality of the three: 1024 dimensions and a 32k-token context window, instruction-aware for better ranking. The largest and slowest of the three to embed with — the default because quality matters more than speed for most projects.",
	},
	{
		ID: "nomic-embed-text",
		Model: EmbeddingModel{
			Provider:    OllamaProviderID,
			Model:       "nomic-embed-text",
			Dimensions:  768,
			MaxTokens:   8192,
			QueryPrefix: "search_query: ",
			DocPrefix:   "search_document: ",
		},
		Tradeoff: "Balanced middle ground: 768 dimensions and an 8192-token context window — smaller and faster than qwen3-embedding:0.6b, with far more context headroom than all-minilm for long documents.",
	},
	{
		ID: "all-minilm",
		Model: EmbeddingModel{
			Provider:   OllamaProviderID,
			Model:      "all-minilm",
			Dimensions: 384,
			MaxTokens:  256,
		},
		Tradeoff: "Smallest and fastest of the three: 384 dimensions and only a 256-token context window per chunk. Best for large corpora where indexing speed and RAM matter most, at the cost of truncating longer chunks and lower retrieval quality.",
	},
}

// D2DefaultModelID is the registry key of the D2 default model
// (qwen3-embedding:0.6b), derived from D2Models rather than duplicated.
var D2DefaultModelID = func() string {
	for _, m := range D2Models {
		if m.Default {
			return m.ID
		}
	}
	panic("storage: D2Models has no entry marked Default")
}()

// ModelGuidance is the rendered, per-model guidance FR-9 requires: the
// tradeoff that distinguishes the model from the other two D2 entries, where
// to install the Ollama runtime that serves it, and the exact command to
// pull it.
type ModelGuidance struct {
	ID              string
	Default         bool
	Dimensions      int
	MaxTokens       int
	Tradeoff        string
	InstallLocation string
	PullCommand     string
}

// RecommendedModels renders FR-9's per-model guidance from D2Models, the
// single canonical table, so a model added to or removed from D2Models
// changes the guidance every surface shows without any of them being edited
// (AC-15). Callers — setup, doctor, init, and anything generating the
// published docs — must call this rather than restate the D2 model list.
func RecommendedModels() []ModelGuidance {
	out := make([]ModelGuidance, 0, len(D2Models))
	for _, m := range D2Models {
		out = append(out, ModelGuidance{
			ID:              m.ID,
			Default:         m.Default,
			Dimensions:      m.Model.Dimensions,
			MaxTokens:       m.Model.MaxTokens,
			Tradeoff:        m.Tradeoff,
			InstallLocation: OllamaInstallURL,
			PullCommand:     m.PullCommand(),
		})
	}
	return out
}

// OllamaState is one of the four states FR-10 requires setup, doctor, and
// init to distinguish, each acting differently and naming its own specific
// next step.
type OllamaState int

const (
	// OllamaNotInstalled: no Ollama binary/service was reachable at all.
	OllamaNotInstalled OllamaState = iota
	// OllamaNotRunning: Ollama is installed but not answering requests.
	OllamaNotRunning
	// OllamaModelMissing: Ollama is running but the required model has not
	// been pulled.
	OllamaModelMissing
	// OllamaReady: Ollama is running and the required model is present.
	OllamaReady
)

// keywordSearchStillWorksNote is the AC-14/FR-10 reassurance every
// non-ready state must carry: an unreachable or incomplete Ollama degrades
// semantic search, it does not take search away.
const keywordSearchStillWorksNote = "Keyword search still works without it."

// OllamaGuidance is the rendered FR-10 guidance for one OllamaState: a
// human-readable description naming the specific next step, and — where a
// single next command exists — the exact command. Its field names match
// doctor's Remediation{Description, Command} so a caller can construct one
// directly from the other.
type OllamaGuidance struct {
	Description string
	Command     string
}

// OllamaStateGuidance renders FR-10/FR-11's guidance for one of the four
// Ollama states from the single D2Models/OllamaInstallURL source, so setup,
// doctor, and init resolve identical text instead of restating it locally
// (AC-15). modelID is the model the caller cares about — typically the
// project's configured model when checking OllamaModelMissing/OllamaReady —
// and falls back to the D2 default (FR-11) when empty.
func OllamaStateGuidance(state OllamaState, modelID string) OllamaGuidance {
	if modelID == "" {
		modelID = D2DefaultModelID
	}
	pullCmd := pullCommandFor(modelID)

	switch state {
	case OllamaNotInstalled:
		return OllamaGuidance{
			Description: fmt.Sprintf(
				"Ollama is not installed. Install it from %s, then run `%s` to get the recommended model. %s",
				OllamaInstallURL, pullCmd, keywordSearchStillWorksNote,
			),
		}
	case OllamaNotRunning:
		return OllamaGuidance{
			Description: fmt.Sprintf(
				"Ollama is installed but not running. Start it, then run `%s` if the model isn't pulled yet. %s",
				pullCmd, keywordSearchStillWorksNote,
			),
			Command: "ollama serve",
		}
	case OllamaModelMissing:
		return OllamaGuidance{
			Description: fmt.Sprintf(
				"Ollama is running but %s is not pulled yet. Run `%s` to get it. %s",
				modelID, pullCmd, keywordSearchStillWorksNote,
			),
			Command: pullCmd,
		}
	case OllamaReady:
		return OllamaGuidance{
			Description: fmt.Sprintf("Ollama is running with %s available. Semantic search is ready.", modelID),
		}
	default:
		panic(fmt.Sprintf("storage: unknown OllamaState %d", state))
	}
}

// defaultOllamaProvider returns the ollama provider entry seeded alongside
// the D2 models. Ollama's default local endpoint needs no user input, unlike
// a third-party API provider (which needs a URL and usually a key) — FR-5
// deliberately seeds no `api` provider for that reason.
func defaultOllamaProvider() EmbeddingProvider {
	return EmbeddingProvider{
		Name:      "Ollama Local",
		APIBase:   ollamaProviderAPIBase,
		Timeout:   30,
		BatchSize: 64,
		Retry:     RetryConfig{MaxRetries: 3, InitialDelay: 1000, MaxDelay: 30000},
	}
}

// SeedDefaults merges the D2 canonical models and the ollama provider into
// settings, in place. It never overwrites an entry the caller already has
// (AC-6): a model or provider key that already exists — user-defined or
// previously seeded — is left exactly as it is. It never adds an `api`
// provider entry. Calling it repeatedly on the same settings is a no-op after
// the first call (NFR-3). Returns whether anything changed, so callers that
// only want to persist on an actual change can check it.
func SeedDefaults(settings *EmbeddingSettings) bool {
	if settings == nil {
		return false
	}
	changed := false

	if settings.Providers == nil {
		settings.Providers = make(map[string]EmbeddingProvider)
	}
	if settings.Models == nil {
		settings.Models = make(map[string]EmbeddingModel)
	}

	if _, exists := settings.Providers[OllamaProviderID]; !exists {
		settings.Providers[OllamaProviderID] = defaultOllamaProvider()
		changed = true
	}

	for _, def := range D2Models {
		if _, exists := settings.Models[def.ID]; exists {
			continue
		}
		settings.Models[def.ID] = def.Model
		changed = true
	}

	// DefaultEmbeddingModel is deliberately NOT written here. The spec's
	// Technical Notes place it out of scope: the field exists but no code
	// reads it to select a model, and turning it into the per-machine model
	// override is named as the follow-up. Stamping every machine with the D2
	// default now would leave that follow-up unable to tell a user's own
	// choice apart from a value seeding wrote for them.

	return changed
}
