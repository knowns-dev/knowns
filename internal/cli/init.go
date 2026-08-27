package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/server"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

// instructionFile defines an agent instruction file to generate during init.
type instructionFile struct {
	Path       string
	Platform   string // display name passed to generateInstructionContent
	PlatformID string // matches allPlatformIDs entry
}

// gitTrackingSections is the option table for the git tracking multi-select.
var gitTrackingSections = []struct {
	label string
	id    string
}{
	{label: "Tasks", id: "tasks"},
	{label: "Docs", id: "docs"},
	{label: "Templates", id: "templates"},
	{label: "Decisions", id: "decisions"},
	{label: "Memories", id: "memories"},
}

// wizardMinWidth is the narrowest terminal the huh form still renders legibly.
// The floor is set by the widest option label (".github/copilot-instructions.md",
// 31 cells) plus huh's border, padding, cursor, and checkbox prefix (8 cells).
// huh itself resizes to any width via tea.WindowSizeMsg, so this is purely a
// readability guard.
const wizardMinWidth = 60

var defaultInstructionFiles = []instructionFile{
	{Path: "CLAUDE.md", Platform: "Claude Code", PlatformID: "claude-code"},
	{Path: "OPENCODE.md", Platform: "OpenCode", PlatformID: "opencode"},
	{Path: "GEMINI.md", Platform: "Gemini CLI", PlatformID: "gemini"},
	{Path: "AGENTS.md", Platform: "Generic AI", PlatformID: "agents"},
	{Path: filepath.Join(".github", "copilot-instructions.md"), Platform: "GitHub Copilot", PlatformID: "copilot"},
}

var initCmd = &cobra.Command{
	Use:   "init [name]",
	Short: "Initialize a new Knowns project",
	Long: `Initialize a new Knowns project in the current directory.
Creates a .knowns/ directory with the required structure and a default config.json.`,
	Args: cobra.MaximumNArgs(1),
	RunE: runInit,
}

// allPlatformIDs is the full ordered list of supported platform identifiers.
var allPlatformIDs = []string{"claude-code", "opencode", "codex", "kiro", "hermes", "antigravity", "cursor", "gemini", "copilot", "agents"}

// wizardPlatformIDs is the subset shown in the wizard multi-select.
var wizardPlatformIDs = []string{"claude-code", "opencode", "codex", "kiro", "hermes", "antigravity", "cursor", "gemini", "copilot", "agents"}

// platformLabel returns the human-readable label for a platform ID.
func platformLabel(id string) string {
	if label := platformLabelFromRuntime(id); label != "" {
		return label
	}
	switch id {
	case "gemini":
		return "Google Gemini  (GEMINI.md)"
	case "antigravity":
		return "Antigravity  (.agents/rules/knowns.md, ~/.gemini/antigravity/mcp_config.json)"
	case "hermes":
		return "Hermes Agent  (AGENTS.md, .agents/skills, ~/.hermes/config.yaml)"
	case "cursor":
		return "Cursor  (.cursor/mcp.json)"
	case "copilot":
		return "GitHub Copilot  (.github/copilot-instructions.md)"
	case "agents":
		return "Generic Agents  (AGENTS.md, .agents/skills/)"
	default:
		return id
	}
}

func platformLabelFromRuntime(id string) string {
	switch id {
	case "claude-code", "codex", "opencode", "kiro":
		return compactRuntimePickerLabel(id, runtimeinstall.DefaultOptions())
	default:
		return ""
	}
}

func compactRuntimePickerLabel(id string, opts runtimeinstall.Options) string {
	status := runtimeinstall.RuntimeAvailabilitySummary(id, opts)
	specLabel := map[string]string{
		"claude-code": "Claude Code (CLAUDE.md, SKILL, hooks, ...)",
		"codex":       "Codex (.codex/config.toml, SKILL, hooks, ...)",
		"opencode":    "OpenCode (OPENCODE.md, SKILL, plugin, MCP, ...)",
		"kiro":        "Kiro IDE (.kiro/steering, SKILL, hooks, ...)",
	}[id]
	if specLabel == "" {
		return id
	}
	return fmt.Sprintf("%s %s", runtimeStatusDot(status), specLabel)
}

func runtimeStatusDot(status string) string {
	switch status {
	case "installed":
		return StyleSuccess.Render("●")
	case "available":
		return StyleWarning.Render("●")
	default:
		return StyleError.Render("●")
	}
}

// hasPlatform returns true if id is in platforms, or platforms is empty (= all enabled).
func hasPlatform(platforms []string, id string) bool {
	if len(platforms) == 0 {
		return true
	}
	for _, p := range platforms {
		if p == id {
			return true
		}
	}
	return false
}

func hasExplicitPlatform(platforms []string, id string) bool {
	for _, p := range platforms {
		if p == id {
			return true
		}
	}
	return false
}

func shouldCreateInstructionFile(platforms []string, f instructionFile) bool {
	if len(platforms) == 0 {
		return true
	}
	if f.PlatformID == "agents" && (hasExplicitPlatform(platforms, "codex") || hasExplicitPlatform(platforms, "hermes")) {
		return true
	}
	return hasExplicitPlatform(platforms, f.PlatformID)
}

func defaultInstructionPlatforms() []string {
	return []string{"claude-code", "agents"}
}

func instructionPlatformOptions(selected []string) []huh.Option[string] {
	selectedSet := make(map[string]bool, len(selected))
	for _, id := range selected {
		if id == "codex" || id == "hermes" {
			id = "agents"
		}
		selectedSet[id] = true
	}
	options := []struct {
		label string
		id    string
	}{
		{label: "CLAUDE.md  (Claude Code)", id: "claude-code"},
		{label: "AGENTS.md  (Codex / generic agents)", id: "agents"},
		{label: "OPENCODE.md  (OpenCode)", id: "opencode"},
		{label: "GEMINI.md  (Gemini CLI)", id: "gemini"},
		{label: ".github/copilot-instructions.md", id: "copilot"},
	}
	result := make([]huh.Option[string], len(options))
	for i, opt := range options {
		result[i] = huh.NewOption(opt.label, opt.id).Selected(selectedSet[opt.id])
	}
	return result
}

func normalizeInstructionPlatforms(platforms []string) []string {
	if len(platforms) == 0 {
		return defaultInstructionPlatforms()
	}
	seen := make(map[string]bool, len(platforms))
	normalized := make([]string, 0, len(platforms))
	for _, id := range platforms {
		if id == "codex" {
			id = "agents"
		}
		switch id {
		case "claude-code", "agents", "opencode", "gemini", "copilot":
		default:
			continue
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		normalized = append(normalized, id)
	}
	if len(normalized) == 0 {
		return defaultInstructionPlatforms()
	}
	return normalized
}

// initConfig holds all wizard answers.
type initConfig struct {
	Name            string
	TaskIDPrefix    string
	GitTrackingMode string
	GitTracking     models.GitTracking
	EnableSemantic  bool
	SemanticModel   string
	EmbeddingSource string // "ollama" or "api"
	Platforms       []string
	TaskLifecycle   *models.TaskLifecycleSettings
	// SemanticGuidance is the FR-10/FR-11 guidance (D6, resolved from
	// storage.OllamaStateGuidance) shown when the run finishes with semantic
	// search disabled. It is populated on both the wizard path (from the
	// actual detected state, D7) and the non-interactive path (from a fixed,
	// unprobed state, D8) — see runInit and runWizard.
	SemanticGuidance storage.OllamaGuidance
}

// Aliases for centralized styles (see styles.go)
var (
	titleStyle   = StyleTitle
	successStyle = StyleSuccess
	warnStyle    = StyleWarning
	dimStyle     = StyleDim
)

func runInit(cmd *cobra.Command, args []string) error {
	gitTracked, _ := cmd.Flags().GetBool("git-tracked")
	gitIgnored, _ := cmd.Flags().GetBool("git-ignored")
	force, _ := cmd.Flags().GetBool("force")
	_, _ = cmd.Flags().GetBool("wizard")
	noWizard, _ := cmd.Flags().GetBool("no-wizard")
	openFlag, _ := cmd.Flags().GetBool("open")
	noOpen, _ := cmd.Flags().GetBool("no-open")
	taskIDPrefixFlag, _ := cmd.Flags().GetString("task-prefix")
	taskIDPrefixFlag, err := models.NormalizeTaskIDPrefix(taskIDPrefixFlag)
	if err != nil {
		return err
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("cannot determine working directory: %w", err)
	}

	root := filepath.Join(cwd, ".knowns")
	hasGitRepo := isGitRepo(cwd)
	gitAvailable := isGitAvailable()

	// Check if already initialized
	if _, err := os.Stat(root); err == nil {
		if !force {
			// Allow changing git tracking mode without --force
			if gitTracked || gitIgnored {
				mode := "git-tracked"
				if gitIgnored {
					mode = "git-ignored"
				}
				store := storage.NewStore(root)
				project, err := store.Config.Load()
				if err != nil {
					return err
				}
				project.Settings.GitTrackingMode = mode
				gtDefaults := models.GitTrackingDefaults()
				project.Settings.GitTracking = &gtDefaults
				if err := store.Config.Save(project); err != nil {
					return err
				}
				if err := writeKnownsGitignore(cwd, mode, nil); err != nil {
					return err
				}
				fmt.Printf("✓ Git tracking mode updated to %q\n", mode)
				return nil
			}
			fmt.Println(warnStyle.Render("Project already initialized (.knowns/ directory exists)."))
			fmt.Println(dimStyle.Render("  Use --force to reinitialize."))
			fmt.Println(dimStyle.Render("  Use --git-tracked or --git-ignored to change tracking mode."))
			return nil
		}
		fmt.Println(warnStyle.Render("Reinitializing existing project (--force)"))
		fmt.Println()
	}

	// Check git availability / repository status.
	if !hasGitRepo {
		if gitAvailable {
			fmt.Println(dimStyle.Render("No git repository found — Knowns will run git init after setup."))
			fmt.Println()
		} else {
			fmt.Println(warnStyle.Render("Warning: No git repository found and git is not available in PATH."))
			fmt.Println(dimStyle.Render("  Install git to enable repository setup and git-aware tracking."))
			fmt.Println()
		}
	}

	var cfg initConfig
	globalDefaults, err := loadGlobalProjectDefaults()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to load global settings: %v\n", err)
	}
	taskLifecycleSeed := lifecycleSeedForInit(root, force, globalDefaults)

	// Determine if interactive mode
	interactive := !noWizard
	if interactive && isTTYFn() && terminalWidthFn() < wizardMinWidth {
		fmt.Println(warnStyle.Render("Terminal is too small for the interactive setup wizard."))
		fmt.Println()
		fmt.Println(RenderField("Minimum width", fmt.Sprintf("%d columns", wizardMinWidth)))
		fmt.Println(RenderField("Current width", fmt.Sprintf("%d columns", terminalWidthFn())))
		fmt.Println()
		fmt.Println(dimStyle.Render("  Resize the terminal and rerun: knowns init"))
		fmt.Println(dimStyle.Render("  Or run explicitly without the wizard: knowns init --no-wizard"))
		fmt.Println(dimStyle.Render("  Or pass explicit flags such as: knowns init --no-wizard --git-tracked"))
		fmt.Println()
		return nil
	}

	if interactive && len(args) == 0 {
		// Load any existing config to pre-populate wizard defaults.
		existingName, existingTaskIDPrefix, existingGitTrackingMode, existingGitTracking, existingSemanticEnabled, existingSemanticModel, existingPlatforms := defaultsForWizard(cwd, globalDefaults)
		existingProject, _ := storage.NewStore(root).Config.Load()
		existingEmbeddingSource := resolveWizardEmbeddingSource(globalDefaults, existingProject)
		if existingCfg := existingProject; existingCfg != nil {
			existingName = existingCfg.Name
			existingTaskIDPrefix = existingCfg.Settings.DefaultTaskIDPrefix
			existingGitTrackingMode = existingCfg.Settings.GitTrackingMode
			if existingCfg.Settings.GitTracking != nil {
				existingGitTracking = existingCfg.Settings.GitTracking
			}
			if existingCfg.Settings.SemanticSearch != nil {
				enabled := existingCfg.Settings.SemanticSearch.Enabled
				existingSemanticEnabled = &enabled
				existingSemanticModel = existingCfg.Settings.SemanticSearch.Model
			}
			if len(existingCfg.Settings.Platforms) > 0 {
				existingPlatforms = existingCfg.Settings.Platforms
			}
		}

		// Run full wizard with huh
		wizardCfg, err := runWizard(cwd, gitTracked, gitIgnored, gitAvailable, existingName, existingTaskIDPrefix, existingGitTrackingMode, existingGitTracking, existingSemanticEnabled, existingSemanticModel, existingPlatforms)
		if err != nil {
			if err == huh.ErrUserAborted {
				fmt.Println(warnStyle.Render("Setup cancelled."))
				return nil
			}
			return err
		}
		cfg = *wizardCfg
		if cfg.EmbeddingSource == "" {
			cfg.EmbeddingSource = existingEmbeddingSource
		}
	} else {
		// Non-interactive or name provided
		name := filepath.Base(cwd)
		if globalDefaults != nil && globalDefaults.ProjectName != "" {
			name = globalDefaults.ProjectName
		}
		if len(args) > 0 {
			name = args[0]
		}
		taskIDPrefix := ""
		if globalDefaults != nil {
			taskIDPrefix = globalDefaults.Settings.DefaultTaskIDPrefix
		}
		gitMode := "git-tracked"
		gitTracking := models.GitTrackingDefaults()
		// D7/D8/NFR-4: a non-interactive run never probes Ollama and never
		// widens the configuration from machine state, so the committed file
		// is identical whether or not Ollama happens to be reachable here
		// (AC-21). The safe default now that no embedder ships inside the
		// binary is off (D7) — the previous `isTTY()` default assumed an
		// in-process embedder that no longer exists, and additionally made
		// the answer depend on terminal attachment rather than the user's
		// stated intent. An explicit prior answer (global defaults below, or
		// an existing project config on --force) still wins: that is the
		// user's answer, not the probe.
		enableSemantic := false
		semanticModel := storage.D2DefaultModelID
		embeddingSource := "ollama"
		platforms := defaultInstructionPlatforms()
		if globalDefaults != nil {
			if globalDefaults.Settings.GitTrackingMode != "" {
				gitMode = globalDefaults.Settings.GitTrackingMode
			}
			if globalDefaults.Settings.GitTracking != nil {
				gitTracking = *globalDefaults.Settings.GitTracking
			}
			if globalDefaults.Settings.SemanticSearch != nil {
				enableSemantic = globalDefaults.Settings.SemanticSearch.Enabled
				semanticModel = globalDefaults.Settings.SemanticSearch.Model
				if globalDefaults.Settings.SemanticSearch.Provider != "" {
					embeddingSource = globalDefaults.Settings.SemanticSearch.Provider
				}
			}
			if len(globalDefaults.Settings.Platforms) > 0 {
				platforms = globalDefaults.Settings.Platforms
			}
		}
		if force {
			if existingCfg, err := storage.NewStore(root).Config.Load(); err == nil {
				if existingCfg.Name != "" && len(args) == 0 {
					name = existingCfg.Name
				}
				if existingCfg.Settings.DefaultTaskIDPrefix != "" {
					taskIDPrefix = existingCfg.Settings.DefaultTaskIDPrefix
				}
				if existingCfg.Settings.GitTrackingMode != "" {
					gitMode = existingCfg.Settings.GitTrackingMode
				}
				if existingCfg.Settings.GitTracking != nil {
					gitTracking = *existingCfg.Settings.GitTracking
				}
				if existingCfg.Settings.SemanticSearch != nil {
					enableSemantic = existingCfg.Settings.SemanticSearch.Enabled
					semanticModel = existingCfg.Settings.SemanticSearch.Model
					if existingCfg.Settings.SemanticSearch.Provider != "" {
						embeddingSource = existingCfg.Settings.SemanticSearch.Provider
					}
				}
				if len(existingCfg.Settings.Platforms) > 0 {
					platforms = existingCfg.Settings.Platforms
				}
			}
		}
		if gitTracked {
			gitMode = "git-tracked"
		} else if gitIgnored {
			gitMode = "git-ignored"
		}
		cfg = initConfig{
			Name:            name,
			TaskIDPrefix:    taskIDPrefix,
			GitTrackingMode: gitMode,
			GitTracking:     gitTracking,
			EnableSemantic:  enableSemantic,
			SemanticModel:   semanticModel,
			EmbeddingSource: embeddingSource,
			Platforms:       platforms,
			// AC-13: the guidance shown when this ends up disabled must not
			// itself depend on a probe (D8), so it always renders the
			// "not installed" state — the conservative message that names
			// the default model and pull command without claiming to know
			// more about this machine than a non-interactive run is allowed
			// to check.
			SemanticGuidance: storage.OllamaStateGuidance(storage.OllamaNotInstalled, semanticModel),
		}
	}
	// An explicit --task-prefix outranks the wizard, existing config, and
	// global defaults.
	if taskIDPrefixFlag != "" {
		cfg.TaskIDPrefix = taskIDPrefixFlag
	}
	cfg.TaskLifecycle = taskLifecycleSeed
	if cfg.EmbeddingSource == "" {
		cfg.EmbeddingSource = "ollama"
	}

	// Build init steps
	steps := []initStep{
		{
			label: "Creating project structure",
			run: func() error {
				store := storage.NewStore(root)
				return store.Init(cfg.Name)
			},
		},
		{
			label: "Applying settings",
			run: func() error {
				store := storage.NewStore(root)
				project, err := store.Config.Load()
				if err != nil {
					return err
				}
				if cfg.GitTrackingMode != "" {
					project.Settings.GitTrackingMode = cfg.GitTrackingMode
				}
				if cfg.GitTrackingMode != "none" {
					project.Settings.GitTracking = &cfg.GitTracking
				}
				if ss := buildSemanticSettings(cfg); ss != nil {
					project.Settings.SemanticSearch = ss
				}
				if len(cfg.Platforms) > 0 {
					project.Settings.Platforms = cfg.Platforms
				}
				project.Settings.DefaultTaskIDPrefix = cfg.TaskIDPrefix
				if cfg.TaskLifecycle != nil {
					project.Settings.TaskLifecycle = copyTaskLifecycleSettings(cfg.TaskLifecycle)
				}
				return store.Config.Save(project)
			},
		},
		{
			label: "Configuring git integration",
			run: func() error {
				return writeKnownsGitignore(cwd, cfg.GitTrackingMode, &cfg.GitTracking)
			},
		},
		{
			label: "Creating project instruction files",
			run: func() error {
				return createInstructionFilesForPlatforms(cwd, force, cfg.Platforms)
			},
		},
	}

	if !hasGitRepo && gitAvailable {
		steps = append([]initStep{{
			label: "Initializing git repository",
			run: func() error {
				return gitInit(cwd)
			},
		}}, steps...)
	}

	// No semantic index is built here, by design. A fresh project has nothing to
	// embed, and a re-init would pay a full rebuild for no gain: tasks and docs
	// are indexed incrementally on write (search.BestEffortIndexTask/Doc). The
	// closing hints point at `knowns doctor` and `knowns search --reindex` for
	// the cases that do need a rebuild, such as switching embedding model.

	steps = append(steps, initStep{
		label: "Installing language servers",
		run: func() error {
			s := storage.NewStore(root)
			return autoInstallLSPServers(cwd, s)
		},
	})

	fmt.Println()
	if err := runInitSteps(steps); err != nil {
		return fmt.Errorf("init failed: %w", err)
	}

	fmt.Println()
	fmt.Println(titleStyle.Render("Get started:"))
	fmt.Println(dimStyle.Render("  knowns task create \"My first task\""))
	printSetupSuggestion(cwd)
	fmt.Println(dimStyle.Render("  Use /kn-init to start an AI session"))

	fmt.Println()
	fmt.Println(titleStyle.Render("Check setup:"))
	fmt.Println(dimStyle.Render("  knowns doctor             # Diagnose project and integration health"))
	if cfg.EnableSemantic {
		fmt.Println(dimStyle.Render("  knowns search --reindex   # Build semantic indices (skipped during init)"))
	} else {
		// AC-13/FR-10/FR-11 (D6): semantic search ended up disabled, so state
		// that keyword search still works, name the default model and the
		// command to obtain it, and point at the published guidance — all
		// resolved from the single shared source rather than restated here.
		fmt.Println()
		fmt.Println(titleStyle.Render("Semantic search:"))
		fmt.Println(dimStyle.Render("  " + cfg.SemanticGuidance.Description))
		if cfg.SemanticGuidance.Command != "" {
			fmt.Println(dimStyle.Render("  " + cfg.SemanticGuidance.Command))
		}
		fmt.Println(dimStyle.Render("  Read more: " + storage.OllamaGuidanceDocsURL))
	}
	fmt.Println()
	return maybeOpenBrowser(cwd, openFlag, noOpen)
}

func loadGlobalProjectDefaults() (*storage.ProjectDefaults, error) {
	settings, err := storage.NewEmbeddingSettingsStore().Load()
	if err != nil {
		return nil, err
	}
	return settings.ProjectDefaults, nil
}

// buildSemanticSettings returns the SemanticSearchSettings block for a
// semantic-enabled init, including the default vector store declaration
// (managed Qdrant, lazy install; spec D10). It returns nil when semantic
// search should not be enabled. No Qdrant binary is installed or started
// here; the declaration is metadata only.
func buildSemanticSettings(cfg initConfig) *models.SemanticSearchSettings {
	if !cfg.EnableSemantic || cfg.SemanticModel == "" {
		return nil
	}
	provider := cfg.EmbeddingSource
	if provider == "" {
		provider = "ollama"
	}
	ss := &models.SemanticSearchSettings{
		Enabled:  true,
		Provider: provider,
		Model:    cfg.SemanticModel,
	}
	// Declare Qdrant as the default vector backend (spec D10). Only the
	// backend and mode are recorded; managedRoot, install policy, and
	// retention stay unwritten so they keep resolving from current defaults
	// instead of being frozen at init time. Install/start stays lazy: first
	// semantic use or explicit commands bootstrap the runtime.
	ss.VectorStore = models.DeclaredSemanticVectorStoreSettingsPtr()
	return ss
}

func lifecycleSeedForInit(root string, force bool, defaults *storage.ProjectDefaults) *models.TaskLifecycleSettings {
	if force {
		if existing, err := storage.NewStore(root).Config.Load(); err == nil {
			effective := existing.Settings.EffectiveTaskLifecycle()
			return &effective
		}
	}
	if defaults == nil {
		return nil
	}
	return copyTaskLifecycleSettings(defaults.Settings.TaskLifecycle)
}

func copyTaskLifecycleSettings(settings *models.TaskLifecycleSettings) *models.TaskLifecycleSettings {
	if settings == nil {
		return nil
	}
	clone := *settings
	if settings.PurgeAfter != nil {
		purgeAfter := *settings.PurgeAfter
		clone.PurgeAfter = &purgeAfter
	}
	return &clone
}

// ollamaDetectorFactory constructs the detector the interactive wizard uses
// to preselect semantic search state (D7) and to offer a model already on
// disk ahead of the D2 default (D8/FR-14). It is called only from
// probeOllamaForWizard, which in turn is called only from runWizard — a
// non-interactive init must neither probe nor pull (D8), which is what makes
// AC-21's byte-identical output achievable. Overridable in tests.
var ollamaDetectorFactory = func() *search.OllamaDetector {
	return search.NewOllamaDetector(search.OllamaDefaultBase)
}

// probeOllamaForWizard detects which of the FR-10 four states the local
// machine is in, for the interactive wizard's preselection only. IsRunning
// alone cannot tell "not installed" apart from "installed but not running" —
// both look like a refused connection — so, like doctor's search.model check,
// it distinguishes the two via PATH lookup first.
func probeOllamaForWizard() (storage.OllamaState, []search.OllamaEmbeddingModel) {
	if _, err := execLookPath("ollama"); err != nil {
		return storage.OllamaNotInstalled, nil
	}
	detector := ollamaDetectorFactory()
	running, _ := detector.IsRunning()
	if !running {
		return storage.OllamaNotRunning, nil
	}
	embModels, err := detector.ListEmbeddingModels()
	if err != nil || len(embModels) == 0 {
		return storage.OllamaModelMissing, nil
	}
	return storage.OllamaReady, embModels
}

// wizardSemanticDefaults resolves what the interactive wizard preselects for
// semantic search: whether it starts enabled, which model starts selected,
// and the guidance text/command explaining the detected state. An existing
// answer from a prior `knowns init` always wins over the probe — that answer
// is itself the user's word, not machine state, so honoring it here is the
// same D7 rule applied to a value written earlier rather than today. On a
// genuinely fresh project the probe may preselect enabled=true only when
// Ollama is actually ready; any other state preselects disabled without
// deciding — the user can still turn it on in the form (Scenario 6). The
// model preselection offers whatever the machine already serves ahead of the
// D2 default (D8/FR-14/AC-23), falling back to the D2 default when nothing is
// detected.
func wizardSemanticDefaults(state storage.OllamaState, embModels []search.OllamaEmbeddingModel, existingEnabled *bool, existingModel string) (enabled bool, model string, guidance storage.OllamaGuidance) {
	model = storage.D2DefaultModelID
	if len(embModels) > 0 {
		model = embModels[0].ShortName
	}
	if existingModel != "" {
		model = existingModel
	}
	guidance = storage.OllamaStateGuidance(state, model)

	enabled = state == storage.OllamaReady
	if existingEnabled != nil {
		enabled = *existingEnabled
	}
	return enabled, model, guidance
}

// semanticModelOptions renders the wizard's model choices: anything the
// machine already serves, ahead of the three D2 recommended models with the
// tradeoff that distinguishes each (FR-9/FR-11), deduplicated by ID so a
// model that is both on disk and in D2 is not listed twice. selected — an
// existing config's model, a detected on-disk model, or the D2 default — is
// always present and marked as the default choice, even if it matches
// neither bucket (e.g. a model since removed from D2), so a prior answer is
// never silently discarded from the list.
func semanticModelOptions(embModels []search.OllamaEmbeddingModel, selected string) []huh.Option[string] {
	seen := make(map[string]bool)
	var options []huh.Option[string]
	for _, m := range embModels {
		id := m.ShortName
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		label := fmt.Sprintf("%s (%dd) — already on this machine", id, m.Dimensions)
		options = append(options, huh.NewOption(label, id).Selected(id == selected))
	}
	for _, m := range storage.RecommendedModels() {
		if seen[m.ID] {
			continue
		}
		seen[m.ID] = true
		label := fmt.Sprintf("%s — %s", m.ID, m.Tradeoff)
		options = append(options, huh.NewOption(label, m.ID).Selected(m.ID == selected))
	}
	if selected != "" && !seen[selected] {
		options = append(options, huh.NewOption(selected+" (current)", selected).Selected(true))
	}
	return options
}

// resolveWizardEmbeddingSource returns the embedding provider the wizard must
// preserve. runWizard never asks for it, so without this the provider silently
// resets to the legacy "local" value on `knowns init --force`, discarding a
// deliberate Ollama or API choice. That value now resolves back to the Ollama
// default rather than reaching a local backend, but losing the user's stated
// provider is still wrong.
func resolveWizardEmbeddingSource(globalDefaults *storage.ProjectDefaults, existing *models.Project) string {
	source := ""
	if globalDefaults != nil && globalDefaults.Settings.SemanticSearch != nil {
		source = globalDefaults.Settings.SemanticSearch.Provider
	}
	if existing != nil && existing.Settings.SemanticSearch != nil && existing.Settings.SemanticSearch.Provider != "" {
		source = existing.Settings.SemanticSearch.Provider
	}
	return source
}

func defaultsForWizard(cwd string, defaults *storage.ProjectDefaults) (string, string, string, *models.GitTracking, *bool, string, []string) {
	name := filepath.Base(cwd)
	var taskIDPrefix string
	var gitMode string
	var gitTracking *models.GitTracking
	var semanticEnabled *bool
	var semanticModel string
	platforms := defaultInstructionPlatforms()

	if defaults == nil {
		return name, taskIDPrefix, gitMode, gitTracking, semanticEnabled, semanticModel, platforms
	}
	if defaults.ProjectName != "" {
		name = defaults.ProjectName
	}
	taskIDPrefix = defaults.Settings.DefaultTaskIDPrefix
	gitMode = defaults.Settings.GitTrackingMode
	gitTracking = defaults.Settings.GitTracking
	if defaults.Settings.SemanticSearch != nil {
		enabled := defaults.Settings.SemanticSearch.Enabled
		semanticEnabled = &enabled
		semanticModel = defaults.Settings.SemanticSearch.Model
	}
	if len(defaults.Settings.Platforms) > 0 {
		platforms = defaults.Settings.Platforms
	}
	return name, taskIDPrefix, gitMode, gitTracking, semanticEnabled, semanticModel, platforms
}

func runWizard(cwd string, gitTracked, gitIgnored bool, gitAvailable bool, existingName string, existingTaskIDPrefix string, existingGitTrackingMode string, existingGitTracking *models.GitTracking, existingSemanticEnabled *bool, existingSemanticModel string, existingPlatforms []string) (*initConfig, error) {
	defaultName := filepath.Base(cwd)
	if existingName != "" {
		defaultName = existingName
	}
	hasGit := isGitRepo(cwd)

	fmt.Println()
	fmt.Println(titleStyle.Render("🚀 Knowns Project Setup"))
	fmt.Println(dimStyle.Render("   Quick configuration"))
	fmt.Println()

	var cfg initConfig
	cfg.Name = defaultName
	cfg.TaskIDPrefix = existingTaskIDPrefix

	// --- Group 1: Project name and Task ID prefix ---
	nameField := huh.NewGroup(
		huh.NewInput().
			Title("Project name").
			Value(&cfg.Name).
			Placeholder(defaultName).
			Validate(func(s string) error {
				if strings.TrimSpace(s) == "" {
					return fmt.Errorf("project name is required")
				}
				return nil
			}),
		huh.NewInput().
			Title("Default Task ID prefix").
			Description("2-8 alphanumeric characters, e.g. KN. Leave blank for legacy IDs.").
			Value(&cfg.TaskIDPrefix).
			Placeholder(existingTaskIDPrefix).
			Validate(func(s string) error {
				_, err := models.NormalizeTaskIDPrefix(s)
				return err
			}),
	)

	// --- Group 1b: Git tracking mode (only if in a git repo and not set via flag) ---
	var gitGroup *huh.Group
	if (hasGit || gitAvailable) && !gitTracked && !gitIgnored {
		cfg.GitTrackingMode = "git-tracked"
		if existingGitTrackingMode != "" {
			cfg.GitTrackingMode = existingGitTrackingMode
		}
		gitGroup = huh.NewGroup(
			huh.NewSelect[string]().
				Title("Git tracking mode").
				Description("Choose what Knowns data is committed to git.").
				Options(
					huh.NewOption("Git Tracked  · tasks, docs, templates", "git-tracked"),
					huh.NewOption("Git Ignored  · docs, templates only", "git-ignored"),
					huh.NewOption("None  · manage tracking manually", "none"),
				).
				Value(&cfg.GitTrackingMode),
		)
	} else if gitTracked {
		cfg.GitTrackingMode = "git-tracked"
	} else if gitIgnored {
		cfg.GitTrackingMode = "git-ignored"
	}

	// --- Group 2: Semantic search (D7/D8, FR-13/FR-14) ---
	// Detection may only narrow what gets preselected here, never decide what
	// gets written: the probe below sets the form's starting values, but the
	// written configuration is whatever the user leaves in the form when it
	// submits (D7). A non-interactive run reaches neither this probe nor this
	// form at all — see runInit's separate, fixed default (D8/AC-21).
	ollamaState, ollamaEmbModels := probeOllamaForWizard()
	semanticEnabledDefault, semanticModelDefault, semanticGuidance := wizardSemanticDefaults(
		ollamaState, ollamaEmbModels, existingSemanticEnabled, existingSemanticModel)
	cfg.EnableSemantic = semanticEnabledDefault
	cfg.SemanticModel = semanticModelDefault
	cfg.SemanticGuidance = semanticGuidance

	semanticGroup := huh.NewGroup(
		huh.NewConfirm().
			Title("Enable Semantic Search").
			Description(semanticGuidance.Description).
			Value(&cfg.EnableSemantic),
		huh.NewSelect[string]().
			Title("Embedding model").
			Description("No model is downloaded by init (D8) — pull it yourself if it isn't already on disk.").
			Options(semanticModelOptions(ollamaEmbModels, cfg.SemanticModel)...).
			Value(&cfg.SemanticModel),
	).WithHideFunc(func() bool {
		return !cfg.EnableSemantic
	})

	// Run form
	groups := []*huh.Group{nameField}
	if gitGroup != nil {
		groups = append(groups, gitGroup)
	}
	groups = append(groups, semanticGroup)

	// Seed per-section toggles from existing config. This has to happen before
	// the form is built so the sections group can join the same form instead of
	// running as a second, inline program after it.
	if existingGitTracking != nil {
		cfg.GitTracking = *existingGitTracking
	} else {
		cfg.GitTracking = models.GitTrackingDefaults()
	}
	selectedSections := gitTrackingSelectedSections(&cfg.GitTracking)
	sectionOptions := make([]huh.Option[string], 0, len(gitTrackingSections))
	for _, section := range gitTrackingSections {
		sectionOptions = append(sectionOptions, huh.NewOption(section.label, section.id).Selected(sectionSelected(selectedSections, section.id)))
	}
	// huh re-evaluates the hide func on every navigation keypress, so picking
	// "none" above skips this group live without a separate form run.
	groups = append(groups, huh.NewGroup(
		huh.NewMultiSelect[string]().
			TitleFunc(func() string {
				return fmt.Sprintf("Knowns sections to track in git (%d/%d selected)", len(selectedSections), len(sectionOptions))
			}, &selectedSections).
			Description("Choose sections under .knowns/ that should be committed.").
			Options(sectionOptions...).
			Value(&selectedSections),
	).WithHideFunc(func() bool {
		return cfg.GitTrackingMode == "none"
	}))

	cfg.Platforms = normalizeInstructionPlatforms(existingPlatforms)
	instructionOptions := instructionPlatformOptions(cfg.Platforms)
	groups = append(groups, huh.NewGroup(
		huh.NewMultiSelect[string]().
			// TitleFunc keeps a live "n/total" counter so the list reads as
			// scrollable when the viewport is shorter than the option list.
			TitleFunc(func() string {
				return fmt.Sprintf("Project instruction files (%d/%d selected)", len(cfg.Platforms), len(instructionOptions))
			}, &cfg.Platforms).
			Description("Instruction files for agents that read project files.").
			Options(instructionOptions...).
			Validate(func(s []string) error {
				if len(s) == 0 {
					return fmt.Errorf("select at least one instruction file")
				}
				return nil
			}).
			Value(&cfg.Platforms),
	))

	// Rendered inline, not via tea.WithAltScreen(). The alternate screen buffer
	// is discarded on exit, so an alt-screen wizard hides the banner printed
	// above while it runs and leaves no record of the answers afterwards.
	// Inline keeps both in scrollback, which is the whole point of `init`.
	form := huh.NewForm(groups...).
		WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		return nil, err
	}

	// The sections group is hidden for "none", which leaves the seeded tracking
	// config untouched rather than overwriting it with an unanswered selection.
	if cfg.GitTrackingMode != "none" {
		cfg.GitTracking = gitTrackingFromSelectedSections(selectedSections)
	}

	return &cfg, nil
}

func gitTrackingSelectedSections(tracking *models.GitTracking) []string {
	defaults := models.GitTrackingDefaults()
	gt := tracking
	if gt == nil {
		gt = &defaults
	}
	selected := []string{}
	if gt.Tasks != nil && *gt.Tasks || gt.Tasks == nil && *defaults.Tasks {
		selected = append(selected, "tasks")
	}
	if gt.Docs != nil && *gt.Docs || gt.Docs == nil && *defaults.Docs {
		selected = append(selected, "docs")
	}
	if gt.Templates != nil && *gt.Templates || gt.Templates == nil && *defaults.Templates {
		selected = append(selected, "templates")
	}
	if gt.Memories != nil && *gt.Memories || gt.Memories == nil && *defaults.Memories {
		selected = append(selected, "memories")
	}
	if gt.Decisions != nil && *gt.Decisions || gt.Decisions == nil && *defaults.Decisions {
		selected = append(selected, "decisions")
	}
	return selected
}

func sectionSelected(selected []string, section string) bool {
	for _, s := range selected {
		if s == section {
			return true
		}
	}
	return false
}

func gitTrackingFromSelectedSections(selected []string) models.GitTracking {
	tasks := sectionSelected(selected, "tasks")
	docs := sectionSelected(selected, "docs")
	templates := sectionSelected(selected, "templates")
	memories := sectionSelected(selected, "memories")
	decisions := sectionSelected(selected, "decisions")
	return models.GitTracking{
		Tasks:     &tasks,
		Docs:      &docs,
		Templates: &templates,
		Memories:  &memories,
		Decisions: &decisions,
	}
}

// execLookPath is used to locate binaries in PATH. Overridable in tests.
var execLookPath = exec.LookPath

// defaultExecLookPath is the original value of execLookPath for test cleanup.
var defaultExecLookPath = exec.LookPath

// execCommand is used to run external commands in init flows. Overridable in tests.
var execCommand = exec.Command

// defaultExecCommand is the original value of execCommand for test cleanup.
var defaultExecCommand = exec.Command

// terminalWidthFn is overridable in tests.
var terminalWidthFn = terminalWidth

// isTTYFn is overridable in tests.
var isTTYFn = isTTY

// osUserHomeDir is overridable in tests.
var osUserHomeDir = os.UserHomeDir

func isGitAvailable() bool {
	_, err := execLookPath("git")
	return err == nil
}

func gitInit(dir string) error {
	cmd := execCommand("git", "init")
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		trimmed := strings.TrimSpace(string(output))
		if trimmed == "" {
			return fmt.Errorf("git init failed: %w", err)
		}
		return fmt.Errorf("git init failed: %s", trimmed)
	}
	return nil
}

// mcpCommand returns the command and args for starting the Knowns MCP server
// in generated project configs. Uses the local knowns binary if available,
// otherwise falls back to npx so configs work on machines without a global install.
func mcpCommand() (command string, args []string) {
	if _, err := execLookPath("knowns"); err == nil {
		return "knowns", []string{"mcp", "--stdio"}
	}
	return "npx", []string{"-y", "knowns", "mcp", "--stdio"}
}

// mcpCommandFlat returns the MCP command as a single slice (for OpenCode config format).
func mcpCommandFlat() []string {
	cmd, args := mcpCommand()
	return append([]string{cmd}, args...)
}

// createMCPJsonFileQuiet creates .mcp.json without printing (for step runner).
func createMCPJsonFileQuiet(projectRoot string, force bool) error {
	mcpPath := filepath.Join(projectRoot, ".mcp.json")
	if _, err := os.Stat(mcpPath); err == nil && !force {
		return nil
	}

	cmd, args := mcpCommand()
	mcpConfig := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			"knowns": map[string]interface{}{
				"command": cmd,
				"args":    args,
			},
		},
	}

	data, err := json.MarshalIndent(mcpConfig, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(mcpPath, data, 0644)
}

func createOpenCodeConfigQuiet(projectRoot string) error {
	configPath := filepath.Join(projectRoot, "opencode.json")

	config := map[string]any{
		"$schema": "https://opencode.ai/config.json",
	}

	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("parse opencode.json: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	config["$schema"] = "https://opencode.ai/config.json"

	mcp, ok := config["mcp"].(map[string]any)
	if !ok || mcp == nil {
		mcp = make(map[string]any)
	}

	mcp["knowns"] = map[string]any{
		"type":    "local",
		"command": mcpCommandFlat(),
		"enabled": true,
	}

	config["mcp"] = mcp

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

// createKiroSteeringQuiet creates .kiro/steering/knowns.md with lightweight
// Knowns MCP bootstrap guidance.
func createKiroSteeringQuiet(projectRoot string, force bool) error {
	steeringDir := filepath.Join(projectRoot, ".kiro", "steering")
	if err := os.MkdirAll(steeringDir, 0755); err != nil {
		return fmt.Errorf("create .kiro/steering: %w", err)
	}

	steeringPath := filepath.Join(steeringDir, "knowns.md")
	if _, err := os.Stat(steeringPath); err == nil && !force {
		return nil
	}

	content := `---
description: Knowns project guidelines — prefer MCP initial/help and Knowns tools.
---

# Knowns Guidelines

Start with Knowns MCP ` + "`initial`" + ` when available. Use ` + "`help(\"tool.*\")`" + ` or ` + "`help(\"workflow.*\")`" + ` for domain details on demand.

Use Knowns docs, tasks, search, memory, and validation as the project working layer. If MCP is unavailable, use the ` + "`knowns`" + ` CLI for project context.
`
	return os.WriteFile(steeringPath, []byte(content), 0644)
}

// createKiroMCPConfigQuiet creates .kiro/settings/mcp.json with the Knowns
// MCP server entry. It merges into an existing file if present.
func createKiroMCPConfigQuiet(projectRoot string) error {
	settingsDir := filepath.Join(projectRoot, ".kiro", "settings")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		return fmt.Errorf("create .kiro/settings: %w", err)
	}

	configPath := filepath.Join(settingsDir, "mcp.json")

	config := map[string]any{}

	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("parse .kiro/settings/mcp.json: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	servers["knowns"] = map[string]any{
		"command":     cmd,
		"args":        args,
		"disabled":    false,
		"autoApprove": []string{"*"},
	}

	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func createCursorMCPConfigQuiet(projectRoot string) error {
	settingsDir := filepath.Join(projectRoot, ".cursor")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		return fmt.Errorf("create .cursor: %w", err)
	}

	configPath := filepath.Join(settingsDir, "mcp.json")
	config := map[string]any{}

	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("parse .cursor/mcp.json: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	servers["knowns"] = map[string]any{
		"command": cmd,
		"args":    args,
	}

	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

func createCodexMCPConfigQuiet(projectRoot string) error {
	configDir := filepath.Join(projectRoot, ".codex")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("create .codex: %w", err)
	}

	configPath := filepath.Join(configDir, "config.toml")
	body, err := readTextIfExistsCLI(configPath)
	if err != nil {
		return err
	}

	cmd, args := mcpCommand()
	updated := runtimeinstall.SetCodexMCPServer(body, cmd, args)
	return os.WriteFile(configPath, []byte(updated), 0644)
}

func createAntigravityRulesQuiet(projectRoot string, force bool) error {
	rulesDir := filepath.Join(projectRoot, ".agents", "rules")
	if err := os.MkdirAll(rulesDir, 0755); err != nil {
		return fmt.Errorf("create .agents/rules: %w", err)
	}

	rulePath := filepath.Join(rulesDir, "knowns.md")
	if _, err := os.Stat(rulePath); err == nil && !force {
		return nil
	}

	content := `---
trigger: always_on
description: Prefer Knowns MCP initial/help and Knowns tools for project context.
---

# Knowns Project Guidance

- Start with Knowns MCP ` + "`initial`" + ` when available.
- Use ` + "`help(\"tool.*\")`" + ` or ` + "`help(\"workflow.*\")`" + ` for domain details on demand.
- Treat Knowns docs, tasks, and memory as the working layer for the project.
- Prefer Knowns MCP tools for docs, tasks, search, and validation when available.
- If MCP is unavailable, fall back to the ` + "`knowns`" + ` CLI.
`

	return os.WriteFile(rulePath, []byte(content), 0644)
}

func readTextIfExistsCLI(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

func createAntigravityMCPConfigQuiet(projectRoot string) error {
	home, err := osUserHomeDir()
	if err != nil {
		return fmt.Errorf("resolve user home: %w", err)
	}

	settingsDir := filepath.Join(home, ".gemini", "antigravity")
	if err := os.MkdirAll(settingsDir, 0755); err != nil {
		return fmt.Errorf("create antigravity config dir: %w", err)
	}

	configPath := filepath.Join(settingsDir, "mcp_config.json")
	config := map[string]any{}

	if data, err := os.ReadFile(configPath); err == nil {
		if err := json.Unmarshal(data, &config); err != nil {
			return fmt.Errorf("parse antigravity mcp_config.json: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return err
	}

	servers, ok := config["mcpServers"].(map[string]any)
	if !ok || servers == nil {
		servers = make(map[string]any)
	}

	cmd, args := mcpCommand()
	args = append(args, "--project", projectRoot)
	servers["knowns"] = map[string]any{
		"command": cmd,
		"args":    args,
	}

	config["mcpServers"] = servers

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(configPath, append(data, '\n'), 0644)
}

// createInstructionFilesForPlatforms generates only instruction files for the
// given platform IDs. If platforms is empty all files are generated.
func createInstructionFilesForPlatforms(projectRoot string, force bool, platforms []string) error {
	for _, f := range defaultInstructionFiles {
		if !shouldCreateInstructionFile(platforms, f) {
			continue
		}
		if err := writeInstructionFile(projectRoot, f.Path, f.Platform, force); err != nil {
			return err
		}
	}
	return nil
}

// createInstructionFilesQuiet generates agent instruction files without printing.
func createInstructionFilesQuiet(projectRoot string, force bool) error {
	for _, f := range defaultInstructionFiles {
		if err := writeInstructionFile(projectRoot, f.Path, f.Platform, force); err != nil {
			return err
		}
	}
	return nil
}

func writeInstructionFile(projectRoot, relativePath, platform string, force bool) error {
	filePath := filepath.Join(projectRoot, relativePath)
	fileExists := false
	if _, err := os.Stat(filePath); err == nil {
		fileExists = true
		if !force {
			return nil
		}
	}

	if dir := filepath.Dir(filePath); dir != projectRoot {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create directory %s: %w", dir, err)
		}
	}

	content := generateInstructionContent(relativePath, platform, projectRoot)

	// For compatibility shim files that already exist, preserve user content
	// outside the managed marker block.
	if fileExists {
		return syncInstructionMarkerBlock(filePath, content)
	}

	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("could not create %s: %w", relativePath, err)
	}

	return nil
}

func generateInstructionContent(relativePath, platform, projectRoot string) string {
	return renderCompatibilityInstructionContent(relativePath, platform, projectRoot)
}

func renderCompatibilityInstructionContent(relativePath, platform, projectRoot string) string {
	projectName := filepath.Base(projectRoot)
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("# %s\n\n", compatibilityInstructionTitle(relativePath, platform, projectName)))
	sb.WriteString(fmt.Sprintf("Compatibility entrypoint for runtimes that auto-detect `%s`.\n\n", relativePath))
	sb.WriteString("<!-- KNOWNS GUIDELINES START -->\n\n")

	sb.WriteString("**CRITICAL: Start with Knowns MCP `initial` when available. Use `help(\"tool.*\")` or `help(\"workflow.*\")` for domain details on demand.**\n\n")
	sb.WriteString("## Runtime Guidance\n\n")
	sb.WriteString("- Knowns is the repository memory layer for humans and the AI-friendly working layer for agents.\n")
	sb.WriteString("- MCP `initial` is the primary AI bootstrap: project state, tool domains, code rules, and workflow routing.\n")
	sb.WriteString("- MCP `help` is the primary on-demand source for action schemas and recipes.\n")
	sb.WriteString("- Treat this file only as a lightweight compatibility entrypoint.\n\n")
	sb.WriteString("## Minimum Rules\n\n")
	sb.WriteString("- Use Knowns as the canonical system for tasks, docs, templates, and workflow state.\n")
	sb.WriteString("- Never manually edit Knowns-managed task or doc markdown.\n")
	sb.WriteString("- Search first, then read only relevant docs and code.\n")
	sb.WriteString("- Use `search` for discovery; use MCP `retrieve` tool when a workflow needs structured context with citations. Fall back to CLI `knowns retrieve` if MCP is unavailable.\n")
	sb.WriteString("- For code operations, use `code` tool: `find`/`symbols` for structure, `references`/`definition` for navigation, `rename`/`replace`/`replace_body`/`insert`/`delete` for editing. Use `help(\"code.*\")` or `help(\"workflow.code-edit\")` for details.\n")
	sb.WriteString("- Plan before implementation unless the user explicitly overrides that workflow.\n")
	sb.WriteString("- Validate before considering work complete.\n")
	sb.WriteString("- Use memory tools: `memory({ action: \"list\" })` at session start, `memory({ action: \"add\" })` after tasks for reusable knowledge.\n")
	sb.WriteString("- Proactively capture durable memory when scope and durability are clear.\n\n")
	sb.WriteString("## Quick Reference\n\n")
	sb.WriteString("```bash\n")
	sb.WriteString("knowns doc list --plain               # List docs\n")
	sb.WriteString("knowns task list --plain              # List tasks\n")
	sb.WriteString("knowns task <id> --plain              # View task\n")
	sb.WriteString("knowns doc \"<path>\" --plain --smart  # View doc\n")
	sb.WriteString("knowns search \"query\" --plain        # Search docs/tasks\n")
	sb.WriteString("knowns retrieve \"query\" --json      # Retrieve structured context pack (CLI fallback)\n")
	sb.WriteString("```\n\n")
	sb.WriteString("<!-- KNOWNS GUIDELINES END -->\n")
	return sb.String()
}

func compatibilityInstructionTitle(relativePath, platform, projectName string) string {
	switch relativePath {
	case "AGENTS.md":
		return "AGENTS"
	case "CLAUDE.md":
		return "CLAUDE"
	case "GEMINI.md":
		return "GEMINI"
	case "OPENCODE.md":
		return "OPENCODE"
	case filepath.Join(".github", "copilot-instructions.md"):
		return projectName + " - GitHub Copilot Instructions"
	default:
		return platform
	}
}

// isGitRepo checks if the given directory (or any parent) is a git repository.
func isGitRepo(dir string) bool {
	d := dir
	for {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return true
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return false
}

const (
	knownsGitignoreBegin = "# >>> KNOWNS >>>"
	knownsGitignoreEnd   = "# <<< KNOWNS <<<"
)

// writeKnownsGitignore creates .knowns/.gitignore with ignore rules based on
// the git tracking mode and per-section toggles. Also removes any legacy marker
// block from root .gitignore.
func writeKnownsGitignore(dir, mode string, tracking *models.GitTracking) error {
	// Remove legacy marker block from root .gitignore if present.
	removeLegacyGitignoreBlock(dir)

	knownsDir := filepath.Join(dir, ".knowns")
	gitignorePath := filepath.Join(knownsDir, ".gitignore")

	switch mode {
	case "git-tracked", "git-ignored":
		if err := os.MkdirAll(knownsDir, 0755); err != nil {
			return err
		}
	}

	// Resolve per-section tracking: explicit toggle > mode default.
	modeDefaults := models.GitTrackingModeDefaults(mode)
	gt := tracking
	if gt == nil {
		gt = &models.GitTracking{}
	}
	sectionTracked := func(section string) bool {
		var explicit *bool
		switch section {
		case "tasks":
			explicit = gt.Tasks
		case "docs":
			explicit = gt.Docs
		case "templates":
			explicit = gt.Templates
		case "memories":
			explicit = gt.Memories
		case "decisions":
			explicit = gt.Decisions
		}
		if explicit != nil {
			return *explicit
		}
		switch section {
		case "tasks":
			return *modeDefaults.Tasks
		case "docs":
			return *modeDefaults.Docs
		case "templates":
			return *modeDefaults.Templates
		case "memories":
			return *modeDefaults.Memories
		case "decisions":
			return *modeDefaults.Decisions
		}
		return false
	}

	switch mode {
	case "git-tracked":
		// Track all .knowns/ content; only ignore runtime/cache files and
		// sections explicitly disabled.
		var buf strings.Builder
		buf.WriteString("# Managed by Knowns CLI — do not edit manually.\n")
		buf.WriteString("# Run 'knowns init' to regenerate.\n\n")
		buf.WriteString("# Runtime & cache\n")
		buf.WriteString(".search/\n")
		buf.WriteString(".working-memory/\n")
		buf.WriteString("runtime/\n")
		buf.WriteString("worktrees/\n")
		buf.WriteString(".server-port\n")
		buf.WriteString(".DS_Store\n")
		if !sectionTracked("tasks") {
			buf.WriteString("\n# Per-section tracking disabled\n")
			buf.WriteString("tasks/\n")
			buf.WriteString("tombstones/tasks/\n")
		}
		if !sectionTracked("docs") {
			buf.WriteString("docs/\n")
		}
		if !sectionTracked("templates") {
			buf.WriteString("templates/\n")
		}
		if !sectionTracked("memories") {
			buf.WriteString("memories/\n")
		}
		if !sectionTracked("decisions") {
			buf.WriteString("decisions/\n")
		}
		return os.WriteFile(gitignorePath, []byte(buf.String()), 0644)

	case "git-ignored":
		// Ignore everything by default, then un-ignore sections that are enabled.
		var buf strings.Builder
		buf.WriteString("# Managed by Knowns CLI — do not edit manually.\n")
		buf.WriteString("# Run 'knowns init' to regenerate.\n\n")
		buf.WriteString("# Ignore everything by default\n")
		buf.WriteString("*\n\n")
		buf.WriteString("# Track these\n")
		buf.WriteString("!.gitignore\n")
		buf.WriteString("!config.json\n")
		if sectionTracked("docs") {
			buf.WriteString("!docs/\n")
			buf.WriteString("!docs/**\n")
		}
		if sectionTracked("templates") {
			buf.WriteString("!templates/\n")
			buf.WriteString("!templates/**\n")
		}
		if sectionTracked("tasks") {
			buf.WriteString("!tasks/\n")
			buf.WriteString("!tasks/**\n")
			buf.WriteString("!tombstones/\n")
			buf.WriteString("!tombstones/tasks/\n")
			buf.WriteString("!tombstones/tasks/**\n")
		}
		if sectionTracked("memories") {
			buf.WriteString("!memories/\n")
			buf.WriteString("!memories/**\n")
		}
		if sectionTracked("decisions") {
			buf.WriteString("!decisions/\n")
			buf.WriteString("!decisions/**\n")
		}
		return os.WriteFile(gitignorePath, []byte(buf.String()), 0644)

	case "none":
		// Remove .knowns/.gitignore if it exists.
		_ = os.Remove(gitignorePath)
		return nil
	}

	return nil
}

// removeLegacyGitignoreBlock removes the old marker-delimited Knowns block
// from root .gitignore (migration from older versions).
func removeLegacyGitignoreBlock(dir string) {
	gitignorePath := filepath.Join(dir, ".gitignore")

	data, err := os.ReadFile(gitignorePath)
	if err != nil {
		return
	}

	existing := string(data)
	if !strings.Contains(existing, knownsGitignoreBegin) {
		return
	}

	var cleaned []string
	inside := false
	for _, line := range strings.Split(existing, "\n") {
		if strings.TrimSpace(line) == knownsGitignoreBegin {
			inside = true
			continue
		}
		if strings.TrimSpace(line) == knownsGitignoreEnd {
			inside = false
			continue
		}
		if !inside {
			cleaned = append(cleaned, line)
		}
	}

	// Trim trailing blank lines.
	for len(cleaned) > 0 && strings.TrimSpace(cleaned[len(cleaned)-1]) == "" {
		cleaned = cleaned[:len(cleaned)-1]
	}

	content := ""
	if len(cleaned) > 0 {
		content = strings.Join(cleaned, "\n") + "\n"
	}
	_ = os.WriteFile(gitignorePath, []byte(content), 0644)
}

// maybeOpenBrowser optionally launches the web UI after init.
//
//   - --no-open or --no-wizard: skip silently
//   - --open: launch immediately without prompting
//   - default (interactive): show a confirm prompt
//
// maybeOpenBrowser launches the web UI only when --open is passed explicitly.
// Default behavior (no flag) is to do nothing — users follow the printed hint instead.
func maybeOpenBrowser(cwd string, openFlag, noOpen bool) error {
	if noOpen || !openFlag {
		return nil
	}

	root := filepath.Join(cwd, ".knowns")
	store := storage.NewStore(root)
	port := 3001
	if cfg, err := store.Config.Load(); err == nil && cfg.Settings.ServerPort != 0 {
		port = cfg.Settings.ServerPort
	}

	url := fmt.Sprintf("http://localhost:%d", port)
	go openBrowser(url)

	srv := server.NewServer(store, cwd, port, server.Options{})
	fmt.Printf("  %s  %s\n", StyleInfo.Render("→"), StyleBold.Render(url))
	fmt.Println()
	return srv.Start()
}

// autoInstallLSPServers detects languages in cwd and installs LSP servers
// for any that are not already on PATH. Non-blocking: always returns nil.
func autoInstallLSPServers(cwd string, store *storage.Store) error {
	if cwd == "" || strings.TrimSpace(os.Getenv("KNOWN_LSP_AUTO_INSTALL")) == "0" {
		return nil
	}

	// Build a registry from all adapters to cover extra languages beyond builtins.
	reg := lsp.NewRegistry(nil)
	for _, adapter := range adapters.All() {
		reg.Register(lsp.Language{
			ID:         adapter.ID(),
			Name:       adapter.Name(),
			Extensions: adapter.Extensions(),
			Binaries:   lspBinariesFromAdapter(adapter),
		})
	}

	detector := lsp.NewDetector(reg)
	detected, err := detector.DetectedLanguages(cwd, lsp.Config{})
	if err != nil {
		return nil // non-blocking
	}
	if len(detected) == 0 {
		return nil
	}

	// Persist detected languages to config
	if store != nil {
		if project, err := store.Config.Load(); err == nil {
			if project.Settings.LSP == nil {
				enabled := true
				project.Settings.LSP = &models.LSPSettings{Enabled: &enabled, Languages: map[string]models.LSPLanguageSettings{}}
			}
			if project.Settings.LSP.Languages == nil {
				project.Settings.LSP.Languages = map[string]models.LSPLanguageSettings{}
			}
			changed := false
			enabled := true
			for _, lang := range detected {
				if _, exists := project.Settings.LSP.Languages[lang.ID]; !exists {
					project.Settings.LSP.Languages[lang.ID] = models.LSPLanguageSettings{Enabled: &enabled}
					changed = true
				}
			}
			if changed {
				project.Settings.LSP.Enabled = &enabled
				_ = store.Config.Save(project)
			}
		}
	}

	ctx := context.Background()
	targetDir := lspBaseDir()

	adapterByID := make(map[string]lsp.LanguageAdapter, len(adapters.All()))
	for _, a := range adapters.All() {
		adapterByID[a.ID()] = a
	}

	for _, lang := range detected {
		adapter, ok := adapterByID[lang.ID]
		if !ok || !adapter.CanInstall() {
			continue
		}
		if _, found := findLspBinary(ctx, adapter, ""); found {
			continue
		}
		if err := adapter.CheckPrerequisites(ctx); err != nil {
			fmt.Printf("  ⚠ %s — prerequisites not met: %v\n", adapter.Name(), err)
			continue
		}
		path, err := adapter.Install(ctx, targetDir)
		if err != nil {
			fmt.Printf("  ⚠ %s — install failed: %v\n", adapter.Name(), err)
			continue
		}
		fmt.Printf("  ✓ Installed %s → %s\n", adapter.Name(), path)
	}

	return nil
}

func lspBinariesFromAdapter(adapter lsp.LanguageAdapter) []lsp.Binary {
	var out []lsp.Binary
	for _, c := range adapter.Binaries() {
		out = append(out, lsp.Binary{
			Name:      c.Name,
			Args:      c.Args,
			CheckArgs: c.CheckArgs,
		})
	}
	return out
}

func init() {
	initCmd.Flags().String("task-prefix", "", "Default task ID prefix (2-8 alphanumeric characters, e.g. KN)")
	initCmd.Flags().Bool("git-tracked", false, "Track .knowns/ files in git")
	initCmd.Flags().Bool("git-ignored", false, "Add .knowns/ to .gitignore")
	initCmd.Flags().Bool("wizard", false, "Run interactive setup wizard")
	initCmd.Flags().Bool("no-wizard", false, "Skip interactive prompts, use defaults")
	initCmd.Flags().BoolP("force", "f", false, "Force reinitialize even if already initialized")
	initCmd.Flags().Bool("open", false, "Launch the web UI immediately after init")
	initCmd.Flags().Bool("no-open", false, "Skip the web UI launch prompt after init")

	rootCmd.AddCommand(initCmd)
}
