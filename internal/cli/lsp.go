package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/lspdaemon"
	"github.com/spf13/cobra"
)

type lspListRow struct {
	ID                     string               `json:"id"`
	Name                   string               `json:"name"`
	Enabled                bool                 `json:"enabled"`
	Detected               bool                 `json:"detected"`
	Status                 string               `json:"status"`
	InstallState           string               `json:"install_state"`
	RunningState           string               `json:"running_state"`
	ReadinessState         string               `json:"readiness_state"`
	Binary                 string               `json:"binary,omitempty"`
	BinaryPath             string               `json:"binary_path,omitempty"`
	Source                 string               `json:"source,omitempty"`
	Version                string               `json:"version,omitempty"`
	RequestedVersion       string               `json:"requested_version,omitempty"`
	ResolvedVersion        string               `json:"resolved_version,omitempty"`
	SourceLocation         string               `json:"source_location,omitempty"`
	Integrity              string               `json:"integrity,omitempty"`
	InstalledAt            string               `json:"installed_at,omitempty"`
	Verified               bool                 `json:"verified"`
	CachePath              string               `json:"cache_path,omitempty"`
	SelectedPath           string               `json:"selected_path,omitempty"`
	CleanupEligible        bool                 `json:"cleanup_eligible,omitempty"`
	InstallError           string               `json:"install_error,omitempty"`
	UpdateError            string               `json:"update_error,omitempty"`
	InstallCmd             string               `json:"install_cmd,omitempty"`
	Backend                string               `json:"backend,omitempty"`
	BackendSource          string               `json:"backend_source,omitempty"`
	ProjectPath            string               `json:"project_path,omitempty"`
	ProjectKind            string               `json:"project_kind,omitempty"`
	LogPath                string               `json:"log_path,omitempty"`
	Attempts               []lsp.BackendAttempt `json:"attempts,omitempty"`
	Owner                  string               `json:"owner,omitempty"`
	DaemonState            string               `json:"daemon_state,omitempty"`
	DaemonPID              int                  `json:"daemon_pid,omitempty"`
	DaemonClients          int                  `json:"daemon_clients,omitempty"`
	DaemonTransport        string               `json:"daemon_transport,omitempty"`
	DaemonEndpoint         string               `json:"daemon_endpoint,omitempty"`
	DaemonIdleDeadline     string               `json:"daemon_idle_deadline,omitempty"`
	DaemonLeaseCount       int                  `json:"daemon_lease_count,omitempty"`
	DaemonLeaseOwners      []string             `json:"daemon_lease_owners,omitempty"`
	CapabilitiesKnown      bool                 `json:"capabilities_known,omitempty"`
	Capabilities           []string             `json:"capabilities,omitempty"`
	AdvertisedCapabilities []string             `json:"advertised_capabilities,omitempty"`
	ObservedCapabilities   []string             `json:"observed_capabilities,omitempty"`
	RequiredCapabilities   []string             `json:"required_capabilities,omitempty"`
	MissingCapabilities    []string             `json:"missing_capabilities,omitempty"`
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
	cmd := &cobra.Command{
		Use:   "install <language>",
		Short: "Install an LSP language server",
		Args:  cobra.ExactArgs(1),
		RunE:  runLspInstall,
	}
	cmd.Flags().Bool("latest", false, "Install the latest upstream version (requires confirmation)")
	cmd.Flags().String("version", "", "Install an explicit upstream version or tag (requires confirmation)")
	cmd.Flags().BoolP("yes", "y", false, "Confirm a non-recommended version selection")
	cmd.MarkFlagsMutuallyExclusive("latest", "version")
	return cmd
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
	fmt.Fprintln(w, "Language\tStatus\tOwner\tBackend\tRuntime\tInstall\tCapabilities\tLog")
	for _, row := range rows {
		owner := row.Owner
		if owner == "" {
			owner = "-"
		}
		if row.DaemonState != "" {
			owner += " (" + row.DaemonState + ")"
		}
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
		capabilities := strings.Join(row.Capabilities, ",")
		if len(row.MissingCapabilities) > 0 {
			capabilities = "missing:" + strings.Join(row.MissingCapabilities, ",")
		}
		if capabilities == "" {
			capabilities = "-"
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", row.ID, row.Status, owner, backend, runtime, install, capabilities, logPath)
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
	latest, err := cmd.Flags().GetBool("latest")
	if err != nil {
		return err
	}
	version, err := cmd.Flags().GetString("version")
	if err != nil {
		return err
	}
	yes, err := cmd.Flags().GetBool("yes")
	if err != nil {
		return err
	}
	selector := lsp.InstallSelector{Latest: latest, Version: strings.TrimSpace(version)}
	if latest || selector.Version != "" {
		if err := confirmLSPInstall(cmd, selector, yes); err != nil {
			return err
		}
	}
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
		if latest || selector.Version != "" {
			return fmt.Errorf("language %q does not support managed version selection", adapter.ID())
		}
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
		path, err = installer.InstallWithOptions(ctx, adapter, lsp.InstallOptions{Selector: selector})
		if err != nil {
			return fmt.Errorf("install %s: %w", adapter.ID(), err)
		}
	}

	fmt.Printf("✓ Installed %s to %s\n", filepath.Base(path), path)
	return nil
}

func confirmLSPInstall(cmd *cobra.Command, selector lsp.InstallSelector, yes bool) error {
	requested := selector.Version
	if selector.Latest {
		requested = "latest"
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "WARNING: %s is not the recommended Knowns-verified LSP version.\n", requested)
	if yes {
		return nil
	}
	input := cmd.InOrStdin()
	if file, ok := input.(*os.File); !ok || !isInteractiveInput(file) {
		return fmt.Errorf("non-interactive installation of %s requires --yes", requested)
	}
	fmt.Fprintf(cmd.ErrOrStderr(), "Continue with %s? [y/N] ", requested)
	answer, err := bufio.NewReader(input).ReadString('\n')
	if err != nil {
		return fmt.Errorf("read confirmation: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "y", "yes":
		return nil
	default:
		return fmt.Errorf("installation cancelled")
	}
}

func isInteractiveInput(file *os.File) bool {
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
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
	if lspdaemon.DisabledByEnv() {
		fmt.Fprintln(os.Stderr, "warn: "+lspdaemon.DisabledWarning())
		statuses := lspdaemon.AnnotateLocalStatuses(getLSPManagerForRoot(projectRoot).RuntimeStatuses(ctx), lspdaemon.DaemonStateDisabledByEnv)
		rows := make([]lspListRow, 0, len(statuses))
		for _, status := range statuses {
			rows = append(rows, lspRowFromRuntime(status))
		}
		return rows
	}
	statuses, err := collectDaemonLSPStatuses(ctx, projectRoot)
	if err != nil {
		statuses = getLSPManagerForRoot(projectRoot).RuntimeStatuses(ctx)
		statuses = lspdaemon.AnnotateLocalStatuses(statuses, lspdaemon.DaemonStateUnavailable)
	}
	rows := make([]lspListRow, 0, len(statuses))
	for _, status := range statuses {
		rows = append(rows, lspRowFromRuntime(status))
	}
	return rows
}

func collectDaemonLSPStatuses(ctx context.Context, projectRoot string) ([]lsp.LanguageRuntimeStatus, error) {
	client, err := lspdaemon.EnsureClient(ctx, projectRoot)
	if err != nil {
		return nil, err
	}
	return client.RuntimeStatuses(ctx)
}

func lspRowFromRuntime(status lsp.LanguageRuntimeStatus) lspListRow {
	return lspListRow{
		ID:                     status.ID,
		Name:                   status.Name,
		Enabled:                status.Enabled,
		Detected:               status.Detected,
		Status:                 status.Status,
		InstallState:           status.InstallState,
		RunningState:           status.RunningState,
		ReadinessState:         status.ReadinessState,
		Binary:                 status.Binary,
		BinaryPath:             status.BinaryPath,
		Source:                 status.Source,
		Version:                status.Version,
		RequestedVersion:       status.RequestedVersion,
		ResolvedVersion:        status.ResolvedVersion,
		SourceLocation:         status.SourceLocation,
		Integrity:              status.Integrity,
		InstalledAt:            status.InstalledAt,
		Verified:               status.Verified,
		CachePath:              status.CachePath,
		SelectedPath:           status.SelectedPath,
		CleanupEligible:        status.CleanupEligible,
		InstallError:           status.InstallError,
		UpdateError:            status.UpdateError,
		InstallCmd:             status.InstallCmd,
		Backend:                status.Backend,
		BackendSource:          status.BackendSource,
		ProjectPath:            status.ProjectPath,
		ProjectKind:            status.ProjectKind,
		LogPath:                status.LogPath,
		Attempts:               status.Attempts,
		Owner:                  status.Owner,
		DaemonState:            status.DaemonState,
		DaemonPID:              status.DaemonPID,
		DaemonClients:          status.DaemonClients,
		DaemonTransport:        status.DaemonTransport,
		DaemonEndpoint:         status.DaemonEndpoint,
		DaemonIdleDeadline:     status.DaemonIdleDeadline,
		DaemonLeaseCount:       status.DaemonLeaseCount,
		DaemonLeaseOwners:      append([]string(nil), status.DaemonLeaseOwners...),
		CapabilitiesKnown:      status.CapabilitiesKnown,
		Capabilities:           append([]string(nil), status.Capabilities...),
		AdvertisedCapabilities: append([]string(nil), status.AdvertisedCapabilities...),
		ObservedCapabilities:   append([]string(nil), status.ObservedCapabilities...),
		RequiredCapabilities:   append([]string(nil), status.RequiredCapabilities...),
		MissingCapabilities:    append([]string(nil), status.MissingCapabilities...),
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
