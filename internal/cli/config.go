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

// --- config toggle ---

var configToggleCmd = &cobra.Command{
	Use:   "toggle",
	Short: "Interactively toggle features on/off",
	RunE:  runConfigToggle,
}

func runConfigToggle(cmd *cobra.Command, args []string) error {
	store := getStore()

	project, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	chatUI := project.Settings.EnableChatUI == nil || *project.Settings.EnableChatUI
	lspEnabled := project.Settings.LSP != nil && project.Settings.LSP.Enabled != nil && *project.Settings.LSP.Enabled
	embeddingEnabled := project.Settings.SemanticSearch != nil && project.Settings.SemanticSearch.Enabled

	// Build status labels
	statusLabel := func(enabled bool) string {
		if enabled {
			return "on"
		}
		return "off"
	}

	var choice string
	options := []huh.Option[string]{
		huh.NewOption(fmt.Sprintf("AI Chat  [%s]", statusLabel(chatUI)), "chat"),
		huh.NewOption(fmt.Sprintf("LSP (Experimental)  [%s]", statusLabel(lspEnabled)), "lsp"),
		huh.NewOption(fmt.Sprintf("Semantic Search  [%s]", statusLabel(embeddingEnabled)), "embedding"),
		huh.NewOption("Done", "done"),
	}

	for {
		choice = ""
		form := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Feature Settings").
					Description("Select a feature to configure").
					Options(options...).
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
		case "chat":
			if err := toggleChatUI(store, &chatUI); err != nil {
				return err
			}
		case "lsp":
			if err := toggleLSP(store, &lspEnabled); err != nil {
				return err
			}
		case "embedding":
			if err := toggleEmbedding(store, project, &embeddingEnabled); err != nil {
				return err
			}
		}

		// Refresh option labels
		options[0] = huh.NewOption(fmt.Sprintf("AI Chat  [%s]", statusLabel(chatUI)), "chat")
		options[1] = huh.NewOption(fmt.Sprintf("LSP (Experimental)  [%s]", statusLabel(lspEnabled)), "lsp")
		options[2] = huh.NewOption(fmt.Sprintf("Semantic Search  [%s]", statusLabel(embeddingEnabled)), "embedding")
	}
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

func toggleLSP(store *storage.Store, lspEnabled *bool) error {
	enabled := *lspEnabled

	form := huh.NewForm(
		huh.NewGroup(
			huh.NewConfirm().
				Title("Enable LSP (Experimental)").
				Description("Language Server Protocol for code intelligence").
				Value(&enabled),
		),
	).WithTheme(huh.ThemeCatppuccin())

	if err := form.Run(); err != nil {
		if err == huh.ErrUserAborted {
			return nil
		}
		return err
	}

	*lspEnabled = enabled
	_ = store.Config.Set("settings.lsp.enabled", enabled)
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
		modelForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Model").
					Placeholder("e.g. gte-small").
					Value(&model),
			),
		).WithTheme(huh.ThemeCatppuccin())

		if err := modelForm.Run(); err != nil {
			if err == huh.ErrUserAborted {
				return nil
			}
			return err
		}

		*embeddingEnabled = true
		_ = store.Config.Set("settings.semanticSearch.enabled", true)
		_ = store.Config.Set("settings.semanticSearch.provider", provider)
		if model != "" {
			_ = store.Config.Set("settings.semanticSearch.model", model)
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
	configResetCmd.Flags().BoolP("yes", "y", false, "Skip confirmation prompt")

	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configSetCmd)
	configCmd.AddCommand(configListCmd)
	configCmd.AddCommand(configResetCmd)
	configCmd.AddCommand(configToggleCmd)

	rootCmd.AddCommand(configCmd)
}
