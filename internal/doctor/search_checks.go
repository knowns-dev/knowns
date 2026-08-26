package doctor

import (
	"context"
	"fmt"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
)

func searchCheckers(state *localState) []Checker {
	checkers := []Checker{
		searchConfigChecker(state),
		searchGlobalIndexChecker(state),
		searchModelChecker(state),
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
					// Remediation text is not restated here (AC-7): it resolves
					// from storage.OllamaStateGuidance, the single FR-9/D6
					// source setup, doctor, and init all read, so a wording
					// change there reaches this check without editing it.
					guidance := storage.OllamaStateGuidance(storage.OllamaNotInstalled, settings.Model)
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
							Description: guidance.Description,
							Command:     guidance.Command,
						},
					}, nil
				}
			}
			// Embedding-only: the full service snapshot also probes every LSP
			// adapter, which costs tens of seconds and made this check exceed
			// its timeout budget and report checker_timeout.
			statuses, err := state.embeddingSnapshot()
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
			// An Ollama model is only known to be registered here; whether it is
			// actually pulled and served is owned by search.provider-endpoint,
			// so this summary must not claim more than it verified.
			summary := "Configured semantic model is available"
			if provider == "ollama" {
				summary = "Configured semantic model is registered"
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  summary,
				Evidence: evidence,
			}, nil
		},
	}
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
			payload, err := state.readinessSnapshot()
			if err != nil {
				return CheckResult{}, err
			}
			if payload.Search == nil {
				return CheckResult{}, fmt.Errorf("search readiness unavailable")
			}
			if payload.Search.ProjectIndexStale {
				// Staleness has several causes (model, dimensions, chunk
				// version, or per-entity watermarks). Only claim a model
				// mismatch when the recorded model actually differs, and
				// surface the resolved reason so the summary matches evidence.
				summary := "Project semantic index is stale"
				indexModel := payload.Search.ProjectIndexModel
				if indexModel != "" && settings.Model != "" && indexModel != settings.Model {
					summary = "Project semantic index was built with a different model"
				}
				evidence := Evidence{
					"ready":      true,
					"indexModel": indexModel,
					"model":      settings.Model,
					"stale":      true,
				}
				if reason := payload.Search.SemanticDegradedReason; reason != "" {
					evidence["reason"] = reason
				}
				return CheckResult{
					Status:   StatusWarn,
					Summary:  summary,
					Evidence: evidence,
					// FR-7: after `knowns migrate` changes the embedding
					// identity, D5 stops at marking the index stale — it does
					// not reindex — so doctor must name the explicit reindex
					// command rather than imply one already ran.
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search index --wait",
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
				// Same reasoning as search.project-index: only claim a model
				// mismatch when the recorded model actually differs (a
				// dimension-only change, e.g. FR-7 after `knowns migrate`,
				// leaves the model name unchanged), and surface the resolved
				// reason so the summary matches evidence.
				summary := "Global semantic index is stale"
				indexModel := payload.Search.GlobalIndexModel
				if indexModel != "" && settings.Model != "" && indexModel != settings.Model {
					summary = "Global semantic index was built with a different model"
				}
				evidence := Evidence{
					"ready":      true,
					"indexModel": indexModel,
					"model":      settings.Model,
					"stale":      true,
				}
				if reason := payload.Search.SemanticDegradedReason; reason != "" {
					evidence["reason"] = reason
				}
				return CheckResult{
					Status:   StatusWarn,
					Summary:  summary,
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Rebuild the project and global semantic indices.",
						Command:     "knowns search index --wait",
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
