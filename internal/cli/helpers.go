package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

// getStore finds the project root and returns a Store instance.
// On error it prints to stderr and exits.
func getStore() *storage.Store {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot determine working directory: %v\n", err)
		os.Exit(1)
	}
	root, err := storage.FindProjectRoot(cwd)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintf(os.Stderr, "Run 'knowns init' to initialize a project.\n")
		os.Exit(1)
	}
	return storage.NewStore(root)
}

// getStoreErr finds the project root and returns a Store instance, or an error.
func getStoreErr() (*storage.Store, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("cannot determine working directory: %w", err)
	}
	root, err := storage.FindProjectRoot(cwd)
	if err != nil {
		return nil, err
	}
	return storage.NewStore(root), nil
}

// isPlain returns true if the --plain flag is set.
func isPlain(cmd *cobra.Command) bool {
	v, _ := cmd.Flags().GetBool("plain")
	if v {
		return true
	}
	// also check persistent flags on ancestors
	v, _ = cmd.Root().PersistentFlags().GetBool("plain")
	return v
}

// isJSON returns true if the --json flag is set.
func isJSON(cmd *cobra.Command) bool {
	v, _ := cmd.Flags().GetBool("json")
	if v {
		return true
	}
	v, _ = cmd.Root().PersistentFlags().GetBool("json")
	return v
}

// printJSON marshals v to indented JSON and prints it.
func printJSON(v any) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
		return
	}
	fmt.Println(string(data))
}

// formatDuration formats a duration in seconds to a human-readable string.
func formatDuration(seconds int) string {
	if seconds <= 0 {
		return "0m"
	}
	h := seconds / 3600
	m := (seconds % 3600) / 60
	s := seconds % 60
	if h > 0 && m > 0 {
		return fmt.Sprintf("%dh %dm", h, m)
	} else if h > 0 {
		return fmt.Sprintf("%dh", h)
	} else if m > 0 && s > 0 {
		return fmt.Sprintf("%dm %ds", m, s)
	} else if m > 0 {
		return fmt.Sprintf("%dm", m)
	}
	return fmt.Sprintf("%ds", s)
}

// joinStrings joins a slice of strings with the given separator.
func joinStrings(ss []string, sep string) string {
	return strings.Join(ss, sep)
}

// isPagerDisabled returns true if pager is disabled via flag or env var.
func isPagerDisabled(cmd any) bool {
	if c, ok := cmd.(*cobra.Command); ok {
		v, _ := c.Flags().GetBool("no-pager")
		if v {
			return true
		}
		v, _ = c.Root().PersistentFlags().GetBool("no-pager")
		if v {
			return true
		}
	}
	return os.Getenv("KNOWNS_NO_PAGER") != ""
}

// splitCSV splits a comma-separated string into trimmed parts.
func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	result := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			result = append(result, p)
		}
	}
	return result
}

// unescapeText replaces literal \n and \t sequences with actual newlines and tabs.
// This handles the common case where shell passes "line1\nline2" as literal characters.
func unescapeText(s string) string {
	s = strings.ReplaceAll(s, `\n`, "\n")
	s = strings.ReplaceAll(s, `\t`, "\t")
	return s
}

func getLSPManagerForRoot(root string) *lsp.Manager {
	store := storage.NewStore(root)
	project, _ := store.Config.Load()
	manager := lsp.NewManager(root, lspConfigWithGlobalDefaults(project))
	for _, adapter := range adapters.All() {
		if err := manager.RegisterAdapter(adapter); err != nil {
			fmt.Fprintf(os.Stderr, "warn: could not register LSP adapter %s: %v\n", adapter.ID(), err)
		}
	}
	for _, loadErr := range manager.RegisterPluginAdapters(lsp.PluginAdapterLoadOptions{}) {
		fmt.Fprintf(os.Stderr, "warn: could not load LSP plugin adapter: %v\n", loadErr)
	}
	return manager
}

func lspConfigWithGlobalDefaults(project *models.Project) lsp.Config {
	var defaults *storage.ProjectDefaults
	if settings, err := storage.NewEmbeddingSettingsStore().Load(); err == nil {
		defaults = settings.ProjectDefaults
	}
	return lsp.ConfigFromProjectWithDefaults(project, defaults)
}
