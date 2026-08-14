package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"github.com/howznguyen/knowns/internal/gitauth"
	"github.com/spf13/cobra"
)

var importCmd = &cobra.Command{
	Use:   "import",
	Short: "Manage imported Knowns packages",
}

// --- import add ---

var importAddCmd = &cobra.Command{
	Use:   "add <source>",
	Short: "Add an import source",
	Long: `Add a Knowns package import. The source can be:
  - A local path: ./path/to/package
  - An npm package: @scope/package or package-name`,
	Args: cobra.ExactArgs(1),
	RunE: runImportAdd,
}

func runImportAdd(cmd *cobra.Command, args []string) error {
	source := args[0]

	store, err := getStoreErr()
	if err != nil {
		return err
	}

	// Determine import name from source
	name := importNameFromSource(source)
	importsDir := filepath.Join(store.Root, "imports", name)

	if _, statErr := os.Stat(importsDir); statErr == nil {
		return fmt.Errorf("import %q already exists", name)
	}

	if err := os.MkdirAll(importsDir, 0755); err != nil {
		return fmt.Errorf("create import directory: %w", err)
	}

	// Write metadata in the same format as the server.
	now := time.Now().UTC().Format(time.RFC3339)
	importType := "local"
	if strings.HasPrefix(source, "http://") || strings.HasPrefix(source, "https://") || strings.HasPrefix(source, "git@") || strings.HasSuffix(source, ".git") {
		importType = "git"
	} else if strings.HasPrefix(source, "@") || (!strings.Contains(source, "/") && !strings.Contains(source, "\\") && !strings.HasPrefix(source, ".")) {
		importType = "npm"
	}
	meta := cliImportMeta{
		Source:     source,
		Type:       importType,
		LastSync:   now,
		ImportedAt: now,
	}
	manifestPath := filepath.Join(importsDir, "_import.json")
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal import metadata: %w", err)
	}
	if err := os.WriteFile(manifestPath, data, 0644); err != nil {
		return fmt.Errorf("write import manifest: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Added import: %s (from %s)", name, source)))

	// Auto-sync git imports immediately.
	if importType == "git" {
		var commitHash string
		added, updated, skipped, syncErr := runImportWithSpinner(
			fmt.Sprintf("Syncing %s", name),
			func() (int, int, int, error) {
				a, u, s, h, e := cliGitSync(source, "", importsDir, name, "", false)
				commitHash = h
				return a, u, s, e
			},
		)
		if syncErr != nil {
			fmt.Println(RenderHint("You can retry with: " + RenderCmd("knowns import sync")))
			return nil
		}
		// Update lastSync and commitHash.
		meta.LastSync = time.Now().UTC().Format(time.RFC3339)
		meta.LastCommitHash = commitHash
		if newData, err := json.MarshalIndent(meta, "", "  "); err == nil {
			_ = os.WriteFile(manifestPath, newData, 0644)
		}
		_ = added
		_ = updated
		_ = skipped
	}

	return nil
}

// --- import remove ---

var importRemoveCmd = &cobra.Command{
	Use:   "remove <name>",
	Short: "Remove an imported package",
	Args:  cobra.ExactArgs(1),
	RunE:  runImportRemove,
}

func runImportRemove(cmd *cobra.Command, args []string) error {
	name := args[0]

	store, err := getStoreErr()
	if err != nil {
		return err
	}

	importsDir := filepath.Join(store.Root, "imports", name)
	if _, statErr := os.Stat(importsDir); os.IsNotExist(statErr) {
		return fmt.Errorf("import %q not found", name)
	}

	if err := os.RemoveAll(importsDir); err != nil {
		return fmt.Errorf("remove import: %w", err)
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Removed import: %s", name)))
	return nil
}

// --- import list ---

var importListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all imported packages",
	RunE:  runImportList,
}

func runImportList(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	importsDir := filepath.Join(store.Root, "imports")
	entries, err := os.ReadDir(importsDir)
	if os.IsNotExist(err) {
		fmt.Println(StyleDim.Render("No imports found."))
		return nil
	}
	if err != nil {
		return fmt.Errorf("read imports directory: %w", err)
	}

	plain := isPlain(cmd)

	var imports []string
	for _, e := range entries {
		if e.IsDir() {
			imports = append(imports, e.Name())
		}
	}

	if len(imports) == 0 {
		fmt.Println(StyleDim.Render("No imports found."))
		return nil
	}

	if plain {
		for _, name := range imports {
			fmt.Printf("IMPORT: %s\n", name)
		}
	} else {
		fmt.Printf("%s\n", RenderSectionHeader(fmt.Sprintf("Imported packages (%d)", len(imports))))
		for _, name := range imports {
			fmt.Printf("  %s %s\n", StyleDim.Render("•"), name)
		}
	}
	return nil
}

// --- import sync ---

var importSyncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync all imported packages",
	RunE:  runImportSync,
}

func runImportSync(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	importsDir := filepath.Join(store.Root, "imports")
	entries, err := os.ReadDir(importsDir)
	if os.IsNotExist(err) {
		fmt.Println(StyleDim.Render("No imports to sync."))
		return nil
	}
	if err != nil {
		return fmt.Errorf("read imports: %w", err)
	}

	// Collect syncable imports.
	type syncableImport struct {
		name      string
		importDir string
		metaPath  string
		meta      cliImportMeta
	}
	var syncables []syncableImport
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		name := e.Name()
		importDir := filepath.Join(importsDir, name)
		metaPath := filepath.Join(importDir, "_import.json")
		metaData, readErr := os.ReadFile(metaPath)
		if readErr != nil {
			continue
		}
		var meta cliImportMeta
		if jsonErr := json.Unmarshal(metaData, &meta); jsonErr != nil {
			continue
		}
		if meta.Type != "git" || !isGitURLCli(meta.Source) {
			continue
		}
		syncables = append(syncables, syncableImport{
			name: name, importDir: importDir, metaPath: metaPath, meta: meta,
		})
	}

	if len(syncables) == 0 {
		fmt.Println(StyleDim.Render("No imports to sync."))
		return nil
	}

	fmt.Printf("%s\n\n", RenderInfo(fmt.Sprintf("Syncing %d import(s)...", len(syncables))))

	synced := 0
	upToDate := 0
	for i, imp := range syncables {
		var added, updated, skipped int
		var commitHash string
		var isUpToDate bool
		label := fmt.Sprintf("Syncing %s (%d/%d)", imp.name, i+1, len(syncables))
		err := RunWithSpinner(label, func() error {
			var syncErr error
			added, updated, skipped, commitHash, syncErr = cliGitSync(imp.meta.Source, imp.meta.Ref, imp.importDir, imp.name, imp.meta.LastCommitHash, false)
			if syncErr == errUpToDate {
				isUpToDate = true
				return nil
			}
			return syncErr
		})
		if err != nil {
			continue
		}
		if isUpToDate {
			upToDate++
			fmt.Printf("    %s\n", StyleDim.Render("already up to date"))
			continue
		}

		// Update lastSync and commitHash.
		imp.meta.LastSync = time.Now().UTC().Format(time.RFC3339)
		imp.meta.LastCommitHash = commitHash
		if newData, err := json.MarshalIndent(imp.meta, "", "  "); err == nil {
			_ = os.WriteFile(imp.metaPath, newData, 0644)
		}

		fmt.Printf("    %s\n", StyleDim.Render(fmt.Sprintf("%d added, %d updated, %d skipped", added, updated, skipped)))
		synced++
	}

	fmt.Println()
	if upToDate > 0 {
		fmt.Println(RenderSuccess(fmt.Sprintf("Synced %d/%d import(s), %d already up to date.", synced, len(syncables), upToDate)))
	} else {
		fmt.Println(RenderSuccess(fmt.Sprintf("Synced %d/%d import(s).", synced, len(syncables))))
	}
	return nil
}

// isGitURLCli returns true if source looks like a git repository URL.
func isGitURLCli(source string) bool {
	s := strings.TrimSpace(source)
	if strings.HasPrefix(strings.ToLower(s), "git@") {
		return strings.Contains(s, ":")
	}
	u, err := url.Parse(s)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != ""
}

// cliInjectGitToken injects a git token into HTTPS clone URLs.
// Priority: KNOWNS_GIT_TOKEN env > git.token config > KNOWNS_GITHUB_TOKEN env > github.token config.
func cliInjectGitToken(source string) string {
	token, host := cliGitCredential()
	return gitauth.InjectHTTPSCredential(source, token, host)
}

func cliGitCredential() (string, string) {
	if token := os.Getenv("KNOWNS_GIT_TOKEN"); token != "" {
		if host := os.Getenv("KNOWNS_GIT_HOST"); host != "" {
			return token, host
		}
	}
	var token, host string
	if store, err := getStoreErr(); err == nil {
		if v, err := store.Config.Get("git.token"); err == nil {
			token, _ = v.(string)
		}
		if v, err := store.Config.Get("git.host"); err == nil {
			host, _ = v.(string)
		}
	}
	if token != "" {
		if host != "" {
			return token, host
		}
	}
	// Fallback to GitHub-specific for backward compatibility.
	token = os.Getenv("KNOWNS_GITHUB_TOKEN")
	if token == "" {
		if store, err := getStoreErr(); err == nil {
			if v, err := store.Config.Get("github.token"); err == nil {
				if s, ok := v.(string); ok && s != "" {
					token = s
				}
			}
		}
	}
	if token != "" {
		return token, "github.com"
	}
	return "", ""
}

// cliGitLsRemoteHead returns the commit hash for the remote HEAD (or a specific ref).
// Returns empty string on any error (network, auth, etc.).
func cliGitLsRemoteHead(source, ref string) string {
	url := cliInjectGitToken(source)
	target := "HEAD"
	if ref != "" {
		target = ref
	}
	cmd := exec.Command("git", "ls-remote", "--", url, target)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	// Output format: "<hash>\t<ref>\n"
	line := strings.TrimSpace(string(out))
	if idx := strings.IndexByte(line, '\t'); idx > 0 {
		return line[:idx]
	}
	return ""
}

// errUpToDate is returned when the remote commit hash matches the cached hash.
var errUpToDate = fmt.Errorf("already up to date")

// cliGitSync clones a git repo and copies .knowns/docs and .knowns/templates into importDir.
// If cachedHash is non-empty and matches the remote HEAD, returns errUpToDate without cloning.
// Returns the remote commit hash so callers can persist it.
func cliGitSync(source, ref, importDir, name, cachedHash string, force bool) (added, updated, skipped int, commitHash string, err error) {
	// Check remote commit hash before cloning.
	remoteHash := cliGitLsRemoteHead(source, ref)
	if remoteHash != "" && remoteHash == cachedHash && !force {
		return 0, 0, 0, remoteHash, errUpToDate
	}

	tmpDir, err := os.MkdirTemp("", "knowns-import-*")
	if err != nil {
		return 0, 0, 0, remoteHash, err
	}
	defer os.RemoveAll(tmpDir)

	// Shallow clone.
	cloneURL := cliInjectGitToken(source)
	gitArgs := []string{"clone", "--depth", "1"}
	if ref != "" {
		gitArgs = append(gitArgs, "--branch", ref)
	}
	gitArgs = append(gitArgs, "--", cloneURL, tmpDir)

	gitCmd := exec.Command("git", gitArgs...)
	var stderr bytes.Buffer
	gitCmd.Stderr = &stderr
	gitCmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if err := gitCmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if token, _ := cliGitCredential(); token != "" {
			errMsg = strings.ReplaceAll(errMsg, token, "[REDACTED]")
		}
		if cliIsAuthError(errMsg) {
			return 0, 0, 0, "", fmt.Errorf("authentication failed for %s\n\n"+
				"Options:\n"+
				"  1. Use SSH URL:      git@host:owner/repo.git\n"+
				"  2. Set token:        export KNOWNS_GIT_TOKEN=<your-token>\n"+
				"  3. Set config token: knowns config set git.token <your-token>", source)
		}
		return 0, 0, 0, "", fmt.Errorf("git clone failed: %s", errMsg)
	}

	// Check for .knowns/ directory.
	knownsDir := filepath.Join(tmpDir, ".knowns")
	if _, err := os.Stat(knownsDir); os.IsNotExist(err) {
		return 0, 0, 0, "", fmt.Errorf("no .knowns directory found in %s", source)
	}

	for _, sub := range []string{"docs", "templates"} {
		srcDir := filepath.Join(knownsDir, sub)
		if _, err := os.Stat(srcDir); os.IsNotExist(err) {
			continue
		}

		_ = filepath.Walk(srcDir, func(path string, info os.FileInfo, walkErr error) error {
			if walkErr != nil || info.IsDir() {
				return nil
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return nil
			}
			relPath, _ := filepath.Rel(knownsDir, path)
			relPath = filepath.ToSlash(relPath)
			// Nest docs under {name}/ prefix.
			if sub == "docs" {
				subRel := strings.TrimPrefix(relPath, "docs/")
				relPath = "docs/" + name + "/" + subRel
			}
			destPath := filepath.Join(importDir, relPath)

			srcData, readErr := os.ReadFile(path)
			if readErr != nil {
				return nil
			}

			if destData, readErr := os.ReadFile(destPath); readErr == nil {
				if bytes.Equal(srcData, destData) {
					skipped++
					return nil
				}
				updated++
			} else {
				added++
			}

			_ = os.MkdirAll(filepath.Dir(destPath), 0755)
			_ = cliCopyFile(path, destPath)
			return nil
		})
	}

	return added, updated, skipped, remoteHash, nil
}

// cliIsAuthError checks if a git stderr message indicates an authentication failure.
func cliIsAuthError(stderr string) bool {
	s := strings.ToLower(stderr)
	return strings.Contains(s, "authentication failed") ||
		strings.Contains(s, "could not read username") ||
		strings.Contains(s, "terminal prompts disabled") ||
		strings.Contains(s, "403") ||
		strings.Contains(s, "401")
}

// cliCopyFile copies src to dst.
func cliCopyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// ─── bubbletea spinner model for import operations ───────────────────

type importSyncResult struct {
	added   int
	updated int
	skipped int
}

type importSyncDoneMsg struct {
	result importSyncResult
	err    error
}

type importSpinnerModel struct {
	spinner  spinner.Model
	label    string
	done     bool
	err      error
	result   importSyncResult
	syncFunc func() (int, int, int, error)
}

func newImportSpinnerModel(label string, syncFunc func() (int, int, int, error)) *importSpinnerModel {
	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(StyleDim),
	)
	return &importSpinnerModel{
		spinner:  sp,
		label:    label,
		syncFunc: syncFunc,
	}
}

func (m *importSpinnerModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		func() tea.Msg {
			added, updated, skipped, err := m.syncFunc()
			return importSyncDoneMsg{
				result: importSyncResult{added: added, updated: updated, skipped: skipped},
				err:    err,
			}
		},
	)
}

func (m *importSpinnerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.done = true
			m.err = fmt.Errorf("cancelled")
			return m, tea.Quit
		}
	case importSyncDoneMsg:
		m.done = true
		m.err = msg.err
		m.result = msg.result
		return m, tea.Quit
	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *importSpinnerModel) View() tea.View {
	if m.done {
		if m.err != nil {
			return tea.NewView(fmt.Sprintf("  %s %s: %s\n",
				StyleWarning.Render("✗"), m.label, StyleWarning.Render(m.err.Error())))
		}
		return tea.NewView(fmt.Sprintf("  %s %s: %d added, %d updated, %d skipped\n",
			StyleSuccess.Render("✓"), m.label,
			m.result.added, m.result.updated, m.result.skipped))
	}
	return tea.NewView(fmt.Sprintf("  %s %s\n", m.spinner.View(), m.label))
}

// runImportWithSpinner runs a sync function with a bubbletea spinner UI.
func runImportWithSpinner(label string, syncFunc func() (int, int, int, error)) (int, int, int, error) {
	m := newImportSpinnerModel(label, syncFunc)
	p := tea.NewProgram(m)
	finalModel, err := p.Run()
	if err != nil {
		return 0, 0, 0, err
	}
	fm := finalModel.(*importSpinnerModel)
	return fm.result.added, fm.result.updated, fm.result.skipped, fm.err
}

// cliImportMeta matches the server's importMeta format for _import.json.
type cliImportMeta struct {
	Source         string `json:"source"`
	Type           string `json:"type"`
	Ref            string `json:"ref,omitempty"`
	LastSync       string `json:"lastSync,omitempty"`
	ImportedAt     string `json:"importedAt,omitempty"`
	LastCommitHash string `json:"lastCommitHash,omitempty"`
}

// importNameFromSource derives a safe directory name from an import source.
func importNameFromSource(source string) string {
	// Strip trailing slashes and .git suffix.
	s := strings.TrimRight(source, "/")
	s = strings.TrimSuffix(s, ".git")

	// Handle SSH URLs like git@github.com:owner/repo
	if idx := strings.LastIndex(s, ":"); idx >= 0 && !strings.Contains(s, "://") {
		s = s[idx+1:]
	}

	// Take the last path segment.
	if idx := strings.LastIndex(s, "/"); idx >= 0 {
		s = s[idx+1:]
	}

	// For npm scoped packages: @scope/package → package (already handled by last segment)
	s = strings.TrimPrefix(s, "@")

	// Remove unsafe characters.
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.' {
			b.WriteRune(r)
		}
	}
	result := b.String()
	if result == "" {
		result = "imported"
	}
	return result
}

// --- import status ---

var importStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show import status",
	RunE:  runImportStatus,
}

func runImportStatus(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	importsDir := filepath.Join(store.Root, "imports")
	entries, err := os.ReadDir(importsDir)
	if os.IsNotExist(err) {
		fmt.Println(StyleDim.Render("No imports configured."))
		return nil
	}
	if err != nil {
		return fmt.Errorf("read imports directory: %w", err)
	}

	plain := isPlain(cmd)

	var imports []string
	for _, e := range entries {
		if e.IsDir() {
			imports = append(imports, e.Name())
		}
	}

	if len(imports) == 0 {
		fmt.Println(StyleDim.Render("No imports configured."))
		return nil
	}

	if plain {
		fmt.Printf("IMPORTS: %d\n\n", len(imports))
		for _, name := range imports {
			manifestPath := filepath.Join(importsDir, name, "_import.json")
			status := "unknown"
			source := ""
			if data, readErr := os.ReadFile(manifestPath); readErr == nil {
				status = "installed"
				// Try to extract source
				var manifest map[string]string
				if jsonErr := json.Unmarshal(data, &manifest); jsonErr == nil {
					source = manifest["source"]
				}
			} else {
				status = "missing-manifest"
			}
			fmt.Printf("IMPORT: %s\n", name)
			fmt.Printf("  STATUS: %s\n", status)
			if source != "" {
				fmt.Printf("  SOURCE: %s\n", source)
			}
			fmt.Println()
		}
	} else {
		fmt.Printf("%s\n\n", RenderSectionHeader(fmt.Sprintf("Import status (%d packages)", len(imports))))
		for _, name := range imports {
			manifestPath := filepath.Join(importsDir, name, "_import.json")
			status := "unknown"
			source := ""
			if data, readErr := os.ReadFile(manifestPath); readErr == nil {
				status = "installed"
				var manifest map[string]string
				if jsonErr := json.Unmarshal(data, &manifest); jsonErr == nil {
					source = manifest["source"]
				}
			} else {
				status = "missing manifest"
			}
			statusStyled := StyleDim.Render("[" + status + "]")
			if status == "installed" {
				statusStyled = StyleSuccess.Render("[" + status + "]")
			}
			if source != "" {
				fmt.Printf("  %-20s %s %s\n", name, statusStyled, StyleDim.Render("(from "+source+")"))
			} else {
				fmt.Printf("  %-20s %s\n", name, statusStyled)
			}
		}
	}
	return nil
}

func init() {
	importCmd.AddCommand(importAddCmd)
	importCmd.AddCommand(importRemoveCmd)
	importCmd.AddCommand(importListCmd)
	importCmd.AddCommand(importSyncCmd)
	importCmd.AddCommand(importStatusCmd)

	rootCmd.AddCommand(importCmd)
}
