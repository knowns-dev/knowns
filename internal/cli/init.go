package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
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

// embeddingModelInfo describes a supported embedding model for semantic search.
type embeddingModelInfo struct {
	ID            string
	Title         string
	Description   string
	HuggingFaceID string
	Dimensions    int
	MaxTokens     int
}

var supportedEmbeddingModels = []embeddingModelInfo{
	{
		ID:            "gte-small",
		Title:         "gte-small (recommended)",
		Description:   "384 dims, 67MB — best balance",
		HuggingFaceID: "Xenova/gte-small",
		Dimensions:    384,
		MaxTokens:     512,
	},
	{
		ID:            "all-MiniLM-L6-v2",
		Title:         "all-MiniLM-L6-v2",
		Description:   "384 dims, 45MB — fastest",
		HuggingFaceID: "Xenova/all-MiniLM-L6-v2",
		Dimensions:    384,
		MaxTokens:     256,
	},
	{
		ID:            "gte-base",
		Title:         "gte-base",
		Description:   "768 dims, 220MB — highest quality",
		HuggingFaceID: "Xenova/gte-base",
		Dimensions:    768,
		MaxTokens:     512,
	},
	{
		ID:            "bge-small-en-v1.5",
		Title:         "bge-small-en-v1.5",
		Description:   "384 dims, 67MB — strong retrieval",
		HuggingFaceID: "Xenova/bge-small-en-v1.5",
		Dimensions:    384,
		MaxTokens:     512,
	},
	{
		ID:            "bge-base-en-v1.5",
		Title:         "bge-base-en-v1.5",
		Description:   "768 dims, 220MB — top retrieval quality",
		HuggingFaceID: "Xenova/bge-base-en-v1.5",
		Dimensions:    768,
		MaxTokens:     512,
	},
	{
		ID:            "nomic-embed-text-v1.5",
		Title:         "nomic-embed-text-v1.5",
		Description:   "768 dims, 274MB — long context (8192 tokens)",
		HuggingFaceID: "nomic-ai/nomic-embed-text-v1.5",
		Dimensions:    768,
		MaxTokens:     8192,
	},
	{
		ID:            "multilingual-e5-small",
		Title:         "multilingual-e5-small",
		Description:   "384 dims, 471MB — multilingual support",
		HuggingFaceID: "Xenova/multilingual-e5-small",
		Dimensions:    384,
		MaxTokens:     512,
	},
}

// instructionFile defines an agent instruction file to generate during init.
type instructionFile struct {
	Path       string
	Platform   string // display name passed to generateInstructionContent
	PlatformID string // matches allPlatformIDs entry
}

const canonicalInstructionFile = "KNOWNS.md"

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
var allPlatformIDs = []string{"claude-code", "opencode", "codex", "kiro", "antigravity", "cursor", "gemini", "copilot", "agents"}

// wizardPlatformIDs is the subset shown in the wizard multi-select.
var wizardPlatformIDs = []string{"claude-code", "opencode", "codex", "kiro", "antigravity", "cursor", "gemini", "copilot", "agents"}

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
	if f.PlatformID == "agents" && hasExplicitPlatform(platforms, "codex") {
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
		if id == "codex" {
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
		{label: ".github/copilot-instructions.md  (GitHub Copilot)", id: "copilot"},
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
	GitTrackingMode string
	GitTracking     models.GitTracking
	EnableSemantic  bool
	SemanticModel   string
	EmbeddingSource string // "local" or "api"
	Platforms       []string
	EnableChatUI    bool
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

	// Determine if interactive mode
	interactive := !noWizard
	if interactive && isTTYFn() && terminalWidthFn() < 90 {
		fmt.Println(warnStyle.Render("Terminal is too small for the interactive setup wizard."))
		fmt.Println()
		fmt.Println(RenderField("Minimum width", "90 columns"))
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
		existingName, existingGitTrackingMode, existingGitTracking, existingSemanticEnabled, existingSemanticModel, existingPlatforms := defaultsForWizard(cwd, globalDefaults)
		if existingCfg, err := storage.NewStore(root).Config.Load(); err == nil {
			existingName = existingCfg.Name
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
		wizardCfg, err := runWizard(cwd, gitTracked, gitIgnored, gitAvailable, existingName, existingGitTrackingMode, existingGitTracking, existingSemanticEnabled, existingSemanticModel, existingPlatforms)
		if err != nil {
			if err == huh.ErrUserAborted {
				fmt.Println(warnStyle.Render("Setup cancelled."))
				return nil
			}
			return err
		}
		cfg = *wizardCfg
	} else {
		// Non-interactive or name provided
		name := filepath.Base(cwd)
		if globalDefaults != nil && globalDefaults.ProjectName != "" {
			name = globalDefaults.ProjectName
		}
		if len(args) > 0 {
			name = args[0]
		}
		gitMode := "git-tracked"
		gitTracking := models.GitTrackingDefaults()
		enableSemantic := isTTY()
		semanticModel := "multilingual-e5-small"
		embeddingSource := "local"
		platforms := defaultInstructionPlatforms()
		enableChatUI := true
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
			if globalDefaults.Settings.EnableChatUI != nil {
				enableChatUI = *globalDefaults.Settings.EnableChatUI
			}
		}
		if force {
			if existingCfg, err := storage.NewStore(root).Config.Load(); err == nil {
				if existingCfg.Name != "" && len(args) == 0 {
					name = existingCfg.Name
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
				if existingCfg.Settings.EnableChatUI != nil {
					enableChatUI = *existingCfg.Settings.EnableChatUI
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
			GitTrackingMode: gitMode,
			GitTracking:     gitTracking,
			EnableSemantic:  enableSemantic,
			SemanticModel:   semanticModel,
			EmbeddingSource: embeddingSource,
			Platforms:       platforms,
			EnableChatUI:    enableChatUI,
		}
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
				if cfg.EnableSemantic && cfg.SemanticModel != "" {
					if cfg.EmbeddingSource == "api" {
						// API provider: reference model from global settings.
						project.Settings.SemanticSearch = &models.SemanticSearchSettings{
							Enabled:  true,
							Provider: "api",
							Model:    cfg.SemanticModel,
						}
					} else {
						// Local ONNX: existing behavior.
						m := findEmbeddingModel(cfg.SemanticModel)
						if m != nil {
							project.Settings.SemanticSearch = &models.SemanticSearchSettings{
								Enabled:       true,
								Model:         m.ID,
								HuggingFaceID: m.HuggingFaceID,
								Dimensions:    m.Dimensions,
								MaxTokens:     m.MaxTokens,
							}
						} else if mc, ok := search.EmbeddingModels[cfg.SemanticModel]; ok {
							// Custom model registered at runtime.
							project.Settings.SemanticSearch = &models.SemanticSearchSettings{
								Enabled:       true,
								Model:         cfg.SemanticModel,
								HuggingFaceID: mc.HuggingFaceID,
								Dimensions:    mc.Dimensions,
								MaxTokens:     mc.MaxTokens,
							}
						}
					}
				}
				if len(cfg.Platforms) > 0 {
					project.Settings.Platforms = cfg.Platforms
				}
				enableChatUI := cfg.EnableChatUI
				project.Settings.EnableChatUI = &enableChatUI
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

	// Conditional semantic download steps (only for local ONNX with built-in models)
	isBuiltinModel := findSupportedModel(cfg.SemanticModel) != nil
	if cfg.EnableSemantic && cfg.EmbeddingSource != "api" && isBuiltinModel {
		dlSteps, alreadyInstalled, err := buildSemanticDownloadSteps(cfg.SemanticModel)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: semantic search setup failed: %v\n", err)
			fmt.Println(dimStyle.Render(fmt.Sprintf("  You can set up later: knowns model download %s", cfg.SemanticModel)))
		} else if alreadyInstalled {
			steps = append(steps, initStep{
				label: "Semantic search (already installed)",
				run:   func() error { return nil },
			})
		} else {
			steps = append(steps, dlSteps...)
		}
	}

	if cfg.EnableSemantic && cfg.EmbeddingSource != "api" && isBuiltinModel {
		steps = append(steps, initStep{
			label: "Preparing project and global semantic stores",
			run: func() error {
				store := storage.NewStore(root)
				_, _, err := ensureProjectAndGlobalSemanticReady(store, cfg.SemanticModel)
				return err
			},
		})
	} else if cfg.EnableSemantic && cfg.EmbeddingSource == "local" && !isBuiltinModel {
		// Custom HuggingFace model: auto-download ONNX files.
		customModelID := cfg.SemanticModel
		steps = append(steps, initStep{
			label: fmt.Sprintf("Downloading custom model %q from HuggingFace", customModelID),
			run: func() error {
				mc, ok := search.EmbeddingModels[customModelID]
				if !ok {
					return fmt.Errorf("model %q not registered", customModelID)
				}
				err := downloadCustomHuggingFaceModel(mc.HuggingFaceID)
				if err != nil && strings.Contains(err.Error(), "no .onnx files found") {
					fmt.Printf("\n%s This model has no ONNX export — cannot use for local inference.\n", warnStyle.Render("⚠"))
					fmt.Println(dimStyle.Render("  Use it via API instead: knowns provider add, then knowns model set"))
					fmt.Println(dimStyle.Render("  Or choose a Xenova/* model which includes ONNX files."))
					fmt.Println(dimStyle.Render("  Falling back to keyword-only search for now."))
					return nil // non-fatal
				}
				return err
			},
		})
	}

	if cfg.EnableSemantic {
		steps = append(steps, initStep{
			label: "Building project and global semantic indices",
			run: func() error {
				store := storage.NewStore(root)
				return reindexSemanticStores(store)
			},
		})
	}

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
	if cfg.EnableChatUI {
		fmt.Println(dimStyle.Render("  knowns browser --open   # Launch Chat UI"))
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

func defaultsForWizard(cwd string, defaults *storage.ProjectDefaults) (string, string, *models.GitTracking, *bool, string, []string) {
	name := filepath.Base(cwd)
	var gitMode string
	var gitTracking *models.GitTracking
	var semanticEnabled *bool
	var semanticModel string
	platforms := defaultInstructionPlatforms()

	if defaults == nil {
		return name, gitMode, gitTracking, semanticEnabled, semanticModel, platforms
	}
	if defaults.ProjectName != "" {
		name = defaults.ProjectName
	}
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
	return name, gitMode, gitTracking, semanticEnabled, semanticModel, platforms
}

func runWizard(cwd string, gitTracked, gitIgnored bool, gitAvailable bool, existingName string, existingGitTrackingMode string, existingGitTracking *models.GitTracking, existingSemanticEnabled *bool, existingSemanticModel string, existingPlatforms []string) (*initConfig, error) {
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

	// --- Group 1: Project name ---
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

	// --- Group 2: Semantic search ---
	cfg.EnableSemantic = true
	cfg.SemanticModel = "multilingual-e5-small"
	if existingSemanticEnabled != nil {
		cfg.EnableSemantic = *existingSemanticEnabled
	}
	if existingSemanticModel != "" {
		cfg.SemanticModel = existingSemanticModel
	}
	// Run form
	groups := []*huh.Group{nameField}
	if gitGroup != nil {
		groups = append(groups, gitGroup)
	}
	cfg.Platforms = normalizeInstructionPlatforms(existingPlatforms)
	groups = append(groups, huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title("Project instruction files").
			Description("KNOWNS.md is always created as a human-readable fallback reference. Choose compatibility shims for agents that read project files.").
			Options(instructionPlatformOptions(cfg.Platforms)...).
			Validate(func(s []string) error {
				if len(s) == 0 {
					return fmt.Errorf("select at least one instruction file")
				}
				return nil
			}).
			Value(&cfg.Platforms),
	))

	form := huh.NewForm(groups...).
		WithTheme(huh.ThemeCatppuccin()).
		WithProgramOptions(tea.WithAltScreen())

	if err := form.Run(); err != nil {
		return nil, err
	}

	// Seed per-section toggles from existing config.
	if existingGitTracking != nil {
		cfg.GitTracking = *existingGitTracking
	} else {
		cfg.GitTracking = models.GitTrackingDefaults()
	}
	if cfg.GitTrackingMode != "none" {
		selected := gitTrackingSelectedSections(&cfg.GitTracking)
		trackingForm := huh.NewForm(
			huh.NewGroup(
				huh.NewMultiSelect[string]().
					Title("Knowns sections to track in git").
					Description("Choose sections under .knowns/ that should be committed.").
					Options(
						huh.NewOption("Tasks", "tasks").Selected(sectionSelected(selected, "tasks")),
						huh.NewOption("Docs", "docs").Selected(sectionSelected(selected, "docs")),
						huh.NewOption("Templates", "templates").Selected(sectionSelected(selected, "templates")),
						huh.NewOption("Decisions", "decisions").Selected(sectionSelected(selected, "decisions")),
						huh.NewOption("Memories", "memories").Selected(sectionSelected(selected, "memories")),
					).
					Value(&selected),
			),
		).WithTheme(huh.ThemeCatppuccin())
		if err := trackingForm.Run(); err != nil {
			return nil, err
		}
		cfg.GitTracking = gitTrackingFromSelectedSections(selected)
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

// downloadCustomHuggingFaceModel downloads ONNX model files from HuggingFace.
func downloadCustomHuggingFaceModel(hfID string) error {
	home, _ := os.UserHomeDir()
	modelDir := filepath.Join(home, ".knowns", "models", hfID)

	// First, find the ONNX file path by listing the repo tree.
	onnxPath, err := findHuggingFaceONNXPath(hfID)
	if err != nil {
		return fmt.Errorf("could not find ONNX model file in %s: %w\nThis model may not have an ONNX export. Try a Xenova/* model instead.", hfID, err)
	}

	// Standard files + discovered ONNX path.
	files := []struct {
		remote   string
		local    string
		optional bool
	}{
		{"config.json", "config.json", false},
		{"tokenizer.json", "tokenizer.json", false},
		{"tokenizer_config.json", "tokenizer_config.json", true},
		{onnxPath, onnxPath, false},
	}

	for _, file := range files {
		dst := filepath.Join(modelDir, file.local)
		if _, err := os.Stat(dst); err == nil {
			continue // already exists
		}

		url := fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", hfID, file.remote)
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return fmt.Errorf("create dir for %s: %w", file.local, err)
		}

		fmt.Printf("    Downloading %s...\n", file.remote)
		_, err := downloadSimple(url, dst)
		if err != nil {
			if file.optional {
				continue
			}
			return fmt.Errorf("download %s: %w", file.remote, err)
		}
	}
	return nil
}

// findHuggingFaceONNXPath finds the ONNX model file path in a HuggingFace repo.
func findHuggingFaceONNXPath(hfID string) (string, error) {
	// Try common paths first without API call.
	commonPaths := []string{
		"onnx/model_quantized.onnx",
		"onnx/model.onnx",
		"model.onnx",
		"model_quantized.onnx",
	}

	client := &http.Client{Timeout: 10 * time.Second}
	for _, p := range commonPaths {
		url := fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", hfID, p)
		req, _ := http.NewRequest("HEAD", url, nil)
		resp, err := client.Do(req)
		if err != nil {
			continue
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			return p, nil
		}
	}

	// Fallback: list repo files via API.
	url := fmt.Sprintf("https://huggingface.co/api/models/%s/tree/main", hfID)
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("list repo files: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("HuggingFace API returned HTTP %d", resp.StatusCode)
	}

	var files []struct {
		Path string `json:"path"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&files); err != nil {
		return "", fmt.Errorf("parse file list: %w", err)
	}

	// Find any .onnx file, prefer quantized.
	var onnxFiles []string
	for _, f := range files {
		if f.Type == "file" && strings.HasSuffix(f.Path, ".onnx") {
			onnxFiles = append(onnxFiles, f.Path)
		}
	}

	if len(onnxFiles) == 0 {
		// Check onnx/ subdirectory.
		subURL := fmt.Sprintf("https://huggingface.co/api/models/%s/tree/main/onnx", hfID)
		subResp, err := client.Get(subURL)
		if err == nil && subResp.StatusCode == 200 {
			var subFiles []struct {
				Path string `json:"path"`
				Type string `json:"type"`
			}
			json.NewDecoder(subResp.Body).Decode(&subFiles)
			subResp.Body.Close()
			for _, f := range subFiles {
				if f.Type == "file" && strings.HasSuffix(f.Path, ".onnx") {
					onnxFiles = append(onnxFiles, f.Path)
				}
			}
		}
	}

	if len(onnxFiles) == 0 {
		return "", fmt.Errorf("no .onnx files found")
	}

	// Prefer quantized > regular.
	for _, f := range onnxFiles {
		if strings.Contains(f, "quantized") {
			return f, nil
		}
	}
	return onnxFiles[0], nil
}

func findEmbeddingModel(id string) *embeddingModelInfo {
	for _, m := range supportedEmbeddingModels {
		if m.ID == id {
			return &m
		}
	}
	return nil
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
	if err := writeInstructionFile(projectRoot, canonicalInstructionFile, "Knowns", force); err != nil {
		return err
	}

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
	if err := writeInstructionFile(projectRoot, canonicalInstructionFile, "Knowns", force); err != nil {
		return err
	}

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
	if fileExists && relativePath != canonicalInstructionFile {
		return syncInstructionMarkerBlock(filePath, content)
	}

	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("could not create %s: %w", relativePath, err)
	}

	return nil
}

func generateInstructionContent(relativePath, platform, projectRoot string) string {
	if relativePath == canonicalInstructionFile {
		return renderCanonicalInstructionContent()
	}

	return renderCompatibilityInstructionContent(relativePath, platform, projectRoot)
}

func renderCanonicalInstructionContent() string {
	var sb strings.Builder
	sb.WriteString("# KNOWNS\n\n")
	sb.WriteString("Human-readable repository guidance for agents working in this project. Runtime-critical AI bootstrap guidance is provided by Knowns MCP `initial` and on-demand `help`.\n\n")
	sb.WriteString("## Table of Contents\n\n")
	sb.WriteString("- [Source of Truth](#source-of-truth)\n")
	sb.WriteString("- [TL;DR](#tldr)\n")
	sb.WriteString("- [Repo Mental Model](#repo-mental-model)\n")
	sb.WriteString("- [How Agents Should Read This File](#how-agents-should-read-this-file)\n")
	sb.WriteString("- [Tool Selection](#tool-selection)\n")
	sb.WriteString("- [Memory Usage](#memory-usage)\n")
	sb.WriteString("- [Critical Rules](#critical-rules)\n")
	sb.WriteString("- [Git Safety](#git-safety)\n")
	sb.WriteString("- [Context Retrieval Strategy](#context-retrieval-strategy)\n")
	sb.WriteString("- [References](#references)\n")
	sb.WriteString("- [Common Mistakes](#common-mistakes)\n")
	sb.WriteString("- [Recommended File Roles](#recommended-file-roles)\n")
	sb.WriteString("- [Compatibility Pattern](#compatibility-pattern)\n")
	sb.WriteString("- [Maintenance Rules](#maintenance-rules)\n\n")
	sb.WriteString("## Source of Truth\n\n")
	sb.WriteString("- MCP `initial` is the primary runtime bootstrap for AI agents.\n")
	sb.WriteString("- MCP `help(\"tool.*\")` and `help(\"workflow.*\")` are the primary on-demand sources for tool schemas and workflow recipes.\n")
	sb.WriteString("- `KNOWNS.md` is a human-readable project reference and fallback when MCP is unavailable.\n")
	sb.WriteString("- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `OPENCODE.md`, and `.github/copilot-instructions.md` are compatibility shims for runtimes that auto-detect those filenames.\n")
	sb.WriteString("- If guidance appears in multiple places, follow this precedence order:\n")
	sb.WriteString("  1. System instructions\n")
	sb.WriteString("  2. Developer instructions\n")
	sb.WriteString("  3. MCP `initial` / `help`\n")
	sb.WriteString("  4. Skills\n")
	sb.WriteString("  5. `KNOWNS.md`\n")
	sb.WriteString("  6. Compatibility shim files\n")
	sb.WriteString("  7. Other repository docs\n\n")
	sb.WriteString("## TL;DR\n\n")
	sb.WriteString("- Call `initial` at session start — it returns project readiness, knowledge counts, code intelligence rules, workflow guidance, and available tools.\n")
	sb.WriteString("- Use `help(\"tool.action\")`, `help(\"tool.*\")`, or `help(\"workflow.*\")` when a domain/action schema is not visible.\n")
	sb.WriteString("- Use Knowns as the memory layer for humans and the AI-friendly working layer for agents.\n")
	sb.WriteString("- Search before reading; read only the sections and docs relevant to the current task.\n")
	sb.WriteString("- Never manually edit Knowns-managed task or doc markdown.\n")
	sb.WriteString("- Prefer Knowns MCP tools; use the `knowns` CLI only as fallback.\n")
	sb.WriteString("- Let skills handle detailed workflows; use this file for rules, conventions, and context routing.\n")
	sb.WriteString("- Validate before marking work complete.\n")
	sb.WriteString("- Do not revert user changes you did not make.\n\n")
	sb.WriteString("## Repo Mental Model\n\n")
	sb.WriteString("- Knowns is the project's memory layer for humans and the AI-friendly operating layer for agents.\n")
	sb.WriteString("- Knowns manages tasks, docs, templates, specs, references, and workflow state in one place.\n")
	sb.WriteString("- Tasks and docs may reference each other using `@task-<id>`, `@doc/<path>`, and `@template/<name>`.\n")
	sb.WriteString("- MCP `initial` defines runtime operating rules; skills define step-by-step execution flows.\n")
	sb.WriteString("- `KNOWNS.md` provides a stable human-readable reference for those conventions.\n")
	sb.WriteString("- Long guidance should be retrieved by section, not blindly injected in full on every request.\n\n")
	sb.WriteString("## How Agents Should Read This File\n\n")
	sb.WriteString("- Prefer MCP `initial` and `help` first. Read this file when MCP guidance is unavailable or deeper project context is needed.\n")
	sb.WriteString("- If reading this file, start with `## Source of Truth` and `## TL;DR`.\n")
	sb.WriteString("- For short or obvious tasks, use the summary sections plus the relevant section only.\n")
	sb.WriteString("- For tool usage questions, read `## Tool Selection` and `## Common Mistakes`.\n")
	sb.WriteString("- For safety-sensitive work, read `## Critical Rules` and `## Git Safety`.\n")
	sb.WriteString("- For large files or docs, read `## Context Retrieval Strategy`.\n")
	sb.WriteString("- For ambiguous requests, search the repo and related docs before asking the user.\n")
	sb.WriteString("- Do not assume the entire file is present in context; retrieve the needed sections when required.\n\n")
	sb.WriteString("## Tool Selection\n\n")
	sb.WriteString("- Call `initial` at session start — it includes project readiness, capabilities, and code intelligence rules.\n")
	sb.WriteString("- Use `help(\"tool.action\")` or `help(\"tool.*\")` for detailed per-action documentation on demand.\n")
	sb.WriteString("- Use Knowns MCP tools first for tasks, docs, templates, validation, and time tracking.\n")
	sb.WriteString("- Use Knowns `code` tools for code discovery, structure, and editing — not built-in Read/Grep/Edit.\n")
	sb.WriteString("- Use shell commands for git, tests, builds, generators, and other terminal operations.\n")
	sb.WriteString("- Prefer targeted retrieval over loading large files in full.\n")
	sb.WriteString("- Use `knowns search` for discovery and quick relevance checks.\n")
	sb.WriteString("- Use MCP `retrieve` tool when a workflow needs structured context with citations and context-pack assembly. Fall back to CLI `knowns retrieve` if MCP is unavailable.\n")
	sb.WriteString("- Prefer `--json` for structured CLI reads consumed by agents, scripts, or workflows, including `get`, `list`, `search`, and `retrieve` commands.\n")
	sb.WriteString("- Prefer `--plain` for human-facing inspection, quick content reads, and logs when JSON is unnecessary.\n")
	sb.WriteString("- Do not rely on styled default CLI output for automation or parsing.\n\n")
	sb.WriteString("### Preferred Tool Matrix\n\n")
	sb.WriteString("- `knowns_*`: canonical operations on tasks, docs, templates, validation, and time.\n")
	sb.WriteString("- `read`: inspect a known file.\n")
	sb.WriteString("- `glob`: find files by path pattern.\n")
	sb.WriteString("- `grep`: locate content by regex.\n")
	sb.WriteString("- `bash`: run git, builds, tests, package managers, or other terminal commands.\n")
	sb.WriteString("- `apply_patch`: make small, explicit file edits.\n")
	sb.WriteString("- `task`: delegate large research or multi-step exploration when useful.\n\n")
	sb.WriteString("## Memory Usage\n\n")
	sb.WriteString("- Session start: `memory({ action: \"list\", layer: \"project\" })` to load accumulated project knowledge.\n")
	sb.WriteString("- After task: `memory({ action: \"add\" })` for reusable patterns, decisions, and conventions (alongside docs).\n")
	sb.WriteString("- Cross-project: `memory({ action: \"promote\" })` to move project knowledge to global (`project→global`).\n")
	sb.WriteString("- Memory complements docs: memory is for fast agent recall, docs are for structured human-readable reference.\n")
	sb.WriteString("- Never duplicate the full doc content into memory — store a summary and reference the doc with `@doc/<path>`.\n")
	sb.WriteString("- During any skill: if you discover a reusable pattern, decision, convention, or failure, save it with `memory({ action: \"add\", layer: \"project\" })`. Capture knowledge as it emerges, don't wait for extraction.\n")
	sb.WriteString("- Proactively save durable memory without waiting for the user to say \"save this\" when confidence is high.\n")
	sb.WriteString("- Use `project` for repo-specific rules, architecture decisions, conventions, recurring failure patterns, and implementation constraints.\n")
	sb.WriteString("- Use `global` for stable user preferences or workflow rules that should carry across repositories and future sessions.\n")
	sb.WriteString("- Ask the user only when the information appears durable but the correct scope (`working`, `project`, or `global`) is genuinely ambiguous.\n")
	sb.WriteString("- After any meaningful user instruction, correction, or newly discovered pattern, quickly evaluate whether it should be stored as memory and save it when appropriate.\n")
	sb.WriteString("- If the user states a stable collaboration preference, default to saving it as `global` memory unless they clearly scoped it to this repository only.\n\n")
	sb.WriteString("## Critical Rules\n\n")
	sb.WriteString("- Never manually edit Knowns-managed task or doc markdown.\n")
	sb.WriteString("- Search first, then read only relevant docs and code.\n")
	sb.WriteString("- Follow `@task-<id>`, `@doc/<path>`, and `@template/<name>` references before acting.\n")
	sb.WriteString("- Use `appendNotes` for progress updates; `notes` replaces existing notes and should only be used intentionally.\n")
	sb.WriteString("- Validate before marking work complete.\n")
	sb.WriteString("- Use skills for detailed workflow execution instead of duplicating step-by-step process here.\n")
	sb.WriteString("- Compatibility shim files must stay lightweight and must direct agents to MCP `initial`/`help` first, with `KNOWNS.md` as fallback reference.\n\n")
	sb.WriteString("## Git Safety\n\n")
	sb.WriteString("- Assume the worktree may already contain user changes.\n")
	sb.WriteString("- Never revert or overwrite unrelated user changes unless explicitly requested.\n")
	sb.WriteString("- Avoid destructive git commands unless explicitly requested.\n")
	sb.WriteString("- Do not amend commits unless explicitly requested.\n")
	sb.WriteString("- Do not create commits unless the user explicitly asks for a commit.\n")
	sb.WriteString("- Do not push unless the user explicitly asks for it.\n\n")
	sb.WriteString("## Context Retrieval Strategy\n\n")
	sb.WriteString("- Treat `KNOWNS.md` as an indexed manual, not a required startup prompt or content to fully inject every time.\n")
	sb.WriteString("- Read in this order when context is limited:\n")
	sb.WriteString("  1. `## Source of Truth`\n")
	sb.WriteString("  2. `## TL;DR`\n")
	sb.WriteString("  3. The section most relevant to the task\n")
	sb.WriteString("- For large or complex tasks, retrieve additional sections on demand.\n")
	sb.WriteString("- Prefer section headings with stable names so tools can target them precisely.\n")
	sb.WriteString("- If a downstream runtime supports startup loading, preload only the top-level summary and fetch deeper sections lazily.\n\n")
	sb.WriteString("## References\n\n")
	sb.WriteString("- Task references use `@task-<id>`.\n")
	sb.WriteString("- Doc references use `@doc/<path>`.\n")
	sb.WriteString("- Template references use `@template/<name>`.\n")
	sb.WriteString("- Doc references support line and range suffixes:\n")
	sb.WriteString("  - `@doc/<path>:42` — link to a specific line.\n")
	sb.WriteString("  - `@doc/<path>:10-25` — link to a line range.\n")
	sb.WriteString("  - `@doc/<path>#heading-slug` — link to a heading anchor.\n")
	sb.WriteString("- Follow references recursively before planning, implementation, or validation work.\n\n")
	sb.WriteString("## Common Mistakes\n\n")
	sb.WriteString("### Notes vs Append Notes\n\n")
	sb.WriteString("- Use `appendNotes` for progress updates and audit trail entries.\n")
	sb.WriteString("- Use `notes` only when intentionally replacing the task's notes content.\n\n")
	sb.WriteString("### CLI Pitfalls\n\n")
	sb.WriteString("- In `task create` and `task edit`, `-a` means `--assignee`, not acceptance criteria.\n")
	sb.WriteString("- In `doc edit`, `-a` means `--append`.\n")
	sb.WriteString("- Use raw task IDs where a command expects an ID value rather than a mention.\n")
	sb.WriteString("- Use `--plain` for read, list, and search commands, not for create or edit commands.\n")
	sb.WriteString("- Use `--json` for structured reads like `get`, `list`, `search`, and `retrieve` when the output will be parsed or fed into an agent workflow.\n")
	sb.WriteString("- Use `--plain` when inspecting manually or when only clean text output is needed.\n")
	sb.WriteString("- Use `--smart` when reading docs through the CLI.\n\n")
	sb.WriteString("### Retrieval Pitfalls\n\n")
	sb.WriteString("- Do not read every doc hoping to find the answer; search first.\n")
	sb.WriteString("- Do not replace discovery-oriented `search` with `retrieve` by default; use `retrieve` only when you need assembled context, citations, or expansion metadata.\n")
	sb.WriteString("- Do not repeatedly list the same tasks or docs if the needed context is already loaded.\n")
	sb.WriteString("- Do not quote large file contents when a concise summary is enough.\n\n")
	sb.WriteString("## Recommended File Roles\n\n")
	sb.WriteString("- `KNOWNS.md`: human-readable repo-level reference and fallback.\n")
	sb.WriteString("- Compatibility shim files: lightweight entrypoints that introduce Knowns and redirect runtimes to MCP `initial`/`help`.\n")
	sb.WriteString("- Other docs: deeper domain, feature, or workflow references.\n\n")
	sb.WriteString("## Compatibility Pattern\n\n")
	sb.WriteString("- Keep shim files short.\n")
	sb.WriteString("- In every shim file, explicitly say MCP `initial` is the primary bootstrap and `KNOWNS.md` is optional fallback/reference.\n")
	sb.WriteString("- Preserve the `<!-- KNOWNS GUIDELINES START -->` and `<!-- KNOWNS GUIDELINES END -->` markers in shim files so tooling can detect and sync them reliably.\n\n")
	sb.WriteString("## Maintenance Rules\n\n")
	sb.WriteString("- Update the Knowns generator when the repository's operational rules change.\n")
	sb.WriteString("- Keep top sections stable so automated loaders can depend on them.\n")
	sb.WriteString("- Prefer adding new sections over bloating the TL;DR.\n")
	sb.WriteString("- Keep workflow details in skills and MCP `help` when possible; keep `KNOWNS.md` focused on human-readable rules, conventions, and routing.\n")

	return sb.String()
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

// maybeOpenBrowser optionally launches the Chat UI after init.
//
//   - --no-open or --no-wizard: skip silently
//   - --open: launch immediately without prompting
//   - default (interactive): show a confirm prompt
//
// maybeOpenBrowser launches the Chat UI only when --open is passed explicitly.
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
	if cwd == "" {
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
	initCmd.Flags().Bool("git-tracked", false, "Track .knowns/ files in git")
	initCmd.Flags().Bool("git-ignored", false, "Add .knowns/ to .gitignore")
	initCmd.Flags().Bool("wizard", false, "Run interactive setup wizard")
	initCmd.Flags().Bool("no-wizard", false, "Skip interactive prompts, use defaults")
	initCmd.Flags().BoolP("force", "f", false, "Force reinitialize even if already initialized")
	initCmd.Flags().Bool("open", false, "Launch Chat UI immediately after init")
	initCmd.Flags().Bool("no-open", false, "Skip the Chat UI launch prompt after init")

	rootCmd.AddCommand(initCmd)
}
