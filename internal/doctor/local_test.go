package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/qdrantruntime"
	"github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestSearchChecksReportUnavailableModelAndEmptyIndex(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{
		Enabled: true,
		Model:   "all-MiniLM-L6-v2",
	})
	before := snapshotTree(t, store.Root)

	deps := localDependencies{
		localONNXModel: func(*models.SemanticSearchSettings) localONNXModelStatus {
			return localONNXModelStatus{
				State:            localONNXModelMissing,
				MissingArtifacts: []string{"onnx_model"},
			}
		},
		readiness: func(*storage.Store) (readiness.Payload, error) {
			return readiness.Payload{
				Active: true,
				Knowledge: &readiness.KnowledgeStatus{
					Memories: readiness.MemoryCounts{},
				},
				Search: &readiness.SearchStatus{
					SemanticEnabled:   true,
					ModelConfigured:   true,
					ModelInstalled:    false,
					ProjectIndexReady: false,
					SemanticRuntime: &readiness.SemanticRuntimeReadiness{
						Enabled: true,
					},
				},
			}, nil
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	model := findCheck(t, result, "search.model")
	if model.Status != StatusWarn || model.Remediation == nil ||
		model.Remediation.Command != "knowns model download all-MiniLM-L6-v2" {
		t.Fatalf("model check = %#v", model)
	}
	index := findCheck(t, result, "search.project-index")
	if index.Status != StatusWarn || index.Remediation == nil ||
		index.Remediation.Command != "knowns search --reindex" {
		t.Fatalf("project index check = %#v", index)
	}
	if got := snapshotTree(t, store.Root); !sameSnapshot(before, got) {
		t.Fatalf("search checks mutated project storage")
	}
}

func TestSearchChecksReportStaleIndices(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{
		Enabled: true,
		Model:   "current-model",
	})

	deps := localDependencies{
		readiness: func(*storage.Store) (readiness.Payload, error) {
			return readiness.Payload{
				Knowledge: &readiness.KnowledgeStatus{
					Memories: readiness.MemoryCounts{Global: 1},
				},
				Search: &readiness.SearchStatus{
					SemanticEnabled:   true,
					ModelConfigured:   true,
					ModelInstalled:    true,
					ProjectIndexReady: true,
					ProjectIndexStale: true,
					ProjectIndexModel: "previous-model",
					GlobalIndexReady:  true,
					GlobalIndexStale:  true,
					GlobalIndexModel:  "previous-model",
					SemanticRuntime:   &readiness.SemanticRuntimeReadiness{Enabled: true},
				},
			}, nil
		},
		services: func(*storage.Store) ([]services.ServiceStatus, error) {
			return []services.ServiceStatus{{
				Type:   "embedding",
				Status: "running",
			}}, nil
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	for _, id := range []string{"search.project-index", "search.global-index"} {
		check := findCheck(t, result, id)
		if check.Status != StatusWarn || check.Evidence["stale"] != true ||
			check.Remediation == nil || check.Remediation.Command != "knowns search --reindex" {
			t.Fatalf("%s check = %#v", id, check)
		}
	}
}

func TestSearchChecksSkipWhenSemanticSearchDisabled(t *testing.T) {
	store := newDoctorStore(t)
	deps := localDependencies{
		readiness: func(*storage.Store) (readiness.Payload, error) {
			return readiness.Payload{}, errors.New("readiness should not run")
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Verdict != VerdictHealthy || result.Summary.Skip != 10 {
		t.Fatalf("disabled search result = %#v", result)
	}
}

func TestSearchChecksReportMissingConfiguredOllama(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{
		Enabled:  true,
		Model:    "nomic-embed-text",
		Provider: "ollama",
	})
	deps := localDependencies{
		lookPath: func(string) (string, error) {
			return "", errors.New("executable not found")
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	model := findCheck(t, result, "search.model")
	if model.Status != StatusWarn ||
		model.Summary != "Ollama is configured but is not installed" ||
		model.Evidence["provider"] != "ollama" ||
		model.Evidence["installed"] != false ||
		model.Evidence["errorCode"] != "provider_binary_missing" ||
		model.Remediation == nil ||
		model.Remediation.Description != "Install Ollama and ensure the ollama executable is available on PATH." {
		t.Fatalf("model check = %#v", model)
	}
}

func TestSearchChecksReportLocalONNXDependencyStates(t *testing.T) {
	store := newDoctorStore(t)
	settings := &models.SemanticSearchSettings{
		Enabled:       true,
		Model:         "gte-small",
		Provider:      "local",
		HuggingFaceID: "Xenova/gte-small",
	}
	configureSemanticSearch(t, store, settings)

	t.Run("runtime missing", func(t *testing.T) {
		state := newLocalState(store, localDependencies{
			onnxAvailable: func() (bool, string) {
				return false, ""
			},
		})
		result, err := searchONNXRuntimeChecker(state).Check(context.Background())
		if err != nil {
			t.Fatalf("Check() error = %v", err)
		}
		if result.Status != StatusWarn ||
			result.Summary != "ONNX Runtime is unavailable or incompatible" ||
			result.Evidence["errorCode"] != "onnx_runtime_unavailable" ||
			result.Remediation == nil {
			t.Fatalf("runtime check = %#v", result)
		}
	})

	for _, test := range []struct {
		name        string
		modelStatus localONNXModelStatus
		summary     string
		command     string
	}{
		{
			name: "model missing",
			modelStatus: localONNXModelStatus{
				State:            localONNXModelMissing,
				MissingArtifacts: []string{"onnx_model"},
			},
			summary: "Configured ONNX model is not downloaded",
			command: "knowns model download gte-small",
		},
		{
			name: "model incomplete",
			modelStatus: localONNXModelStatus{
				State:            localONNXModelIncomplete,
				MissingArtifacts: []string{"config.json", "tokenizer.json"},
			},
			summary: "Configured ONNX model download is incomplete",
			command: "knowns model download gte-small --force",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := newLocalState(store, localDependencies{
				localONNXModel: func(*models.SemanticSearchSettings) localONNXModelStatus {
					return test.modelStatus
				},
			})
			result, err := searchModelChecker(state).Check(context.Background())
			if err != nil {
				t.Fatalf("Check() error = %v", err)
			}
			if result.Status != StatusWarn ||
				result.Summary != test.summary ||
				result.Remediation == nil ||
				result.Remediation.Command != test.command {
				t.Fatalf("model check = %#v", result)
			}
		})
	}
}

func TestSearchChecksExplainUnsupportedMacOSIntelONNX(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{
		Enabled:  true,
		Model:    "gte-small",
		Provider: "local",
	})
	state := newLocalState(store, localDependencies{
		onnxCapability: func() search.LocalONNXCapability {
			return search.LocalONNXCapabilityForPlatform("darwin", "amd64", "")
		},
	})

	configResult, err := searchConfigChecker(state).Check(context.Background())
	if err != nil {
		t.Fatalf("config Check() error = %v", err)
	}
	if configResult.Status != StatusWarn ||
		configResult.Evidence["errorCode"] != "onnx_platform_unsupported" ||
		configResult.Remediation == nil ||
		configResult.Remediation.Command != "knowns settings" {
		t.Fatalf("config check = %#v", configResult)
	}

	for _, checker := range []Checker{
		searchModelChecker(state),
		searchONNXRuntimeChecker(state),
		searchProjectIndexChecker(state),
		searchGlobalIndexChecker(state),
		searchSemanticRuntimeChecker(state),
	} {
		result, err := checker.Check(context.Background())
		if err != nil {
			t.Fatalf("%s Check() error = %v", checker.ID, err)
		}
		if result.Status != StatusSkip || result.SkipReason != "platform_unsupported" {
			t.Fatalf("%s check = %#v", checker.ID, result)
		}
	}
}

func TestInspectLocalONNXModelDetectsMissingIncompleteAndAvailable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	settings := &models.SemanticSearchSettings{
		Model:         "gte-small",
		HuggingFaceID: "Xenova/gte-small",
	}
	modelDir := filepath.Join(home, ".knowns", "models", "Xenova", "gte-small")

	status := inspectLocalONNXModel(settings)
	if status.State != localONNXModelMissing {
		t.Fatalf("missing status = %#v", status)
	}

	if err := os.MkdirAll(filepath.Join(modelDir, "onnx"), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(modelDir, "onnx", "model_quantized.onnx"), []byte("model"), 0o644); err != nil {
		t.Fatalf("WriteFile(model) error = %v", err)
	}
	status = inspectLocalONNXModel(settings)
	if status.State != localONNXModelIncomplete {
		t.Fatalf("incomplete status = %#v", status)
	}

	for _, name := range []string{"config.json", "tokenizer.json"} {
		if err := os.WriteFile(filepath.Join(modelDir, name), []byte("{}"), 0o644); err != nil {
			t.Fatalf("WriteFile(%s) error = %v", name, err)
		}
	}
	status = inspectLocalONNXModel(settings)
	if status.State != localONNXModelAvailable {
		t.Fatalf("available status = %#v", status)
	}
}

func TestLSPChecksReportMissingAndDisabledLanguages(t *testing.T) {
	store := newDoctorStore(t)
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	disabled := false
	cfg.Settings.LSP = &models.LSPSettings{
		Languages: map[string]models.LSPLanguageSettings{
			"go":     {},
			"python": {Enabled: &disabled},
		},
	}
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	deps := localDependencies{
		lspIDs: []string{"go", "java", "python"},
		lspStatuses: func(context.Context, *storage.Store) ([]lsp.LanguageRuntimeStatus, error) {
			return []lsp.LanguageRuntimeStatus{
				{
					ID:             "go",
					Name:           "Go",
					Enabled:        true,
					Detected:       true,
					InstallState:   lsp.RuntimeInstallNotInstalled,
					RunningState:   lsp.RuntimeRunningStopped,
					ReadinessState: lsp.RuntimeReadinessNotApplicable,
					InstallCmd:     "knowns lsp install go",
				},
				{
					ID:             "java",
					Name:           "Java",
					Enabled:        true,
					Detected:       false,
					InstallState:   lsp.RuntimeInstallNotInstalled,
					RunningState:   lsp.RuntimeRunningStopped,
					ReadinessState: lsp.RuntimeReadinessNotApplicable,
					InstallCmd:     "knowns lsp install java",
				},
				{
					ID:             "python",
					Name:           "Python",
					Enabled:        false,
					Detected:       true,
					InstallState:   lsp.RuntimeInstallDisabled,
					RunningState:   lsp.RuntimeRunningDisabled,
					ReadinessState: lsp.RuntimeReadinessNotApplicable,
				},
			}, nil
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeLSP},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	goCheck := findCheck(t, result, "lsp.go")
	if goCheck.Status != StatusWarn || goCheck.Remediation == nil ||
		goCheck.Remediation.Command != "knowns lsp install go" {
		t.Fatalf("Go check = %#v", goCheck)
	}
	javaCheck := findCheck(t, result, "lsp.java")
	if javaCheck.Status != StatusSkip || javaCheck.SkipReason != "not_detected" {
		t.Fatalf("Java check = %#v", javaCheck)
	}
	pythonCheck := findCheck(t, result, "lsp.python")
	if pythonCheck.Status != StatusSkip || pythonCheck.SkipReason != "config_disabled" {
		t.Fatalf("Python check = %#v", pythonCheck)
	}
}

func TestManagedServiceProbeFailureDoesNotSuppressSearchChecks(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{
		Enabled: true,
		Model:   "all-MiniLM-L6-v2",
	})
	deps := localDependencies{
		readiness: func(*storage.Store) (readiness.Payload, error) {
			return readiness.Payload{
				Knowledge: &readiness.KnowledgeStatus{},
				Search: &readiness.SearchStatus{
					SemanticEnabled:   true,
					ModelConfigured:   true,
					ModelInstalled:    true,
					ProjectIndexReady: true,
					ProjectIndexModel: "all-MiniLM-L6-v2",
					SemanticRuntime:   &readiness.SemanticRuntimeReadiness{Enabled: true},
				},
			}, nil
		},
		services: func(*storage.Store) ([]services.ServiceStatus, error) {
			return nil, errors.New("provider token=secret")
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch, ScopeRuntime},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	runtimeCheck := findCheck(t, result, "runtime.managed-services")
	if runtimeCheck.Status != StatusFail || runtimeCheck.Evidence["errorCode"] != "checker_error" {
		t.Fatalf("runtime check = %#v", runtimeCheck)
	}
	if search := findCheck(t, result, "search.semantic"); search.Status != StatusPass {
		t.Fatalf("search check = %#v", search)
	}
}

func TestAIChecksReportArtifactDriftWithoutSyncing(t *testing.T) {
	store := newDoctorStore(t)
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	cfg.Settings.Platforms = []string{"codex"}
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	root := filepath.Dir(store.Root)
	existing := map[string]bool{
		filepath.Join(root, "AGENTS.md"):                  true,
		filepath.Join(root, ".agents", "skills"):          true,
		filepath.Join(root, ".agents", "skills", "extra"): true,
	}
	before := snapshotTree(t, store.Root)
	deps := localDependencies{
		skillsOutOfSync: func(string) bool { return true },
		exists:          func(path string) bool { return existing[path] },
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeAI},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if instructions := findCheck(t, result, "ai.instructions"); instructions.Status != StatusPass {
		t.Fatalf("instruction check = %#v", instructions)
	}
	skills := findCheck(t, result, "ai.skills")
	if skills.Status != StatusWarn || skills.Remediation == nil || skills.Remediation.Command != "knowns sync" {
		t.Fatalf("skills check = %#v", skills)
	}
	if got := snapshotTree(t, store.Root); !sameSnapshot(before, got) {
		t.Fatalf("AI checks mutated project storage")
	}
}

func TestAIRuntimeHookChecksReportConfiguredAndAvailableRuntimes(t *testing.T) {
	store := newDoctorStore(t)
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	cfg.Settings.Platforms = []string{"codex"}
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	before := snapshotTree(t, store.Root)
	statusCalls := 0
	deps := localDependencies{
		runtimeHooks: func() ([]runtimeinstall.Status, error) {
			statusCalls++
			return []runtimeinstall.Status{
				{
					Runtime:     "claude-code",
					DisplayName: "Claude Code",
					HookKind:    runtimeinstall.HookKindNative,
					Available:   true,
					State:       runtimeinstall.StateMissing,
					Summary:     "hook config missing",
				},
				{
					Runtime:     "codex",
					DisplayName: "Codex",
					HookKind:    runtimeinstall.HookKindNative,
					Available:   false,
					State:       runtimeinstall.StateDrifted,
					Summary:     "Codex hooks disabled in config",
				},
				{
					Runtime:     "kiro",
					DisplayName: "Kiro IDE",
					HookKind:    runtimeinstall.HookKindNative,
					State:       runtimeinstall.StateMissing,
					Summary:     "not installed",
				},
				{
					Runtime:     "opencode",
					DisplayName: "OpenCode",
					HookKind:    runtimeinstall.HookKindPlugin,
					Available:   true,
					Installed:   true,
					State:       runtimeinstall.StateInstalled,
					Summary:     "installed",
				},
			}, nil
		},
	}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeAI},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if statusCalls != 1 {
		t.Fatalf("runtime hook status collector calls = %d, want 1", statusCalls)
	}

	for _, test := range []struct {
		id         string
		status     Status
		command    string
		configured bool
		available  bool
	}{
		{
			id:        "ai.runtime-hook.claude-code",
			status:    StatusWarn,
			command:   "knowns runtime install claude-code",
			available: true,
		},
		{
			id:         "ai.runtime-hook.codex",
			status:     StatusWarn,
			command:    "knowns runtime install codex",
			configured: true,
		},
		{
			id:     "ai.runtime-hook.kiro",
			status: StatusSkip,
		},
		{
			id:        "ai.runtime-hook.opencode",
			status:    StatusPass,
			available: true,
		},
	} {
		check := findCheck(t, result, test.id)
		if check.Status != test.status ||
			check.Evidence["configured"] != test.configured ||
			check.Evidence["available"] != test.available {
			t.Fatalf("%s check = %#v", test.id, check)
		}
		if test.command != "" &&
			(check.Remediation == nil || check.Remediation.Command != test.command) {
			t.Fatalf("%s remediation = %#v", test.id, check.Remediation)
		}
	}
	if got := snapshotTree(t, store.Root); !sameSnapshot(before, got) {
		t.Fatalf("runtime hook checks mutated project storage")
	}
}

func TestDefaultLocalChecksDoNotMutateProject(t *testing.T) {
	store := newDoctorStore(t)
	before := snapshotTree(t, store.Root)
	_, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
	}, LocalCheckers(store))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if got := snapshotTree(t, store.Root); !sameSnapshot(before, got) {
		t.Fatalf("default local checks mutated project storage")
	}
}

func TestQdrantDoctorChecksReportReadOnlyReadinessStates(t *testing.T) {
	store := newDoctorStore(t)
	configureSemanticSearch(t, store, &models.SemanticSearchSettings{Enabled: true, Model: "current-model"})
	pointer := &search.QdrantPointer{
		Backend: "qdrant", CollectionName: "kn_active", ChunkVersion: search.ChunkVersion,
		Embedding: search.QdrantEmbeddingPointer{Model: "current-model", Dimensions: 384},
		Owner:     search.QdrantOwnerPointer{StoreRootFingerprint: search.StoreRootFingerprint(store.Root)}, ChunkCount: 4,
	}
	base := qdrantDiagnosticSnapshot{
		Resolution: models.SemanticVectorStoreResolution{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Mode: models.SemanticVectorStoreModeManaged},
		Runtime:    qdrantruntime.Status{State: qdrantruntime.StatusRunning, Installed: true}, Pointer: pointer,
		Readiness:  search.SemanticIndexReadiness{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Ready: true},
		Expected:   search.SemanticIndexIdentity{Model: "current-model", Dimensions: 384, ChunkVersion: search.ChunkVersion},
		Collection: search.QdrantCollectionInfo{Exists: true, Dimensions: 384, PointsCount: 4, Status: "green"}, Probed: true,
		Healthy: true,
	}
	for _, test := range []struct {
		name     string
		snapshot qdrantDiagnosticSnapshot
		id       string
		status   Status
		command  string
	}{
		{"missing binary", func() qdrantDiagnosticSnapshot {
			s := base
			s.Runtime = qdrantruntime.Status{State: qdrantruntime.StatusNotInstalled}
			return s
		}(), "search.qdrant-runtime", StatusWarn, "knowns qdrant install"},
		{"unhealthy process", func() qdrantDiagnosticSnapshot {
			s := base
			s.Runtime = qdrantruntime.Status{State: qdrantruntime.StatusStale, Installed: true}
			s.Probed = false
			return s
		}(), "search.qdrant-runtime", StatusWarn, "knowns qdrant start"},
		{"live unhealthy process", func() qdrantDiagnosticSnapshot {
			s := base
			s.Healthy = false
			s.Probed = false
			s.ProbeErrorCode = "qdrant_health_unavailable"
			return s
		}(), "search.qdrant-runtime", StatusWarn, "knowns qdrant start"},
		{"stale pointer", func() qdrantDiagnosticSnapshot {
			s := base
			s.Readiness = search.SemanticIndexReadiness{Enabled: true, Backend: models.SemanticVectorBackendQdrant, Stale: true}
			s.Expected.Model = "next-model"
			return s
		}(), "search.qdrant-pointer", StatusWarn, "knowns search index --wait"},
		{"collection dimensions", func() qdrantDiagnosticSnapshot { s := base; s.Collection.Dimensions = 768; return s }(), "search.qdrant-collection", StatusWarn, "knowns search index --wait"},
		{"collection inspection error with healthy runtime", func() qdrantDiagnosticSnapshot {
			s := base
			s.Probed = false
			s.ProbeErrorCode = "qdrant_collection_unavailable"
			return s
		}(), "search.qdrant-collection", StatusWarn, "knowns search index --wait"},
		{"orphan candidates", func() qdrantDiagnosticSnapshot { s := base; s.Orphans = []string{"kn_retired"}; return s }(), "search.qdrant-orphans", StatusWarn, "knowns qdrant cleanup"},
		{"external", func() qdrantDiagnosticSnapshot {
			s := base
			s.Resolution.Mode = models.SemanticVectorStoreModeExternal
			s.Resolution.ExternalURL = "https://user:embedded-secret@qdrant.example/collections?signature=signed-secret"
			return s
		}(), "search.qdrant-collection", StatusWarn, ""},
		{"disabled", qdrantDiagnosticSnapshot{Resolution: models.SemanticVectorStoreResolution{OptedOut: true, Backend: models.SemanticVectorBackendNone}}, "search.qdrant-runtime", StatusSkip, ""},
		{"sqlite not applicable", qdrantDiagnosticSnapshot{Resolution: models.SemanticVectorStoreResolution{Enabled: true, Backend: models.SemanticVectorBackendSQLite}}, "search.qdrant-runtime", StatusSkip, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := snapshotTree(t, store.Root)
			calls := 0
			deps := localDependencies{qdrant: func(context.Context, *storage.Store) (qdrantDiagnosticSnapshot, error) {
				calls++
				return test.snapshot, nil
			}}
			result, err := Run(context.Background(), RunOptions{Project: ProjectFromStore(store), Scopes: []Scope{ScopeSearch}}, localCheckersWithDependencies(store, deps))
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if calls != 1 {
				t.Fatalf("qdrant snapshot calls = %d, want 1", calls)
			}
			check := findCheck(t, result, test.id)
			if check.Status != test.status {
				t.Fatalf("%s check = %#v", test.id, check)
			}
			if test.command != "" && (check.Remediation == nil || check.Remediation.Command != test.command) {
				t.Fatalf("%s remediation = %#v", test.id, check.Remediation)
			}
			if test.name == "stale pointer" && (check.Evidence["errorCode"] != "qdrant_model_mismatch" || check.Evidence["expectedModel"] != "next-model" || check.Evidence["actualModel"] != "current-model") {
				t.Fatalf("pointer mismatch evidence = %#v", check.Evidence)
			}
			if test.name == "sqlite not applicable" && check.SkipReason != "not_applicable" {
				t.Fatalf("sqlite check = %#v", check)
			}
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"embedded-secret", "signed-secret", "Authorization", "KNOWNS_QDRANT_API_KEY"} {
				if strings.Contains(string(data), secret) {
					t.Fatalf("doctor output leaked %q: %s", secret, data)
				}
			}
			if got := snapshotTree(t, store.Root); !sameSnapshot(before, got) {
				t.Fatalf("doctor Qdrant checks mutated project storage")
			}
		})
	}
}

func TestQdrantOrphanCandidatesEnforceOwnershipCapAndDeterministicOrder(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	fingerprint := search.StoreRootFingerprint(root)
	active := &search.QdrantPointer{CollectionName: "kn_active", Owner: search.QdrantOwnerPointer{StoreRootFingerprint: fingerprint}}
	future := time.Now().UTC().Add(time.Hour)
	records := []search.QdrantGenerationRecord{
		{Generation: 3, CollectionName: "kn_z", Status: search.QdrantGenerationStatusInactive, Owner: search.QdrantOwnerPointer{StoreRootFingerprint: fingerprint}, RetiredAt: &future},
		{Generation: 3, CollectionName: "kn_a", Status: search.QdrantGenerationStatusInactive, Owner: search.QdrantOwnerPointer{StoreRootFingerprint: fingerprint}, RetiredAt: &future},
		{Generation: 2, CollectionName: "kn_old", Status: search.QdrantGenerationStatusInactive, Owner: search.QdrantOwnerPointer{StoreRootFingerprint: fingerprint}, RetiredAt: &future},
	}
	configuredTwo := models.SemanticVectorStoreResolution{Retention: models.SemanticVectorStoreRetentionSettings{PreviousGenerations: qdrantIntPtr(2)}}
	if got := qdrantOrphanCandidates(records, active, configuredTwo, fingerprint); !reflect.DeepEqual(got, []string{"kn_z", "kn_old"}) {
		t.Fatalf("orphan candidates with configured cap 2 = %#v, want [kn_z kn_old]", got)
	}
	if got := qdrantOrphanCandidates(records, active, configuredTwo, search.StoreRootFingerprint(root+"-copied")); got != nil {
		t.Fatalf("copied pointer/history produced cleanup candidates: %#v", got)
	}
}

func qdrantIntPtr(value int) *int { return &value }

func newDoctorStore(t *testing.T) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doctor-local-test"); err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	return store
}

func configureSemanticSearch(t *testing.T, store *storage.Store, settings *models.SemanticSearchSettings) {
	t.Helper()
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	cfg.Settings.SemanticSearch = settings
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
}

func sameSnapshot(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}
