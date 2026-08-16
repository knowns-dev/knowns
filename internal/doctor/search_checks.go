package doctor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/services"
)

type localONNXModelState string

const (
	localONNXModelAvailable  localONNXModelState = "available"
	localONNXModelMissing    localONNXModelState = "missing"
	localONNXModelIncomplete localONNXModelState = "incomplete"
	localONNXModelUnknown    localONNXModelState = "unknown"
)

type localONNXModelStatus struct {
	State            localONNXModelState
	MissingArtifacts []string
}

func searchCheckers(state *localState) []Checker {
	checkers := []Checker{
		searchConfigChecker(state),
		searchGlobalIndexChecker(state),
		searchModelChecker(state),
		searchONNXRuntimeChecker(state),
		searchProjectIndexChecker(state),
		searchSemanticRuntimeChecker(state),
	}
	return append(checkers, qdrantCheckers(state)...)
}

func semanticSettings(state *localState) (*models.SemanticSearchSettings, error) {
	project, err := state.projectConfig()
	if err != nil {
		return nil, err
	}
	return project.Settings.SemanticSearch, nil
}

func unsupportedLocalONNX(state *localState, settings *models.SemanticSearchSettings) (search.LocalONNXCapability, bool) {
	if settings == nil || providerName(settings.Provider) != "local" {
		return search.LocalONNXCapability{}, false
	}
	capability := state.deps.onnxCapability()
	return capability, !capability.Supported
}

func searchConfigChecker(state *localState) Checker {
	return Checker{
		ID:    "search.semantic",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("Semantic search is disabled", "config_disabled"), nil
			}
			provider := settings.Provider
			if provider == "" {
				provider = "local"
			}
			if capability, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Local ONNX is unavailable on macOS Intel",
					Evidence: Evidence{
						"provider":  provider,
						"available": false,
						"errorCode": "onnx_platform_unsupported",
					},
					Remediation: &Remediation{
						Description: capability.Reason,
						Command:     "knowns settings",
					},
				}, nil
			}
			if settings.Model == "" {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Semantic search is enabled without a configured model",
					Evidence: Evidence{
						"provider": provider,
					},
					Remediation: &Remediation{
						Description: "Choose an embedding model in Knowns settings.",
						Command:     "knowns settings",
					},
				}, nil
			}
			return CheckResult{
				Status:  StatusPass,
				Summary: "Semantic search configuration is valid",
				Evidence: Evidence{
					"provider": provider,
					"model":    settings.Model,
				},
			}, nil
		},
	}
}

func searchModelChecker(state *localState) Checker {
	return Checker{
		ID:    "search.model",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("Semantic model check is disabled", "config_disabled"), nil
			}
			if _, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return subsystemDisabled("Local ONNX model check is not applicable on macOS Intel", "platform_unsupported"), nil
			}
			if settings.Model == "" {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "No semantic model is configured",
					Remediation: &Remediation{
						Description: "Choose an embedding model in Knowns settings.",
						Command:     "knowns settings",
					},
				}, nil
			}
			provider := providerName(settings.Provider)
			if provider == "ollama" {
				if _, err := state.deps.lookPath("ollama"); err != nil {
					return CheckResult{
						Status:  StatusWarn,
						Summary: "Ollama is configured but is not installed",
						Evidence: Evidence{
							"model":     settings.Model,
							"provider":  provider,
							"installed": false,
							"errorCode": "provider_binary_missing",
						},
						Remediation: &Remediation{
							Description: "Install Ollama and ensure the ollama executable is available on PATH.",
						},
					}, nil
				}
			}
			if provider == "local" {
				modelStatus := state.deps.localONNXModel(settings)
				switch modelStatus.State {
				case localONNXModelMissing:
					return localONNXModelFinding(
						settings,
						modelStatus,
						"Configured ONNX model is not downloaded",
						"Download the configured ONNX embedding model.",
						"knowns model download "+settings.Model,
					), nil
				case localONNXModelIncomplete:
					return localONNXModelFinding(
						settings,
						modelStatus,
						"Configured ONNX model download is incomplete",
						"Re-download the configured ONNX embedding model to restore missing artifacts.",
						"knowns model download "+settings.Model+" --force",
					), nil
				}
			}

			payload, readinessErr := state.readinessSnapshot()
			if readinessErr == nil &&
				payload.Search != nil &&
				provider == "local" &&
				state.deps.localONNXModel(settings).State == localONNXModelUnknown &&
				!payload.Search.ModelInstalled {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Configured ONNX model availability could not be established",
					Evidence: Evidence{
						"model":     settings.Model,
						"provider":  provider,
						"available": false,
						"errorCode": "model_status_unknown",
					},
					Remediation: &Remediation{
						Description: "Review the local ONNX model configuration.",
						Command:     "knowns settings",
					},
				}, nil
			}

			statuses, err := state.serviceSnapshot()
			if err != nil {
				return CheckResult{}, err
			}
			embedding, ok := serviceByType(statuses, "embedding")
			if !ok {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Semantic model availability could not be established",
					Evidence: Evidence{
						"model":     settings.Model,
						"errorCode": "embedding_status_unavailable",
					},
					Remediation: &Remediation{
						Description: "Inspect semantic runtime and model status.",
						Command:     "knowns runtime status",
					},
				}, nil
			}

			if embedding.Status == "disabled" && embedding.Details["reason"] == "semantic runtime disabled" {
				return subsystemDisabled("Semantic runtime is explicitly disabled", "runtime_disabled"), nil
			}
			evidence := Evidence{
				"model":  settings.Model,
				"status": embedding.Status,
			}
			evidence["provider"] = provider

			if embedding.Details["model_available"] == "false" ||
				embedding.Details["reason"] == "local model not downloaded" {
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "Configured ONNX model is not downloaded",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Download the configured ONNX embedding model.",
						Command:     "knowns model download " + settings.Model,
					},
				}, nil
			}
			if embedding.Status == "error" {
				evidence["errorCode"] = "embedding_configuration_invalid"
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "Configured semantic model or provider is unavailable",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Review the embedding model and provider configuration.",
						Command:     "knowns settings",
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "Configured semantic model is available",
				Evidence: evidence,
			}, nil
		},
	}
}

func searchONNXRuntimeChecker(state *localState) Checker {
	return Checker{
		ID:    "search.onnx-runtime",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("ONNX Runtime check is disabled", "config_disabled"), nil
			}
			if providerName(settings.Provider) != "local" {
				return subsystemDisabled("ONNX Runtime is not used by the configured provider", "not_applicable"), nil
			}
			if _, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return subsystemDisabled("ONNX Runtime is not bundled for macOS Intel", "platform_unsupported"), nil
			}
			available, _ := state.deps.onnxAvailable()
			if !available {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "ONNX Runtime is unavailable or incompatible",
					Evidence: Evidence{
						"available": false,
						"errorCode": "onnx_runtime_unavailable",
					},
					Remediation: &Remediation{
						Description: "Reinstall Knowns using the original package manager so its ONNX Runtime library is restored.",
					},
				}, nil
			}
			return CheckResult{
				Status:  StatusPass,
				Summary: "ONNX Runtime is available",
				Evidence: Evidence{
					"available": true,
				},
			}, nil
		},
	}
}

func localONNXModelFinding(
	settings *models.SemanticSearchSettings,
	status localONNXModelStatus,
	summary string,
	description string,
	command string,
) CheckResult {
	evidence := Evidence{
		"model":         settings.Model,
		"provider":      "local",
		"available":     false,
		"artifactState": string(status.State),
	}
	if len(status.MissingArtifacts) > 0 {
		evidence["missingArtifacts"] = status.MissingArtifacts
	}
	return CheckResult{
		Status:   StatusWarn,
		Summary:  summary,
		Evidence: evidence,
		Remediation: &Remediation{
			Description: description,
			Command:     command,
		},
	}
}

func inspectLocalONNXModel(settings *models.SemanticSearchSettings) localONNXModelStatus {
	if settings == nil {
		return localONNXModelStatus{State: localONNXModelUnknown}
	}
	huggingFaceID := settings.HuggingFaceID
	if huggingFaceID == "" {
		if model, ok := search.EmbeddingModels[settings.Model]; ok {
			huggingFaceID = model.HuggingFaceID
		}
	}
	relativeModelPath := filepath.Clean(filepath.FromSlash(huggingFaceID))
	if relativeModelPath == "." ||
		filepath.IsAbs(relativeModelPath) ||
		relativeModelPath == ".." ||
		strings.HasPrefix(relativeModelPath, ".."+string(filepath.Separator)) {
		return localONNXModelStatus{State: localONNXModelUnknown}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return localONNXModelStatus{State: localONNXModelUnknown}
	}
	modelDir := filepath.Join(home, ".knowns", "models", relativeModelPath)

	modelExists := false
	modelUsable := false
	for _, name := range []string{
		filepath.Join(modelDir, "onnx", "model_quantized.onnx"),
		filepath.Join(modelDir, "onnx", "model.onnx"),
	} {
		exists, usable := localArtifactState(name)
		modelExists = modelExists || exists
		modelUsable = modelUsable || usable
	}
	if !modelExists {
		return localONNXModelStatus{
			State:            localONNXModelMissing,
			MissingArtifacts: []string{"onnx_model"},
		}
	}

	missing := make([]string, 0, 3)
	if !modelUsable {
		missing = append(missing, "onnx_model")
	}
	for _, artifact := range []struct {
		name string
		path string
	}{
		{name: "config.json", path: filepath.Join(modelDir, "config.json")},
		{name: "tokenizer.json", path: filepath.Join(modelDir, "tokenizer.json")},
	} {
		if _, usable := localArtifactState(artifact.path); !usable {
			missing = append(missing, artifact.name)
		}
	}
	if len(missing) > 0 {
		return localONNXModelStatus{
			State:            localONNXModelIncomplete,
			MissingArtifacts: missing,
		}
	}
	return localONNXModelStatus{State: localONNXModelAvailable}
}

func localArtifactState(path string) (exists bool, usable bool) {
	info, err := os.Stat(path)
	if err != nil {
		return false, false
	}
	return true, info.Mode().IsRegular() && info.Size() > 0
}

func providerName(provider string) string {
	if provider == "" {
		return "local"
	}
	return provider
}

func searchProjectIndexChecker(state *localState) Checker {
	return Checker{
		ID:    "search.project-index",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("Project semantic index is disabled", "config_disabled"), nil
			}
			if _, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return subsystemDisabled("Project semantic index is disabled because Local ONNX is unavailable", "platform_unsupported"), nil
			}
			payload, err := state.readinessSnapshot()
			if err != nil {
				return CheckResult{}, err
			}
			if payload.Search == nil {
				return CheckResult{}, fmt.Errorf("search readiness unavailable")
			}
			if payload.Search.ProjectIndexStale {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Project semantic index was built with a different model",
					Evidence: Evidence{
						"ready":      true,
						"indexModel": payload.Search.ProjectIndexModel,
						"model":      settings.Model,
						"stale":      true,
					},
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search --reindex",
					},
				}, nil
			}
			if !payload.Search.ProjectIndexReady {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Project semantic index is empty or unavailable",
					Evidence: Evidence{
						"ready": false,
					},
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search --reindex",
					},
				}, nil
			}
			evidence := Evidence{"ready": true}
			if payload.Search.LastReindex != nil {
				evidence["indexedAt"] = payload.Search.LastReindex.UTC().Format(time.RFC3339)
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "Project semantic index is ready",
				Evidence: evidence,
			}, nil
		},
	}
}

func searchGlobalIndexChecker(state *localState) Checker {
	return Checker{
		ID:    "search.global-index",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("Global semantic index is disabled", "config_disabled"), nil
			}
			if _, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return subsystemDisabled("Global semantic index is disabled because Local ONNX is unavailable", "platform_unsupported"), nil
			}
			payload, err := state.readinessSnapshot()
			if err != nil {
				return CheckResult{}, err
			}
			if payload.Search == nil {
				return CheckResult{}, fmt.Errorf("search readiness unavailable")
			}
			globalMemories := 0
			if payload.Knowledge != nil {
				globalMemories = payload.Knowledge.Memories.Global
			}
			if globalMemories == 0 {
				return subsystemDisabled("Global semantic index has no applicable memories", "not_applicable"), nil
			}
			if payload.Search.GlobalIndexStale {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Global semantic index was built with a different model",
					Evidence: Evidence{
						"ready":      true,
						"indexModel": payload.Search.GlobalIndexModel,
						"model":      settings.Model,
						"stale":      true,
					},
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search --reindex",
					},
				}, nil
			}
			if !payload.Search.GlobalIndexReady {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Global semantic index is empty or unavailable",
					Evidence: Evidence{
						"ready":          false,
						"globalMemories": globalMemories,
					},
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search --reindex",
					},
				}, nil
			}
			return CheckResult{
				Status:  StatusPass,
				Summary: "Global semantic index is ready",
				Evidence: Evidence{
					"ready":          true,
					"globalMemories": globalMemories,
				},
			}, nil
		},
	}
}

func searchSemanticRuntimeChecker(state *localState) Checker {
	return Checker{
		ID:    "search.semantic-runtime",
		Scope: ScopeSearch,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			settings, err := semanticSettings(state)
			if err != nil {
				return CheckResult{}, err
			}
			if settings == nil || !settings.Enabled {
				return subsystemDisabled("Semantic runtime is disabled", "config_disabled"), nil
			}
			if _, unsupported := unsupportedLocalONNX(state, settings); unsupported {
				return subsystemDisabled("Semantic runtime is disabled because Local ONNX is unavailable", "platform_unsupported"), nil
			}
			payload, err := state.readinessSnapshot()
			if err != nil {
				return CheckResult{}, err
			}
			if payload.Search == nil || payload.Search.SemanticRuntime == nil {
				return CheckResult{
					Status:  StatusWarn,
					Summary: "Semantic runtime status is unavailable",
					Evidence: Evidence{
						"errorCode": "semantic_runtime_status_unavailable",
					},
					Remediation: &Remediation{
						Description: "Inspect the shared semantic runtime.",
						Command:     "knowns runtime status",
					},
				}, nil
			}
			runtime := payload.Search.SemanticRuntime
			if !runtime.Enabled {
				return subsystemDisabled("Semantic runtime is explicitly disabled", "runtime_disabled"), nil
			}
			return CheckResult{
				Status:  StatusPass,
				Summary: "Semantic runtime is available",
				Evidence: Evidence{
					"enabled":        runtime.Enabled,
					"loaded":         runtime.Loaded,
					"entries":        runtime.Entries,
					"activeSessions": runtime.ActiveSessions,
					"consumers":      runtime.Consumers,
				},
			}, nil
		},
	}
}

func serviceByType(statuses []services.ServiceStatus, serviceType string) (services.ServiceStatus, bool) {
	for _, status := range statuses {
		if status.Type == serviceType {
			return status, true
		}
	}
	return services.ServiceStatus{}, false
}
