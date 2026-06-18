package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/spf13/cobra"
)

type lspListRow struct {
	ID              string               `json:"id"`
	Name            string               `json:"name"`
	Enabled         bool                 `json:"enabled"`
	Detected        bool                 `json:"detected"`
	Status          string               `json:"status"`
	InstallState    string               `json:"install_state"`
	RunningState    string               `json:"running_state"`
	ReadinessState  string               `json:"readiness_state"`
	Binary          string               `json:"binary,omitempty"`
	BinaryPath      string               `json:"binary_path,omitempty"`
	Source          string               `json:"source,omitempty"`
	Version         string               `json:"version,omitempty"`
	CachePath       string               `json:"cache_path,omitempty"`
	SelectedPath    string               `json:"selected_path,omitempty"`
	CleanupEligible bool                 `json:"cleanup_eligible,omitempty"`
	InstallError    string               `json:"install_error,omitempty"`
	UpdateError     string               `json:"update_error,omitempty"`
	InstallCmd      string               `json:"install_cmd,omitempty"`
	Backend         string               `json:"backend,omitempty"`
	BackendSource   string               `json:"backend_source,omitempty"`
	ProjectPath     string               `json:"project_path,omitempty"`
	ProjectKind     string               `json:"project_kind,omitempty"`
	LogPath         string               `json:"log_path,omitempty"`
	Attempts        []lsp.BackendAttempt `json:"attempts,omitempty"`
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
	fmt.Fprintln(w, "Language\tStatus\tBackend\tRuntime\tInstall\tLog")
	for _, row := range rows {
		backend := "-"
		if row.Backend != "" {
			backend = row.Backend
			if row.BackendSource != "" {
				backend += " (" + row.BackendSource + ")"
			}
		}
		runtime := "-"
		if row.Binary != "" {
			runtime = row.Binary
			if row.Source != "" {
				runtime += " (" + row.Source + ")"
			}
		}
		if row.Version != "" && row.Source == lsp.RuntimeSourceKnowns {
			runtime += " " + row.Version
		}
		if row.ReadinessState != "" && row.ReadinessState != lsp.RuntimeReadinessNotApplicable {
			runtime += " readiness=" + row.ReadinessState
		}
		if row.ProjectPath != "" {
			runtime += " project=" + filepath.Base(row.ProjectPath)
		}
		install := row.InstallCmd
		if install == "" {
			install = row.InstallState
		}
		logPath := row.LogPath
		if logPath == "" {
			logPath = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", row.ID, row.Status, backend, runtime, install, logPath)
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
		status := installer.Status(adapter)
		if !status.CleanupEligible {
			continue
		}
		langDir := filepath.Join(lspBaseDir(), adapter.ID())
		before := countLspVersionDirs(langDir)
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
	projectRoot := currentProjectRoot()
	statuses := getLSPManagerForRoot(projectRoot).RuntimeStatuses(ctx)
	rows := make([]lspListRow, 0, len(statuses))
	for _, status := range statuses {
		rows = append(rows, lspRowFromRuntime(status))
	}
	return rows
}

func lspRowFromRuntime(status lsp.LanguageRuntimeStatus) lspListRow {
	return lspListRow{
		ID:              status.ID,
		Name:            status.Name,
		Enabled:         status.Enabled,
		Detected:        status.Detected,
		Status:          status.Status,
		InstallState:    status.InstallState,
		RunningState:    status.RunningState,
		ReadinessState:  status.ReadinessState,
		Binary:          status.Binary,
		BinaryPath:      status.BinaryPath,
		Source:          status.Source,
		Version:         status.Version,
		CachePath:       status.CachePath,
		SelectedPath:    status.SelectedPath,
		CleanupEligible: status.CleanupEligible,
		InstallError:    status.InstallError,
		UpdateError:     status.UpdateError,
		InstallCmd:      status.InstallCmd,
		Backend:         status.Backend,
		BackendSource:   status.BackendSource,
		ProjectPath:     status.ProjectPath,
		ProjectKind:     status.ProjectKind,
		LogPath:         status.LogPath,
		Attempts:        status.Attempts,
	}
}

func currentProjectRoot() string {
	store, err := getStoreErr()
	if err != nil {
		cwd, _ := os.Getwd()
		return cwd
	}
	return filepath.Dir(store.Root)
}

func firstBinaryName(adapter lsp.LanguageAdapter) string {
	binaries := adapter.Binaries()
	if len(binaries) == 0 {
		return adapter.ID()
	}
	return binaries[0].Name
}

func findLspBinary(ctx context.Context, adapter lsp.LanguageAdapter, override string) (string, bool) {
	cfg := lsp.Config{}
	if override != "" {
		cfg.Languages = map[string]lsp.LanguageConfig{adapter.ID(): {Binary: override}}
	}
	statuses := lsp.CollectRuntimeStatuses(ctx, lsp.RuntimeStatusOptions{
		Root:     currentProjectRoot(),
		Config:   cfg,
		Adapters: []lsp.LanguageAdapter{adapter},
	})
	if len(statuses) == 0 {
		return "", false
	}
	status := statuses[0]
	if status.InstallState == lsp.RuntimeInstallInstalled && status.BinaryPath != "" {
		return status.BinaryPath, true
	}
	return "", false
}

func validateRuntimeDeps(adapter lsp.LanguageAdapter) error {
	for _, dep := range adapter.RuntimeDeps() {
		if strings.EqualFold(dep.Source, "nuget") || strings.EqualFold(dep.ArchiveType, "nupkg") {
			continue
		}
		if strings.EqualFold(dep.Source, "npm") || strings.EqualFold(dep.ArchiveType, "npm") {
			continue
		}
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

func lspBaseDir() string {
	return lsp.DefaultLSPBaseDir()
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
