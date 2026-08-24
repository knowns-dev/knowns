package doctor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"sync"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/readiness"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
)

type localDependencies struct {
	readiness       func(*storage.Store) (readiness.Payload, error)
	services        func(*storage.Store) ([]services.ServiceStatus, error)
	embedding       func(*storage.Store) ([]services.ServiceStatus, error)
	lspStatuses     func(context.Context, *storage.Store) ([]lsp.LanguageRuntimeStatus, error)
	lspIDs          []string
	runtimeHooks    func() ([]runtimeinstall.Status, error)
	skillsOutOfSync func(string) bool
	globalSkills    func() []string
	exists          func(string) bool
	lookPath        func(string) (string, error)
	onnxAvailable   func() (bool, string)
	onnxCapability  func() search.LocalONNXCapability
	localONNXModel  func(*models.SemanticSearchSettings) localONNXModelStatus
	readFile        func(string) ([]byte, error)
	qdrant          func(context.Context, *storage.Store) (qdrantDiagnosticSnapshot, error)
}

func defaultLocalDependencies() localDependencies {
	return localDependencies{
		readiness: func(store *storage.Store) (readiness.Payload, error) {
			if store == nil {
				return readiness.InactivePayload(), nil
			}
			return readiness.BuildReadiness(store, readiness.Options{
				LSP: []lsp.LanguageRuntimeStatus{},
			}), nil
		},
		services: func(store *storage.Store) ([]services.ServiceStatus, error) {
			return services.DetectAllReadOnly(store), nil
		},
		// The embedding status is answered on its own so search.model never
		// waits on the LSP inventory inside the full service snapshot.
		embedding: func(store *storage.Store) ([]services.ServiceStatus, error) {
			return services.DetectEmbeddingReadOnly(store), nil
		},
		lspStatuses: collectLocalLSPStatuses,
		lspIDs:      localLSPIDs(),
		runtimeHooks: func() ([]runtimeinstall.Status, error) {
			return runtimeinstall.StatusAll(runtimeinstall.DefaultOptions())
		},
		skillsOutOfSync: codegen.SkillsOutOfSync,
		globalSkills:    codegen.GlobalStaleSkillDirs,
		exists: func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		},
		lookPath:       exec.LookPath,
		onnxAvailable:  search.IsONNXAvailable,
		onnxCapability: search.CurrentLocalONNXCapability,
		localONNXModel: inspectLocalONNXModel,
		readFile:       os.ReadFile,
		qdrant:         inspectQdrantReadOnly,
	}
}

type localState struct {
	store *storage.Store
	deps  localDependencies

	configOnce sync.Once
	config     *models.Project
	configErr  error

	readinessOnce sync.Once
	readiness     readiness.Payload
	readinessErr  error

	servicesOnce sync.Once
	services     []services.ServiceStatus
	servicesErr  error

	embeddingOnce sync.Once
	embedding     []services.ServiceStatus
	embeddingErr  error

	runtimeHooksOnce sync.Once
	runtimeHooks     []runtimeinstall.Status
	runtimeHooksErr  error

	qdrantOnce sync.Once
	qdrant     qdrantDiagnosticSnapshot
	qdrantErr  error

	virtualExists bool
}

func (s *localState) qdrantSnapshot(ctx context.Context) (qdrantDiagnosticSnapshot, error) {
	s.qdrantOnce.Do(func() {
		s.qdrant, s.qdrantErr = s.deps.qdrant(ctx, s.store)
	})
	return s.qdrant, s.qdrantErr
}

func newLocalState(store *storage.Store, deps localDependencies) *localState {
	defaults := defaultLocalDependencies()
	virtualExists := deps.exists != nil && deps.readFile == nil
	if deps.readiness == nil {
		deps.readiness = defaults.readiness
	}
	// A caller that stubs the full service snapshot expects embedding-only
	// consumers to observe that stub, so bind embedding to it before services
	// is defaulted. Otherwise embedding uses its own cheap detector rather than
	// paying for the full snapshot's LSP probe.
	if deps.embedding == nil {
		if deps.services != nil {
			deps.embedding = deps.services
		} else {
			deps.embedding = defaults.embedding
		}
	}
	if deps.services == nil {
		deps.services = defaults.services
	}
	if deps.lspStatuses == nil {
		deps.lspStatuses = defaults.lspStatuses
	}
	if len(deps.lspIDs) == 0 {
		deps.lspIDs = append([]string(nil), defaults.lspIDs...)
	}
	if deps.runtimeHooks == nil {
		deps.runtimeHooks = defaults.runtimeHooks
	}
	if deps.skillsOutOfSync == nil {
		deps.skillsOutOfSync = defaults.skillsOutOfSync
	}
	if deps.globalSkills == nil {
		deps.globalSkills = defaults.globalSkills
	}
	if deps.exists == nil {
		deps.exists = defaults.exists
	}
	if deps.lookPath == nil {
		deps.lookPath = defaults.lookPath
	}
	if deps.onnxAvailable == nil {
		deps.onnxAvailable = defaults.onnxAvailable
	}
	if deps.onnxCapability == nil {
		deps.onnxCapability = defaults.onnxCapability
	}
	if deps.localONNXModel == nil {
		deps.localONNXModel = defaults.localONNXModel
	}
	if deps.readFile == nil {
		deps.readFile = defaults.readFile
	}
	if deps.qdrant == nil {
		deps.qdrant = defaults.qdrant
	}
	return &localState{store: store, deps: deps, virtualExists: virtualExists}
}

func (s *localState) projectConfig() (*models.Project, error) {
	s.configOnce.Do(func() {
		if s.store == nil {
			s.configErr = fmt.Errorf("project store unavailable")
			return
		}
		s.config, s.configErr = s.store.Config.Load()
	})
	return s.config, s.configErr
}

func (s *localState) readinessSnapshot() (readiness.Payload, error) {
	s.readinessOnce.Do(func() {
		s.readiness, s.readinessErr = s.deps.readiness(s.store)
	})
	return s.readiness, s.readinessErr
}

func (s *localState) serviceSnapshot() ([]services.ServiceStatus, error) {
	s.servicesOnce.Do(func() {
		s.services, s.servicesErr = s.deps.services(s.store)
	})
	return s.services, s.servicesErr
}

// embeddingSnapshot answers embedding-only questions without paying for the
// full service snapshot, whose LSP probe can take tens of seconds and pushed
// the search.model check past its timeout budget.
func (s *localState) embeddingSnapshot() ([]services.ServiceStatus, error) {
	s.embeddingOnce.Do(func() {
		s.embedding, s.embeddingErr = s.deps.embedding(s.store)
	})
	return s.embedding, s.embeddingErr
}

func (s *localState) runtimeHookSnapshot() ([]runtimeinstall.Status, error) {
	s.runtimeHooksOnce.Do(func() {
		s.runtimeHooks, s.runtimeHooksErr = s.deps.runtimeHooks()
	})
	return s.runtimeHooks, s.runtimeHooksErr
}

func LocalCheckers(store *storage.Store) []Checker {
	return localCheckersWithDependencies(store, localDependencies{})
}

func localCheckersWithDependencies(store *storage.Store, deps localDependencies) []Checker {
	state := newLocalState(store, deps)
	project := &projectSnapshot{state: state}
	service := &serviceSnapshot{state: state}
	languageStatuses := &lspSnapshot{
		store: store,
		load:  state.deps.lspStatuses,
	}
	checkers := make([]Checker, 0, 10+len(state.deps.lspIDs))
	checkers = append(checkers, searchCheckers(state)...)
	checkers = append(checkers, runtimeCheckers(store, service)...)
	checkers = append(checkers, lspCheckers(store, project, languageStatuses, state.deps.lspIDs)...)
	checkers = append(checkers, aiCheckers(state)...)
	return checkers
}

type projectSnapshot struct {
	state *localState
}

func (s *projectSnapshot) get() (*models.Project, error) {
	return s.state.projectConfig()
}

type serviceSnapshot struct {
	state *localState
}

func (s *serviceSnapshot) get() ([]services.ServiceStatus, error) {
	return s.state.serviceSnapshot()
}

type lspSnapshot struct {
	once     sync.Once
	store    *storage.Store
	load     func(context.Context, *storage.Store) ([]lsp.LanguageRuntimeStatus, error)
	statuses []lsp.LanguageRuntimeStatus
	err      error
}

func (s *lspSnapshot) get(ctx context.Context) ([]lsp.LanguageRuntimeStatus, error) {
	s.once.Do(func() {
		s.statuses, s.err = s.load(ctx, s.store)
	})
	return s.statuses, s.err
}

func collectLocalLSPStatuses(ctx context.Context, store *storage.Store) ([]lsp.LanguageRuntimeStatus, error) {
	if store == nil {
		return nil, nil
	}
	project, err := store.Config.Load()
	if err != nil {
		return nil, err
	}
	var defaults *storage.ProjectDefaults
	if settings, loadErr := storage.NewEmbeddingSettingsStore().Load(); loadErr == nil {
		defaults = settings.ProjectDefaults
	}
	return lsp.CollectRuntimeStatuses(ctx, lsp.RuntimeStatusOptions{
		Root:     filepath.Dir(store.Root),
		Config:   lsp.ConfigFromProjectWithDefaults(project, defaults),
		Adapters: adapters.All(),
	}), nil
}

func localLSPIDs() []string {
	all := adapters.All()
	ids := make([]string, 0, len(all))
	for _, adapter := range all {
		ids = append(ids, adapter.ID())
	}
	sort.Strings(ids)
	return ids
}

func subsystemDisabled(summary, reason string) CheckResult {
	return CheckResult{
		Status:     StatusSkip,
		Summary:    summary,
		SkipReason: reason,
	}
}
