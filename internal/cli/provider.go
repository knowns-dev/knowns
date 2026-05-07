package cli

import (
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var providerCmd = &cobra.Command{
	Use:   "provider",
	Short: "Manage embedding API providers",
	Long:  "Register, list, remove, and test OpenAI-compatible embedding API providers.",
}

var providerAddCmd = &cobra.Command{
	Use:   "add",
	Short: "Register a new embedding provider",
	Long:  "Register an OpenAI-compatible embedding API provider. Tests connectivity before saving.",
	RunE:  runProviderAdd,
}

var providerListCmd = &cobra.Command{
	Use:     "list",
	Aliases: []string{"ls"},
	Short:   "List registered providers",
	RunE:    runProviderList,
}

var providerRemoveCmd = &cobra.Command{
	Use:     "remove [id]",
	Aliases: []string{"rm"},
	Short:   "Remove a provider",
	Args:    cobra.ExactArgs(1),
	RunE:    runProviderRemove,
}

var providerTestCmd = &cobra.Command{
	Use:   "test [id]",
	Short: "Health-check a provider",
	Args:  cobra.ExactArgs(1),
	RunE:  runProviderTest,
}

func runProviderAdd(cmd *cobra.Command, args []string) error {
	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}

	id, _ := cmd.Flags().GetString("id")
	name, _ := cmd.Flags().GetString("name")
	apiBase, _ := cmd.Flags().GetString("api-base")
	apiKey, _ := cmd.Flags().GetString("api-key")

	// Auto-detect Ollama if no flags provided.
	if id == "" && apiBase == "" {
		detector := search.NewOllamaDetector(search.OllamaDefaultBase)
		if running, version := detector.IsRunning(); running {
			fmt.Printf("✓ Detected Ollama %s at %s\n", version, search.OllamaDefaultBase)
			id = "ollama"
			name = "Ollama Local"
			apiBase = search.OllamaDefaultBase + "/v1"
		} else {
			return fmt.Errorf("no --api-base provided and Ollama not detected at %s", search.OllamaDefaultBase)
		}
	}

	if id == "" {
		return fmt.Errorf("--id is required")
	}
	if apiBase == "" {
		return fmt.Errorf("--api-base is required")
	}
	if name == "" {
		name = id
	}

	// Test connectivity before saving.
	fmt.Printf("Testing connectivity to %s...\n", apiBase)
	if err := testProviderConnectivity(apiBase, apiKey); err != nil {
		return fmt.Errorf("connectivity test failed: %w\nProvider not saved.", err)
	}
	fmt.Println("✓ Connection successful")

	provider := storage.EmbeddingProvider{
		Name:   name,
		APIBase: apiBase,
		APIKey: apiKey,
	}
	provider = provider.WithDefaults()

	if err := settings.AddProvider(id, provider); err != nil {
		return err
	}
	if err := settingsStore.Save(settings); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}

	fmt.Printf("✓ Provider %q registered\n", id)
	fmt.Printf("  API Base: %s\n", apiBase)

	// If Ollama, list available embedding models.
	if strings.Contains(apiBase, "11434") || strings.Contains(strings.ToLower(name), "ollama") {
		ollamaBase := strings.TrimSuffix(apiBase, "/v1")
		detector := search.NewOllamaDetector(ollamaBase)
		models, err := detector.ListEmbeddingModels()
		if err == nil && len(models) > 0 {
			fmt.Println("\n  Available embedding models:")
			for _, m := range models {
				fmt.Printf("    • %s (%dd)\n", m.ShortName, m.Dimensions)
			}
			fmt.Printf("\n  Add a model: knowns model add --provider %s --model <name>\n", id)
		}
	}

	return nil
}

func runProviderList(cmd *cobra.Command, args []string) error {
	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}

	if len(settings.Providers) == 0 {
		fmt.Println("No providers registered.")
		fmt.Println("  Add one: knowns provider add --id ollama --api-base http://localhost:11434/v1")
		return nil
	}

	fmt.Println("Embedding Providers")
	fmt.Println(strings.Repeat("─", 50))

	for id, p := range settings.Providers {
		status := "✗ unreachable"
		if err := testProviderConnectivity(p.APIBase, p.APIKey); err == nil {
			status = "✓ reachable"
		}
		fmt.Printf("  %s (%s)\n", id, p.Name)
		fmt.Printf("    API Base: %s\n", p.APIBase)
		fmt.Printf("    Status:   %s\n", status)

		// Count models using this provider.
		modelCount := 0
		for _, m := range settings.Models {
			if m.Provider == id {
				modelCount++
			}
		}
		if modelCount > 0 {
			fmt.Printf("    Models:   %d\n", modelCount)
		}
		fmt.Println()
	}

	return nil
}

func runProviderRemove(cmd *cobra.Command, args []string) error {
	id := args[0]

	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}

	if err := settings.RemoveProvider(id); err != nil {
		return err
	}

	if err := settingsStore.Save(settings); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}

	fmt.Printf("✓ Provider %q removed\n", id)
	return nil
}

func runProviderTest(cmd *cobra.Command, args []string) error {
	id := args[0]

	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}

	provider, err := settings.GetProvider(id)
	if err != nil {
		return err
	}

	fmt.Printf("Testing provider %q (%s)...\n", id, provider.APIBase)

	if err := testProviderConnectivity(provider.APIBase, provider.APIKey); err != nil {
		fmt.Printf("✗ Connection failed: %v\n", err)
		return fmt.Errorf("provider %q is unreachable", id)
	}

	fmt.Printf("✓ Provider %q is reachable\n", id)

	// Try a test embedding to verify model availability.
	for modelID, model := range settings.Models {
		if model.Provider == id {
			fmt.Printf("  Testing model %q (%s)...\n", modelID, model.Model)
			embedder, err := search.NewAPIEmbedder(search.APIEmbedderConfig{
				APIBase:    provider.APIBase,
				APIKey:     provider.APIKey,
				Model:      model.Model,
				Dimensions: model.Dimensions,
				Timeout:    provider.Timeout,
				BatchSize:  provider.BatchSize,
				Retry:      provider.Retry,
			})
			if err != nil {
				fmt.Printf("    ✗ Config error: %v\n", err)
				continue
			}
			if embedder.IsReachable() {
				fmt.Printf("    ✓ Model available (%dd)\n", model.Dimensions)
			} else {
				fmt.Printf("    ✗ Model not available\n")
			}
		}
	}

	return nil
}

// testProviderConnectivity checks if the API base URL is reachable.
func testProviderConnectivity(apiBase, apiKey string) error {
	client := &http.Client{Timeout: 10 * time.Second}

	// Try the embeddings endpoint with a minimal request.
	url := apiBase + "/embeddings"
	req, err := http.NewRequest("POST", url, strings.NewReader(`{"model":"test","input":["hello"]}`))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	// Any response (even 4xx for invalid model) means the server is reachable.
	// Only network errors or timeouts indicate unreachable.
	if resp.StatusCode >= 500 {
		return fmt.Errorf("server error (HTTP %d)", resp.StatusCode)
	}

	return nil
}

func init() {
	providerAddCmd.Flags().String("id", "", "Provider ID (e.g., ollama, openai)")
	providerAddCmd.Flags().String("name", "", "Display name")
	providerAddCmd.Flags().String("api-base", "", "API base URL (e.g., http://localhost:11434/v1)")
	providerAddCmd.Flags().String("api-key", "", "API key (optional for local providers)")

	providerCmd.AddCommand(providerAddCmd)
	providerCmd.AddCommand(providerListCmd)
	providerCmd.AddCommand(providerRemoveCmd)
	providerCmd.AddCommand(providerTestCmd)

	rootCmd.AddCommand(providerCmd)
}
