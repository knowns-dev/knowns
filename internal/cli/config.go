package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/howznguyen/knowns/internal/agents/opencode"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage project configuration",
}

var runSemanticSetupForSettings = runSemanticSetup

type localONNXModelChoice struct {
	Model     *embeddingModel
	Label     string
	Installed bool
}

// --- config get ---

var configGetCmd = &cobra.Command{
	Use:   "get <key>",
	Short: "Get a config value",
	Args:  cobra.ExactArgs(1),
	RunE:  runConfigGet,
}

func runConfigGet(cmd *cobra.Command, args []string) error {
	key := args[0]
	store := getStore()

	val, err := store.Config.Get(key)
	if err != nil {
		// Try with "settings." prefix as shorthand
		if !strings.HasPrefix(key, "settings.") {
			val, err = store.Config.Get("settings." + key)
		}
		if err != nil {
			return fmt.Errorf("config get %q: %w", key, err)
		}
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(val)
		return nil
	}

	if plain {
		fmt.Println(formatConfigValue(val))
	} else {
		fmt.Printf("%s %s %s\n", StyleBold.Render(key), StyleDim.Render("="), formatConfigValue(val))
	}
	return nil
}

// --- config set ---

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a config value",
	Args:  cobra.ExactArgs(2),
	RunE:  runConfigSet,
}

func runConfigSet(cmd *cobra.Command, args []string) error {
	key := args[0]
	rawVal := args[1]
	store := getStore()

	// Try to parse as number, bool, then fall back to string
	var val any
	if i, err := strconv.ParseInt(rawVal, 10, 64); err == nil {
		val = i
	} else if f, err := strconv.ParseFloat(rawVal, 64); err == nil {
		val = f
	} else if b, err := strconv.ParseBool(rawVal); err == nil {
		val = b
	} else {
		val = rawVal
	}

	// Auto-resolve shorthands
	actualKey := key
	switch {
	case key == "lsp":
		// "lsp true" → global LSP toggle
		actualKey = "settings.lsp.enabled"
	case strings.HasPrefix(key, "lsp.") && !strings.Contains(key[4:], "."):
		// "lsp.go true" → per-language toggle
		lang := key[4:]
		actualKey = "settings.lsp.languages." + lang + ".enabled"
	case key == "embedding" || key == "semanticSearch":
		// "embedding true" or "semanticSearch true" → semantic search toggle
		actualKey = "settings.semanticSearch.enabled"
	case !strings.Contains(key, ".") && key != "name" && key != "id":
		actualKey = "settings." + key
	}

	if err := store.Config.Set(actualKey, val); err != nil {
		return fmt.Errorf("config set %q: %w", key, err)
	}

	// Regenerate .gitignore when gitTracking toggles change.
	if strings.HasPrefix(actualKey, "settings.gitTracking.") {
		cwd, err := os.Getwd()
		if err == nil {
			store := getStore()
			project, err := store.Config.Load()
			if err == nil {
				mode := project.Settings.GitTrackingMode
				if mode == "" {
					mode = "git-tracked"
				}
				if err := writeKnownsGitignore(cwd, mode, project.Settings.GitTracking); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to regenerate .gitignore: %v\n", err)
				}
			}
		}
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Set %s = %v", key, rawVal)))
	return nil
}

// --- config list ---

var configListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all config settings",
	RunE:  runConfigList,
}

func runConfigList(cmd *cobra.Command, args []string) error {
	store := getStore()

	project, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	if jsonOut {
		printJSON(project)
		return nil
	}

	if plain {
		fmt.Printf("PROJECT: %s\n", project.Name)
		fmt.Printf("ID: %s\n", project.ID)
		fmt.Printf("settings.defaultAssignee: %s\n", project.Settings.DefaultAssignee)
		fmt.Printf("settings.defaultPriority: %s\n", project.Settings.DefaultPriority)
		fmt.Printf("settings.statuses: %s\n", strings.Join(project.Settings.Statuses, ", "))
		if project.Settings.ServerPort != 0 {
			fmt.Printf("settings.serverPort: %d\n", project.Settings.ServerPort)
		}
		if project.Settings.GitTrackingMode != "" {
			fmt.Printf("settings.gitTrackingMode: %s\n", project.Settings.GitTrackingMode)
		}
		if project.Settings.EnableChatUI != nil {
			fmt.Printf("settings.enableChatUI: %v\n", *project.Settings.EnableChatUI)
		}
		if project.Settings.SemanticSearch != nil {
			fmt.Printf("settings.semanticSearch.enabled: %v\n", project.Settings.SemanticSearch.Enabled)
			if project.Settings.SemanticSearch.Model != "" {
				fmt.Printf("settings.semanticSearch.model: %s\n", project.Settings.SemanticSearch.Model)
			}
			if project.Settings.SemanticSearch.Provider != "" {
				fmt.Printf("settings.semanticSearch.provider: %s\n", project.Settings.SemanticSearch.Provider)
			}
		}
		if project.Settings.LSP != nil {
			if project.Settings.LSP.Enabled != nil {
				fmt.Printf("settings.lsp.enabled: %v\n", *project.Settings.LSP.Enabled)
			}
			for lang, ls := range project.Settings.LSP.Languages {
				if ls.Enabled != nil {
					fmt.Printf("settings.lsp.languages.%s.enabled: %v\n", lang, *ls.Enabled)
				}
				if ls.Binary != "" {
					fmt.Printf("settings.lsp.languages.%s.binary: %s\n", lang, ls.Binary)
				}
				if ls.Backend != "" {
					fmt.Printf("settings.lsp.languages.%s.backend: %s\n", lang, ls.Backend)
				}
				if ls.ProjectPath != "" {
					fmt.Printf("settings.lsp.languages.%s.projectPath: %s\n", lang, ls.ProjectPath)
				}
			}
		}
		if project.Settings.OpenCodeServerConfig != nil {
			oc := project.Settings.OpenCodeServerConfig
			fmt.Printf("settings.opencodeServer.host: %s\n", oc.Host)
			if oc.Port != 0 {
				fmt.Printf("settings.opencodeServer.port: %d\n", oc.Port)
			}
			if oc.Password != "" {
				fmt.Printf("settings.opencodeServer.password: ****\n")
			}
		}
	} else {
		fmt.Printf("%s %s\n\n",
			StyleBold.Render(project.Name),
			StyleDim.Render(fmt.Sprintf("(ID: %s)", project.ID)))
		fmt.Println(RenderSectionHeader("Settings"))
		fmt.Printf("  %s %s\n", StyleDim.Render("defaultAssignee:"), project.Settings.DefaultAssignee)
		fmt.Printf("  %s %s\n", StyleDim.Render("defaultPriority:"), project.Settings.DefaultPriority)
		fmt.Printf("  %s %s\n", StyleDim.Render("statuses:       "), strings.Join(project.Settings.Statuses, ", "))
		if project.Settings.ServerPort != 0 {
			fmt.Printf("  %s %d\n", StyleDim.Render("serverPort:     "), project.Settings.ServerPort)
		}
		if project.Settings.GitTrackingMode != "" {
			fmt.Printf("  %s %s\n", StyleDim.Render("gitTrackingMode:"), project.Settings.GitTrackingMode)
		}
		if project.Settings.TimeFormat != "" {
			fmt.Printf("  %s %s\n", StyleDim.Render("timeFormat:     "), project.Settings.TimeFormat)
		}
		if project.Settings.EnableChatUI != nil {
			fmt.Printf("  %s %v\n", StyleDim.Render("enableChatUI:   "), *project.Settings.EnableChatUI)
		}
		if project.Settings.SemanticSearch != nil {
			fmt.Println(RenderSectionHeader("Semantic Search"))
			fmt.Printf("  %s %v\n", StyleDim.Render("enabled:      "), project.Settings.SemanticSearch.Enabled)
			if project.Settings.SemanticSearch.Model != "" {
				fmt.Printf("  %s %s\n", StyleDim.Render("model:        "), project.Settings.SemanticSearch.Model)
			}
			if project.Settings.SemanticSearch.Provider != "" {
				fmt.Printf("  %s %s\n", StyleDim.Render("provider:     "), project.Settings.SemanticSearch.Provider)
			}
		}
		if project.Settings.LSP != nil {
			fmt.Println(RenderSectionHeader("LSP (Experimental)"))
			if project.Settings.LSP.Enabled != nil {
				fmt.Printf("  %s %v\n", StyleDim.Render("enabled:      "), *project.Settings.LSP.Enabled)
			}
			for lang, ls := range project.Settings.LSP.Languages {
				if ls.Enabled != nil {
					fmt.Printf("  %s %v\n", StyleDim.Render(fmt.Sprintf("%-14s", lang+".enabled:")), *ls.Enabled)
				}
				if ls.Binary != "" {
					fmt.Printf("  %s %s\n", StyleDim.Render(fmt.Sprintf("%-14s", lang+".binary:")), ls.Binary)
				}
				if ls.Backend != "" {
					fmt.Printf("  %s %s\n", StyleDim.Render(fmt.Sprintf("%-14s", lang+".backend:")), ls.Backend)
				}
				if ls.ProjectPath != "" {
					fmt.Printf("  %s %s\n", StyleDim.Render(fmt.Sprintf("%-14s", lang+".project:")), ls.ProjectPath)
				}
			}
		}
		if project.Settings.OpenCodeServerConfig != nil {
			oc := project.Settings.OpenCodeServerConfig
			fmt.Println(RenderSectionHeader("OpenCode Server"))
			if oc.Host != "" {
				fmt.Printf("  %s %s\n", StyleDim.Render("host:         "), oc.Host)
			} else {
				fmt.Printf("  %s %s\n", StyleDim.Render("host:         "), "127.0.0.1 (default)")
			}
			if oc.Port != 0 {
				fmt.Printf("  %s %d\n", StyleDim.Render("port:         "), oc.Port)
			} else {
				fmt.Printf("  %s %d\n", StyleDim.Render("port:         "), 4096)
			}
			if oc.Password != "" {
				fmt.Printf("  %s ****\n", StyleDim.Render("password:     "))
			}
		}
	}
	return nil
}

// formatConfigValue converts a config value to its string representation.
func formatConfigValue(v any) string {
	if v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case int, int64:
		return fmt.Sprintf("%v", x)
	case []any:
		strs := make([]string, 0, len(x))
		for _, item := range x {
			strs = append(strs, formatConfigValue(item))
		}
		return strings.Join(strs, ", ")
	default:
		data, _ := json.Marshal(v)
		return string(data)
	}
}

// --- config reset ---

var configResetCmd = &cobra.Command{
	Use:   "reset",
	Short: "Reset config to defaults",
	RunE:  runConfigReset,
}

func runConfigReset(cmd *cobra.Command, args []string) error {
	yes, _ := cmd.Flags().GetBool("yes")
	store := getStore()

	if !yes {
		answer := ""
		fmt.Print("Reset config to defaults? This cannot be undone. (y/n): ")
		fmt.Scanln(&answer)
		if answer != "y" && answer != "yes" {
			fmt.Println("Aborted.")
			return nil
		}
	}

	// Load current config to preserve the project name
	project, err := store.Config.Load()
	name := "knowns"
	if err == nil && project.Name != "" {
		name = project.Name
	}

	// Re-initialize default config
	if err := store.Config.Set("settings", nil); err != nil {
		// Fall back: reinit the whole config
		_ = err
	}

	// Write a fresh default config preserving the project name
	defaultSettings := models.DefaultProjectSettings()
	project = &models.Project{
		Name:     name,
		ID:       project.ID,
		Settings: defaultSettings,
	}
	if err := store.Config.Save(project); err != nil {
		return fmt.Errorf("reset config: %w", err)
	}

	fmt.Println(RenderSuccess("Config reset to defaults."))
	return nil
}

// --- settings ---

var settingsCmd = &cobra.Command{
	Use:   "settings",
	Short: "Open interactive project settings",
	RunE:  runSettings,
}

func runSettings(cmd *cobra.Command, args []string) error {
	global, _ := cmd.Flags().GetBool("global")
	if global {
		return runGlobalSettings()
	}

	store := getStore()

	project, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	var choice string
	for {
		choice = ""
		form := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Project Settings").
					Description(fmt.Sprintf("Current project: %s", project.Name)).
					Options(
						huh.NewOption("Project", "project"),
						huh.NewOption("Git Tracking", "git"),
						huh.NewOption("AI Platforms", "platforms"),
						huh.NewOption("Search", "search"),
						huh.NewOption("Code Intelligence", "code"),
						huh.NewOption("Browser / Chat UI", "chat"),
						huh.NewOption("Maintenance", "maintenance"),
						huh.NewOption("Done", "done"),
					).
					Value(&choice),
			),
		).WithTheme(huh.ThemeCatppuccin())

		if err := form.Run(); err != nil {
			if err == huh.ErrUserAborted {
				fmt.Println("Aborted.")
				return nil
			}
			return err
		}

		switch choice {
		case "done":
			fmt.Println(RenderSuccess("Settings saved."))
			return nil
		case "project":
			if err := configureProjectIdentity(store, project); err != nil {
				return err
			}
		case "git":
			if err := configureGitTracking(store, project); err != nil {
				return err
			}
		case "platforms":
			if err := configurePlatforms(store, project); err != nil {
				return err
			}
		case "search":
			embeddingEnabled := project.Settings.SemanticSearch != nil && project.Settings.SemanticSearch.Enabled
			if err := toggleEmbedding(store, project, &embeddingEnabled); err != nil {
				return err
			}
		case "code":
			if err := configureCodeIntelligence(store, project); err != nil {
				return err
			}
		case "chat":
			chatUI := project.Settings.EnableChatUI == nil || *project.Settings.EnableChatUI
			if err := toggleChatUI(store, &chatUI); err != nil {
				return err
			}
		case "maintenance":
			if err := showSettingsMaintenance(project); err != nil {
				return err
			}
		}
		project, err = store.Config.Load()
		if err != nil {
			return fmt.Errorf("reload config: %w", err)
		}
	}
}

func runGlobalSettings() error {
	embStore := storage.NewEmbeddingSettingsStore()
	settings, err := embStore.Load()
	if err != nil {
		return err
	}
	if settings.ProjectDefaults == nil {
		settings.ProjectDefaults = &storage.ProjectDefaults{
			Settings: models.DefaultProjectSettings(),
		}
	}

	var choice string
	for {
		choice = ""
		form := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Global Settings").
					Description("Defaults for new projects created by knowns init").
					Options(
						huh.NewOption("Project Defaults", "project"),
						huh.NewOption("Default Git Tracking", "git"),
						huh.NewOption("Default AI Platforms", "platforms"),
						huh.NewOption("Default Search", "search"),
						huh.NewOption("Default Code Intelligence", "code"),
						huh.NewOption("Default Browser / Chat UI", "chat"),
						huh.NewOption("Done", "done"),
					).
					Value(&choice),
			),
		).WithTheme(huh.ThemeCatppuccin())

		if err := form.Run(); err != nil {
			if err == huh.ErrUserAborted {
				fmt.Println("Aborted.")
				return nil
			}
			return err
		}

		defaults := settings.ProjectDefaults
		switch choice {
		case "done":
			if err := embStore.Save(settings); err != nil {
				return err
			}
			fmt.Println(RenderSuccess("Global settings saved."))
			fmt.Println(RenderHint("Run: knowns init to use these defaults in a new project."))
			return nil
		case "project":
			name := defaults.ProjectName
			form := huh.NewForm(huh.NewGroup(
				huh.NewInput().
					Title("Default project name").
					Description("Leave blank to use the directory name.").
					Value(&name),
			)).WithTheme(huh.ThemeCatppuccin())
			if err := form.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return nil
				}
				return err
			}
			defaults.ProjectName = strings.TrimSpace(name)
		case "git":
			if err := configureGitTrackingSettings(&defaults.Settings); err != nil {
				return err
			}
		case "platforms":
			if err := configurePlatformSettings(&defaults.Settings); err != nil {
				return err
			}
		case "search":
			if err := configureSemanticDefaults(&defaults.Settings); err != nil {
				return err
			}
		case "code":
			if err := configureLSPSettings(&defaults.Settings); err != nil {
				return err
			}
		case "chat":
			enabled := defaults.Settings.EnableChatUI == nil || *defaults.Settings.EnableChatUI
			form := huh.NewForm(huh.NewGroup(
				huh.NewConfirm().
					Title("Enable Chat UI by default").
					Value(&enabled),
			)).WithTheme(huh.ThemeCatppuccin())
			if err := form.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return nil
				}
				return err
			}
			defaults.Settings.EnableChatUI = &enabled
		}
		if err := embStore.Save(settings); err != nil {
			return err
		}
	}
}

func configureProjectIdentity(store *storage.Store, project *models.Project) error {
	name := project.Name
	form := huh.NewForm(huh.NewGroup(
		huh.NewInput().
			Title("Project name").
			Value(&name).
			Validate(func(s string) error {
				if strings.TrimSpace(s) == "" {
					return fmt.Errorf("project name is required")
				}
				return nil
			}),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	project.Name = strings.TrimSpace(name)
	return store.Config.Save(project)
}

func configureGitTracking(store *storage.Store, project *models.Project) error {
	if err := configureGitTrackingSettings(&project.Settings); err != nil {
		return err
	}
	if err := store.Config.Save(project); err != nil {
		return err
	}
	cwd, err := os.Getwd()
	if err != nil {
		return nil
	}
	return writeKnownsGitignore(cwd, project.Settings.GitTrackingMode, project.Settings.GitTracking)
}

func configureGitTrackingSettings(settings *models.ProjectSettings) error {
	mode := settings.GitTrackingMode
	if mode == "" {
		mode = "git-tracked"
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewSelect[string]().
			Title("Git tracking mode").
			Options(
				huh.NewOption("Git Tracked", "git-tracked"),
				huh.NewOption("Git Ignored", "git-ignored"),
				huh.NewOption("None", "none"),
			).
			Value(&mode),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	settings.GitTrackingMode = mode
	if mode == "none" {
		settings.GitTracking = nil
		return nil
	}
	tracking := models.GitTrackingDefaults()
	if settings.GitTracking != nil {
		tracking = *settings.GitTracking
	}
	selected := gitTrackingSelectedSections(&tracking)
	sectionForm := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title("Knowns sections to track in git").
			Options(
				huh.NewOption("Tasks", "tasks").Selected(sectionSelected(selected, "tasks")),
				huh.NewOption("Docs", "docs").Selected(sectionSelected(selected, "docs")),
				huh.NewOption("Templates", "templates").Selected(sectionSelected(selected, "templates")),
				huh.NewOption("Decisions", "decisions").Selected(sectionSelected(selected, "decisions")),
				huh.NewOption("Memories", "memories").Selected(sectionSelected(selected, "memories")),
			).
			Value(&selected),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := sectionForm.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	tracking = gitTrackingFromSelectedSections(selected)
	settings.GitTracking = &tracking
	return nil
}

func configurePlatforms(store *storage.Store, project *models.Project) error {
	if err := configurePlatformSettings(&project.Settings); err != nil {
		return err
	}
	if err := store.Config.Save(project); err != nil {
		return err
	}
	fmt.Println(RenderHint("Run: knowns sync to apply platform changes to generated files."))
	return nil
}

func configurePlatformSettings(settings *models.ProjectSettings) error {
	selected := settings.Platforms
	if len(selected) == 0 {
		selected = []string{"claude-code", "agents"}
	}
	options := make([]huh.Option[string], 0, len(wizardPlatformIDs))
	for _, id := range wizardPlatformIDs {
		options = append(options, huh.NewOption(platformLabel(id), id).Selected(sectionSelected(selected, id)))
	}
	form := huh.NewForm(huh.NewGroup(
		huh.NewMultiSelect[string]().
			Title("AI platforms").
			Description("Select generated instruction and integration targets.").
			Options(options...).
			Value(&selected),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	settings.Platforms = selected
	return nil
}

func configureCodeIntelligence(store *storage.Store, project *models.Project) error {
	if err := configureLSPSettings(&project.Settings); err != nil {
		return err
	}
	if err := store.Config.Save(project); err != nil {
		return err
	}
	fmt.Println(RenderHint("Run: knowns lsp status for missing server install guidance."))
	return nil
}

func configureSemanticDefaults(settings *models.ProjectSettings) error {
	enabled := settings.SemanticSearch != nil && settings.SemanticSearch.Enabled
	provider := "local"
	model := "multilingual-e5-small"
	if settings.SemanticSearch != nil {
		if settings.SemanticSearch.Provider != "" {
			provider = settings.SemanticSearch.Provider
		}
		if settings.SemanticSearch.Model != "" {
			model = settings.SemanticSearch.Model
		}
	}

	providerForm := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Enable semantic search by default").
				Value(&enabled),
		),
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Default provider").
				Options(
					huh.NewOption("Local ONNX (offline)", "local"),
					huh.NewOption("Ollama (local API)", "ollama"),
					huh.NewOption("API (OpenAI-compatible)", "api"),
				).
				Value(&provider),
		).WithHideFunc(func() bool { return !enabled }),
	).WithTheme(huh.ThemeCatppuccin())
	if err := providerForm.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	if !enabled {
		settings.SemanticSearch = &models.SemanticSearchSettings{Enabled: false, Model: model, Provider: provider}
		return nil
	}
	if provider != "local" {
		modelForm := huh.NewForm(huh.NewGroup(
			huh.NewInput().
				Title("Default model").
				Value(&model),
		)).WithTheme(huh.ThemeCatppuccin())
		if err := modelForm.Run(); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}
	}
	ss := &models.SemanticSearchSettings{Enabled: true, Provider: provider, Model: model}
	if provider == "local" {
		if err := selectLocalONNXModel(&model); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}
		selected := findSupportedModel(model)
		if selected == nil {
			return fmt.Errorf("unknown local ONNX model %q", model)
		}
		if !isModelInstalled(selected) {
			download := false
			confirmForm := huh.NewForm(huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Download %s now?", selected.ID)).
					Description("Global defaults can use a missing model, but downloading now prepares this machine for future projects.").
					Value(&download),
			)).WithTheme(huh.ThemeCatppuccin())
			if err := confirmForm.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return nil
				}
				return err
			}
			if download {
				if err := runSemanticSetupForSettings(selected.ID, false); err != nil {
					return err
				}
			}
		}
		ss = semanticSettingsForLocalONNX(selected)
	}
	settings.SemanticSearch = ss
	return nil
}

func configureLSPSettings(settings *models.ProjectSettings) error {
	if settings.LSP == nil {
		settings.LSP = &models.LSPSettings{Languages: map[string]models.LSPLanguageSettings{}}
	}
	enabled := settings.LSP.Enabled != nil && *settings.LSP.Enabled
	form := huh.NewForm(huh.NewGroup(
		huh.NewConfirm().
			Title("Enable code intelligence").
			Description("Language servers power code symbols, references, and diagnostics.").
			Value(&enabled),
	)).WithTheme(huh.ThemeCatppuccin())
	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}
	settings.LSP.Enabled = &enabled
	if settings.LSP.Languages == nil {
		settings.LSP.Languages = map[string]models.LSPLanguageSettings{}
	}
	for _, id := range []string{"go", "typescript", "python", "rust", "c_cpp", "java", "csharp", "ruby", "php"} {
		lang := settings.LSP.Languages[id]
		if lang.Enabled == nil {
			lang.Enabled = &enabled
		}
		settings.LSP.Languages[id] = lang
	}
	return nil
}

func showSettingsMaintenance(project *models.Project) error {
	fmt.Println(RenderSectionHeader("Maintenance"))
	fmt.Println(RenderHint("Run: knowns sync to apply generated files, git rules, models, and MCP configs."))
	if project.Settings.SemanticSearch != nil && project.Settings.SemanticSearch.Enabled {
		fmt.Println(RenderHint("Run: knowns search --reindex after changing search settings."))
	}
	fmt.Println(RenderHint("Run: knowns config list --plain for scriptable inspection."))
	return nil
}

func localONNXModelChoices(currentModel string) []localONNXModelChoice {
	choices := make([]localONNXModelChoice, 0, len(supportedModels))
	for i := range supportedModels {
		m := &supportedModels[i]
		installed := isModelInstalled(m)
		status := "not downloaded"
		if installed {
			status = "downloaded"
		}
		current := ""
		if currentModel == m.ID {
			current = ", current"
		}
		choices = append(choices, localONNXModelChoice{
			Model:     m,
			Installed: installed,
			Label: fmt.Sprintf("%s - %s (%dd, %d tokens, %dMB, %s%s)",
				m.ID, m.Name, m.Dimensions, m.MaxTokens, m.SizeMB, status, current),
		})
	}
	return choices
}

func localONNXModelSelectOptions(currentModel string) []huh.Option[string] {
	choices := localONNXModelChoices(currentModel)
	options := make([]huh.Option[string], 0, len(choices))
	for _, choice := range choices {
		options = append(options, huh.NewOption(choice.Label, choice.Model.ID))
	}
	return options
}

func selectLocalONNXModel(model *string) error {
	if model == nil {
		return fmt.Errorf("model value is required")
	}
	if findSupportedModel(*model) == nil {
		*model = "multilingual-e5-small"
	}
	modelForm := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Local ONNX model").
				Description("Downloaded models are ready for offline semantic search. Missing models can be downloaded after selection.").
				Options(localONNXModelSelectOptions(*model)...).
				Value(model),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := modelForm.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return err
		}
		return err
	}
	return nil
}

func semanticSettingsForLocalONNX(model *embeddingModel) *models.SemanticSearchSettings {
	return &models.SemanticSearchSettings{
		Enabled:       true,
		Provider:      "local",
		Model:         model.ID,
		HuggingFaceID: model.HuggingFace,
		Dimensions:    model.Dimensions,
		MaxTokens:     model.MaxTokens,
	}
}

func saveLocalONNXSemanticSettings(store *storage.Store, project *models.Project, model *embeddingModel) error {
	if store == nil {
		return fmt.Errorf("store is required")
	}
	if project == nil {
		return fmt.Errorf("project is required")
	}
	project.Settings.SemanticSearch = semanticSettingsForLocalONNX(model)
	return store.Config.Save(project)
}

func applyLocalONNXSelection(store *storage.Store, project *models.Project, modelID string, confirmDownload func(*embeddingModel) (bool, error)) (bool, error) {
	selected := findSupportedModel(modelID)
	if selected == nil {
		return false, fmt.Errorf("unknown local ONNX model %q", modelID)
	}
	if !isModelInstalled(selected) {
		download, err := confirmDownload(selected)
		if err != nil {
			return false, err
		}
		if !download {
			fmt.Println(RenderWarning(fmt.Sprintf("Kept previous Local ONNX model; %q was not downloaded.", selected.ID)))
			fmt.Println(RenderHint("Run: " + RenderCmd(fmt.Sprintf("knowns model download %s", selected.ID)) + " and select it again."))
			return false, nil
		}
		if err := runSemanticSetupForSettings(selected.ID, false); err != nil {
			return false, err
		}
	}
	if err := saveLocalONNXSemanticSettings(store, project, selected); err != nil {
		return false, err
	}
	return true, nil
}

func toggleChatUI(store *storage.Store, chatUI *bool) error {
	// Check if OpenCode is installed
	status := opencode.DetectOpenCode()
	if !status.Installed {
		*chatUI = false
		_ = store.Config.Set("settings.enableChatUI", false)
		fmt.Println(StyleDim.Render("  OpenCode CLI not found. AI Chat disabled."))
		fmt.Println(StyleDim.Render("  Install: https://opencode.ai"))
		return nil
	}
	if !status.Compatible {
		fmt.Println(StyleDim.Render(fmt.Sprintf("  OpenCode %s found (requires >= %s)", status.Version, status.MinVersion)))
	}

	var enabled bool
	var host string
	var port int
	var password string

	enabled = *chatUI

	// Load current values
	project, _ := store.Config.Load()
	if project.Settings.OpenCodeServerConfig != nil {
		host = project.Settings.OpenCodeServerConfig.Host
		port = project.Settings.OpenCodeServerConfig.Port
		password = project.Settings.OpenCodeServerConfig.Password
	}
	if host == "" {
		host = "127.0.0.1"
	}
	if port == 0 {
		port = 4096
	}

	portStr := strconv.Itoa(port)

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Enable AI Chat").
				Description(fmt.Sprintf("OpenCode %s detected", status.Version)).
				Value(&enabled),
		),
		huh.NewGroup(
			huh.NewInput().
				Title("OpenCode Host").
				Value(&host),
			huh.NewInput().
				Title("OpenCode Port").
				Value(&portStr),
			huh.NewInput().
				Title("OpenCode Password").
				Value(&password).
				EchoMode(huh.EchoModePassword),
		).WithHideFunc(func() bool { return !enabled }),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}

	*chatUI = enabled
	_ = store.Config.Set("settings.enableChatUI", enabled)

	if enabled {
		_ = store.Config.Set("settings.opencodeServer.host", host)
		if p, err := strconv.Atoi(portStr); err == nil {
			_ = store.Config.Set("settings.opencodeServer.port", p)
		}
		if password != "" {
			_ = store.Config.Set("settings.opencodeServer.password", password)
		}
	}
	return nil
}

func toggleEmbedding(store *storage.Store, project *models.Project, embeddingEnabled *bool) error {
	enabled := *embeddingEnabled
	model := ""
	provider := "local"

	if project.Settings.SemanticSearch != nil {
		model = project.Settings.SemanticSearch.Model
		if project.Settings.SemanticSearch.Provider != "" {
			provider = project.Settings.SemanticSearch.Provider
		}
	}

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Enable Semantic Search").
				Description("Embedding-based search for docs and code").
				Value(&enabled),
		),
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Provider").
				Options(
					huh.NewOption("Local ONNX (offline)", "local"),
					huh.NewOption("Ollama (local API)", "ollama"),
					huh.NewOption("API (OpenAI, etc.)", "api"),
				).
				Value(&provider),
		).WithHideFunc(func() bool { return !enabled }),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}

	if !enabled {
		*embeddingEnabled = false
		_ = store.Config.Set("settings.semanticSearch.enabled", false)
		return nil
	}

	// Handle Ollama provider: detect and list embedding models
	if provider == "ollama" {
		detector := search.NewOllamaDetector(search.OllamaDefaultBase)
		running, version := detector.IsRunning()
		if !running {
			fmt.Println(StyleDim.Render("  Ollama not detected at " + search.OllamaDefaultBase))
			fmt.Println(StyleDim.Render("  Start Ollama first, then retry."))
			return nil
		}
		fmt.Println(StyleDim.Render(fmt.Sprintf("  Ollama %s detected", version)))

		embModels, err := detector.ListEmbeddingModels()
		if err != nil || len(embModels) == 0 {
			fmt.Println(StyleDim.Render("  No embedding models found in Ollama."))
			fmt.Println(StyleDim.Render("  Pull one: ollama pull nomic-embed-text"))
			return nil
		}

		modelOptions := make([]huh.Option[string], len(embModels))
		for i, m := range embModels {
			label := fmt.Sprintf("%s (%dd)", m.Name, m.Dimensions)
			modelOptions[i] = huh.NewOption(label, m.Name)
		}

		modelForm := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Select Embedding Model").
					Options(modelOptions...).
					Value(&model),
			),
		).WithTheme(huh.ThemeCatppuccin())

		if err := modelForm.Run(); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}

		provider = "ollama"
		_ = store.Config.Set("settings.semanticSearch.enabled", true)
		_ = store.Config.Set("settings.semanticSearch.provider", provider)
		_ = store.Config.Set("settings.semanticSearch.model", model)
		*embeddingEnabled = true

		// Register model in ~/.knowns/settings.json so sync can find it
		embStore := storage.NewEmbeddingSettingsStore()
		embSettings, _ := embStore.Load()
		// Find dimensions from the selected model
		var dims int
		for _, m := range embModels {
			if m.Name == model {
				dims = m.Dimensions
				break
			}
		}
		embSettings.Models[model] = storage.EmbeddingModel{
			Provider:   "ollama",
			Model:      model,
			Dimensions: dims,
		}
		// Ensure ollama provider is registered
		if _, exists := embSettings.Providers["ollama"]; !exists {
			embSettings.Providers["ollama"] = storage.EmbeddingProvider{
				Name:      "Ollama Local",
				APIBase:   search.OllamaDefaultBase + "/v1",
				Timeout:   30,
				BatchSize: 64,
				Retry:     storage.RetryConfig{MaxRetries: 3, InitialDelay: 1000, MaxDelay: 30000},
			}
		}
		_ = embStore.Save(embSettings)
		return nil
	}

	// Local ONNX
	if provider == "local" {
		if err := selectLocalONNXModel(&model); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}

		saved, err := applyLocalONNXSelection(store, project, model, func(selected *embeddingModel) (bool, error) {
			download := false
			confirmForm := huh.NewForm(huh.NewGroup(
				huh.NewConfirm().
					Title(fmt.Sprintf("Download %s now?", selected.ID)).
					Description(fmt.Sprintf("%s is not downloaded. Download it before saving this Local ONNX setting.", selected.Name)).
					Value(&download),
			)).WithTheme(huh.ThemeCatppuccin())
			if err := confirmForm.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return false, nil
				}
				return false, err
			}
			return download, nil
		})
		if err != nil {
			return err
		}
		if saved {
			*embeddingEnabled = true
		}
		return nil
	}

	// Generic API provider: retry loop for URL/key/model/dimensions
	apiBase := ""
	apiKey := ""

	// Load existing provider settings if available
	embStore := storage.NewEmbeddingSettingsStore()
	embSettings, _ := embStore.Load()
	if p, err := embSettings.GetProvider("api"); err == nil {
		apiBase = p.APIBase
		apiKey = p.APIKey
	}

	for {
		// Step 1: Ask for API base URL and key
		apiForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("API Base URL (embeddings endpoint)").
					Placeholder("e.g. https://llms.knowns.dev/v1/embeddings").
					Value(&apiBase),
				huh.NewInput().
					Title("API Key").
					Placeholder("sk-...").
					Value(&apiKey).
					EchoMode(huh.EchoModePassword),
			),
		).WithTheme(huh.ThemeCatppuccin())

		if err := apiForm.Run(); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}

		if apiBase == "" {
			fmt.Println(StyleDim.Render("  API Base URL is required."))
			continue
		}

		// Save API key to ~/.knowns/settings.json (never in project config)
		embSettings.Providers["api"] = storage.EmbeddingProvider{
			Name:    "API Provider",
			APIBase: apiBase,
			APIKey:  apiKey,
		}
		_ = embStore.Save(embSettings)

		// Step 2: Try to list models, or ask manually
		fmt.Println(StyleDim.Render("  Fetching models..."))
		apiModels, err := listAPIModels(apiBase, apiKey)
		if err != nil {
			fmt.Println(StyleDim.Render(fmt.Sprintf("  Could not list models: %v", err)))

			modelForm := huh.NewForm(
				huh.NewGroup(
					huh.NewInput().
						Title("Model name").
						Placeholder("e.g. openrouter/nvidia/llama-nemotron-embed-vl-1b-v2:free").
						Value(&model),
				),
			).WithTheme(huh.ThemeCatppuccin())

			if err := modelForm.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return nil
				}
				return err
			}
		} else if len(apiModels) > 0 {
			modelOptions := make([]huh.Option[string], len(apiModels))
			for i, m := range apiModels {
				modelOptions[i] = huh.NewOption(m, m)
			}

			modelForm := huh.NewForm(
				huh.NewGroup(
					huh.NewSelect[string]().
						Title("Select Model").
						Options(modelOptions...).
						Value(&model),
				),
			).WithTheme(huh.ThemeCatppuccin())

			if err := modelForm.Run(); err != nil {
				if err == huh.ErrUserAborted {
					return nil
				}
				return err
			}
		}

		if model == "" {
			fmt.Println(StyleDim.Render("  Model name is required."))
			continue
		}

		// Step 3: Test embedding to detect dimensions
		fmt.Println(StyleDim.Render("  Testing embedding..."))
		dims := detectEmbeddingDimensions(apiBase, apiKey, model)
		if dims == 0 {
			fmt.Println(StyleDim.Render("  Failed. Check URL, key, and model name."))
			fmt.Println()
			continue
		}

		fmt.Println(StyleDim.Render(fmt.Sprintf("  Success! Dimensions: %d", dims)))

		// Save everything
		*embeddingEnabled = true
		_ = store.Config.Set("settings.semanticSearch.enabled", true)
		_ = store.Config.Set("settings.semanticSearch.provider", provider)
		_ = store.Config.Set("settings.semanticSearch.model", model)

		embSettings.Models[model] = storage.EmbeddingModel{
			Provider:   "api",
			Model:      model,
			Dimensions: dims,
		}
		_ = embStore.Save(embSettings)
		return nil
	}
}

// detectEmbeddingDimensions calls the embedding API with a test input to determine vector size.
func detectEmbeddingDimensions(baseURL, apiKey, model string) int {
	url := strings.TrimRight(baseURL, "/")

	payload, _ := json.Marshal(map[string]any{
		"model": model,
		"input": "test",
	})

	req, err := http.NewRequest("POST", url, strings.NewReader(string(payload)))
	if err != nil {
		return 0
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println(StyleDim.Render(fmt.Sprintf("  Connection error: %v", err)))
		return 0
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0
	}

	if resp.StatusCode != http.StatusOK {
		// Show API error to help user debug
		var errResp struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &errResp) == nil && errResp.Error.Message != "" {
			fmt.Println(StyleDim.Render(fmt.Sprintf("  API error: %s", errResp.Error.Message)))
		} else {
			fmt.Println(StyleDim.Render(fmt.Sprintf("  API returned HTTP %d", resp.StatusCode)))
		}
		return 0
	}

	var result struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0
	}

	if len(result.Data) > 0 {
		return len(result.Data[0].Embedding)
	}
	return 0
}

// listAPIModels fetches available embedding models from an OpenAI-compatible API.
// Appends /models to the base URL.
func listAPIModels(baseURL, apiKey string) ([]string, error) {
	url := strings.TrimRight(baseURL, "/") + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result struct {
		Data []struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	names := make([]string, 0, len(result.Data))
	for _, m := range result.Data {
		id := strings.ToLower(m.ID)
		// Filter: only embedding models
		if m.Type == "embedding" ||
			strings.Contains(id, "embed") ||
			strings.Contains(id, "embedding") {
			names = append(names, m.ID)
		}
	}
	return names, nil
}

func init() {
	settingsCmd.Flags().Bool("global", false, "Edit global defaults for future knowns init runs")

	configResetCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompt")

	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configListCmd)
	configCmd.AddCommand(configResetCmd)

	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(settingsCmd)
}
