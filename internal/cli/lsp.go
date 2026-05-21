package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/spf13/cobra"
)

type lspListRow struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Binary     string `json:"binary,omitempty"`
	Source     string `json:"source,omitempty"`
	InstallCmd string `json:"install_cmd,omitempty"`
}

func newLspCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "lsp",
		Short: "Manage LSP language servers",
	}
	cmd.AddCommand(newLspListCmd())
	cmd.AddCommand(newLspInstallCmd())
	cmd.AddCommand(newLspCleanupCmd())
	return cmd
}

func newLspListCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List supported LSP language servers",
		RunE:  runLspList,
	}
}

func newLspInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install <language>",
		Short: "Install an LSP language server",
		Args:  cobra.ExactArgs(1),
		RunE:  runLspInstall,
	}
}

func newLspCleanupCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cleanup",
		Short: "Remove old LSP server versions",
		RunE:  runLspCleanup,
	}
}

func runLspList(cmd *cobra.Command, args []string) error {
	rows := collectLspRows(cmd.Context())
	if isJSON(cmd) {
		printJSON(rows)
		return nil
	}

	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "Language\tStatus\tBinary\tInstall")
	for _, row := range rows {
		binary := "—"
		if row.Binary != "" {
			binary = row.Binary
			if row.Source != "" {
				binary += " (" + row.Source + ")"
			}
		}
		install := row.InstallCmd
		if install == "" {
			install = "—"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", row.ID, row.Status, binary, install)
	}
	return w.Flush()
}

func runLspInstall(cmd *cobra.Command, args []string) error {
	adapter, ok := adapters.Find(args[0])
	if !ok {
		return fmt.Errorf("unsupported language %q", args[0])
	}

	if !adapter.CanInstall() {
		printInstallGuide(adapter)
		return nil
	}

	ctx := cmd.Context()
	if err := adapter.CheckPrerequisites(ctx); err != nil {
		fmt.Printf("Prerequisite check failed: %s\n\n", err)
		printInstallGuide(adapter)
		prereqs := adapter.Prerequisites()
		if len(prereqs) > 0 {
			fmt.Println("\nRequired prerequisites:")
			for _, p := range prereqs {
				fmt.Printf("  • %s\n", p.Name)
				if p.InstallHint != "" {
					fmt.Printf("    %s\n", p.InstallHint)
				}
			}
		}
		return fmt.Errorf("prerequisites not met for %s", adapter.ID())
	}

	fmt.Printf("Installing %s for %s...\n", firstBinaryName(adapter), adapter.Name())

	var path string
	if len(adapter.RuntimeDeps()) == 0 {
		var err error
		path, err = adapter.Install(ctx, lspBaseDir())
		if err != nil {
			return fmt.Errorf("install %s: %w", adapter.ID(), err)
		}
	} else {
		if err := validateRuntimeDeps(adapter); err != nil {
			printInstallGuide(adapter)
			return err
		}
		installer := lsp.NewInstaller(lspBaseDir())
		var err error
		path, err = installer.Install(ctx, adapter)
		if err != nil {
			return fmt.Errorf("install %s: %w", adapter.ID(), err)
		}
	}

	fmt.Printf("✓ Installed %s to %s\n", filepath.Base(path), path)
	return nil
}

func runLspCleanup(cmd *cobra.Command, args []string) error {
	installer := lsp.NewInstaller(lspBaseDir())
	var cleaned []string
	for _, adapter := range adapters.All() {
		langDir := filepath.Join(lspBaseDir(), adapter.ID())
		before := countLspVersionDirs(langDir)
		if before == 0 {
			continue
		}
		if err := installer.Cleanup(adapter.ID()); err != nil {
			return fmt.Errorf("cleanup %s: %w", adapter.ID(), err)
		}
		after := countLspVersionDirs(langDir)
		if before > after {
			cleaned = append(cleaned, fmt.Sprintf("%s: removed %d old version(s)", adapter.ID(), before-after))
		}
	}

	if isJSON(cmd) {
		printJSON(cleaned)
		return nil
	}
	if len(cleaned) == 0 {
		fmt.Println("No old LSP server versions found.")
		return nil
	}
	for _, line := range cleaned {
		fmt.Println(line)
	}
	return nil
}

func collectLspRows(ctx context.Context) []lspListRow {
	cfg := currentLspConfig()
	projectRoot := currentProjectRoot()
	detected := detectLspLanguages(projectRoot)
	installer := lsp.NewInstaller(lspBaseDir())

	rows := make([]lspListRow, 0, len(adapters.All()))
	for _, adapter := range adapters.All() {
		status := "not-installed"
		binary := ""
		source := ""
		installCmd := ""

		if !cfg.Enabled(adapter.ID()) {
			status = "disabled"
		} else if path, ok := findLspBinary(ctx, adapter, cfg.BinaryOverride(adapter.ID())); ok {
			binary = firstBinaryName(adapter)
			source = lspBinarySource(path, cfg.BinaryOverride(adapter.ID()))
			status = "installed"
			if detected[adapter.ID()] {
				status = "running"
			}
		} else if path, ok := installer.IsInstalled(adapter); ok {
			binary = filepath.Base(path)
			source = "knowns"
			status = "installed"
		} else if guide := adapter.InstallGuide(); guide.KnownsCmd != "" {
			installCmd = guide.KnownsCmd
		} else if adapter.CanInstall() {
			installCmd = "knowns lsp install " + adapter.ID()
		}

		rows = append(rows, lspListRow{ID: adapter.ID(), Name: adapter.Name(), Status: status, Binary: binary, Source: source, InstallCmd: installCmd})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ID < rows[j].ID })
	return rows
}

func currentLspConfig() lsp.Config {
	store, err := getStoreErr()
	if err != nil {
		return lsp.Config{}
	}
	project, err := store.Config.Load()
	if err != nil {
		return lsp.Config{}
	}
	return lsp.ConfigFromProject(project)
}

func currentProjectRoot() string {
	store, err := getStoreErr()
	if err != nil {
		cwd, _ := os.Getwd()
		return cwd
	}
	return filepath.Dir(store.Root)
}

func detectLspLanguages(root string) map[string]bool {
	seen := make(map[string]bool)
	if root == "" {
		return seen
	}
	extToLang := make(map[string]string)
	for _, adapter := range adapters.All() {
		for _, ext := range adapter.Extensions() {
			extToLang[strings.ToLower(ext)] = adapter.ID()
		}
	}
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			switch entry.Name() {
			case ".git", ".knowns", "node_modules", "vendor", "target", "dist", "build":
				if path != root {
					return filepath.SkipDir
				}
			}
			return nil
		}
		if lang, ok := extToLang[strings.ToLower(filepath.Ext(path))]; ok {
			seen[lang] = true
		}
		return nil
	})
	return seen
}

func findLspBinary(ctx context.Context, adapter lsp.LanguageAdapter, override string) (string, bool) {
	binaries := adapter.Binaries()
	if override != "" {
		binaries = []lsp.BinaryCandidate{{Name: override}}
	}
	for _, binary := range binaries {
		path, err := exec.LookPath(binary.Name)
		if err != nil {
			continue
		}
		if len(binary.CheckArgs) > 0 {
			checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err = exec.CommandContext(checkCtx, path, binary.CheckArgs...).Run()
			cancel()
			if err != nil {
				continue
			}
		}
		return path, true
	}
	return "", false
}

func firstBinaryName(adapter lsp.LanguageAdapter) string {
	binaries := adapter.Binaries()
	if len(binaries) == 0 {
		return adapter.ID()
	}
	return binaries[0].Name
}

func validateRuntimeDeps(adapter lsp.LanguageAdapter) error {
	for _, dep := range adapter.RuntimeDeps() {
		if dep.SHA256 == "" || strings.EqualFold(dep.SHA256, "TODO") {
			return fmt.Errorf("auto-install metadata for %s is incomplete: missing SHA-256 for %s", adapter.ID(), dep.PlatformID)
		}
	}
	return nil
}

func printInstallGuide(adapter lsp.LanguageAdapter) {
	guide := adapter.InstallGuide()
	fmt.Printf("Cannot auto-install %s. Install manually:\n", firstBinaryName(adapter))
	if guide.Command != "" {
		fmt.Printf("  → %s\n", guide.Command)
	}
	if guide.URL != "" {
		fmt.Printf("  → %s\n", guide.URL)
	}
	if guide.Notes != "" {
		fmt.Printf("  %s\n", guide.Notes)
	}
}

func lspBinarySource(path, override string) string {
	if override != "" {
		return "config"
	}
	if filepath.IsAbs(path) {
		return "PATH"
	}
	return "PATH"
}

func lspBaseDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".knowns", "lsp-servers")
	}
	return filepath.Join(home, ".knowns", "lsp-servers")
}

func countLspVersionDirs(path string) int {
	entries, err := os.ReadDir(path)
	if err != nil {
		return 0
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() {
			count++
		}
	}
	return count
}

func init() {
	rootCmd.AddCommand(newLspCmd())
}
