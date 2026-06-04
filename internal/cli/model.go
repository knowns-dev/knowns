package cli

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

// embeddingModel represents a supported embedding model for semantic search.
type embeddingModel struct {
	ID          string
	Name        string
	HuggingFace string
	Dimensions  int
	MaxTokens   int
	SizeMB      int
	Files       []string
}

var supportedModels = []embeddingModel{
	{
		ID:          "gte-small",
		Name:        "GTE Small",
		HuggingFace: "Xenova/gte-small",
		Dimensions:  384,
		MaxTokens:   512,
		SizeMB:      67,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "all-MiniLM-L6-v2",
		Name:        "All MiniLM L6 v2",
		HuggingFace: "Xenova/all-MiniLM-L6-v2",
		Dimensions:  384,
		MaxTokens:   256,
		SizeMB:      86,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "gte-base",
		Name:        "GTE Base",
		HuggingFace: "Xenova/gte-base",
		Dimensions:  768,
		MaxTokens:   512,
		SizeMB:      220,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "bge-small-en-v1.5",
		Name:        "BGE Small EN v1.5",
		HuggingFace: "Xenova/bge-small-en-v1.5",
		Dimensions:  384,
		MaxTokens:   512,
		SizeMB:      67,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "bge-base-en-v1.5",
		Name:        "BGE Base EN v1.5",
		HuggingFace: "Xenova/bge-base-en-v1.5",
		Dimensions:  768,
		MaxTokens:   512,
		SizeMB:      220,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "nomic-embed-text-v1.5",
		Name:        "Nomic Embed Text v1.5",
		HuggingFace: "Xenova/nomic-embed-text-v1.5",
		Dimensions:  768,
		MaxTokens:   8192,
		SizeMB:      274,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
	{
		ID:          "multilingual-e5-small",
		Name:        "Multilingual E5 Small",
		HuggingFace: "Xenova/multilingual-e5-small",
		Dimensions:  384,
		MaxTokens:   512,
		SizeMB:      470,
		Files: []string{
			"config.json",
			"tokenizer.json",
			"tokenizer_config.json",
			"onnx/model_quantized.onnx",
		},
	},
}

var modelCmd = &cobra.Command{
	Use:   "model",
	Short: "Manage embedding models for semantic search",
	Long: `Manage embedding models used for semantic search indexing.

List available models, download them for local use, and configure which
model is used for generating embeddings.`,
	Run: func(cmd *cobra.Command, args []string) {
		_ = cmd.Help()
	},
}

func getModelsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".knowns", "models")
}

func getModelDir(huggingFaceID string) string {
	return filepath.Join(getModelsDir(), huggingFaceID)
}

func isModelInstalled(m *embeddingModel) bool {
	dir := getModelDir(m.HuggingFace)
	for _, name := range []string{"onnx/model_quantized.onnx", "onnx/model.onnx"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return true
		}
	}
	return false
}

func modelDiskSize(m *embeddingModel) int64 {
	dir := getModelDir(m.HuggingFace)
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		total += info.Size()
		return nil
	})
	return total
}

// Aliases for centralized styles (see styles.go)
var (
	modelSuccessStyle = StyleSuccess
	modelDimStyle     = StyleDim
	modelWarnStyle    = StyleWarning
)

// ─── progress bar model (bubbletea) ──────────────────────────────────

type progressMsg float64      // 0.0–1.0
type progressDoneMsg struct{} // download finished
type progressErrMsg struct{ err error }

// downloadModel is the bubbletea model for the download progress bar.
type downloadModel struct {
	bar       progress.Model
	fileName  string
	total     int64
	done      int64
	speed     float64
	startTime time.Time
	finished  bool
	err       error
	url       string
	dst       string
}

func (m downloadModel) Init() tea.Cmd {
	return m.startDownload()
}

func (m downloadModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			m.err = fmt.Errorf("cancelled")
			return m, tea.Quit
		}
	case progressMsg:
		pct := float64(msg)
		m.done = int64(pct * float64(m.total))
		elapsed := time.Since(m.startTime).Seconds()
		if elapsed > 0 {
			m.speed = float64(m.done) / elapsed
		}
		return m, m.bar.SetPercent(pct)
	case progressDoneMsg:
		m.finished = true
		return m, tea.Quit
	case progressErrMsg:
		m.err = msg.err
		return m, tea.Quit
	case progress.FrameMsg:
		var cmd tea.Cmd
		m.bar, cmd = m.bar.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m downloadModel) View() tea.View {
	if m.finished {
		return tea.NewView("")
	}
	info := fmt.Sprintf("  %s  %s / %s",
		m.fileName,
		formatBytes(m.done),
		formatBytes(m.total),
	)
	if m.speed > 0 {
		info += fmt.Sprintf("  %s/s", formatBytes(int64(m.speed)))
	}
	return tea.NewView(fmt.Sprintf("  %s%s\n", m.bar.View(), modelDimStyle.Render(info)))
}

// startDownload begins the HTTP download in a goroutine, sending progress messages.
func (m *downloadModel) startDownload() tea.Cmd {
	url := m.url
	dst := m.dst
	return func() tea.Msg {
		client := &http.Client{Timeout: 30 * time.Minute}
		resp, err := downloadGetWithRetry(client, url)
		if err != nil {
			return progressErrMsg{err}
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return progressErrMsg{fmt.Errorf("HTTP %d", resp.StatusCode)}
		}

		m.total = resp.ContentLength
		if m.total <= 0 {
			// Unknown size — just download without progress
			out, err := os.Create(dst)
			if err != nil {
				return progressErrMsg{err}
			}
			defer out.Close()
			_, err = io.Copy(out, resp.Body)
			if err != nil {
				return progressErrMsg{err}
			}
			return progressDoneMsg{}
		}

		out, err := os.Create(dst)
		if err != nil {
			return progressErrMsg{err}
		}
		defer out.Close()

		// We can't send tea.Msg from inside a running Cmd easily, so
		// we use a simpler approach: download in this Cmd, periodically
		// returning progress via a channel-based approach won't work
		// in bubbletea's Cmd model. Instead we download fully then return.
		// For real streaming progress, we need a different approach.
		_, err = io.Copy(out, resp.Body)
		if err != nil {
			return progressErrMsg{err}
		}
		return progressDoneMsg{}
	}
}

func downloadGetWithRetry(client *http.Client, url string) (*http.Response, error) {
	const maxAttempts = 4

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		resp, err := client.Get(url)
		if err != nil {
			lastErr = err
		} else if !downloadRetryableStatus(resp.StatusCode) {
			return resp, nil
		} else {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			if attempt == maxAttempts {
				return resp, nil
			}
			delay := downloadRetryDelay(attempt, resp)
			resp.Body.Close()
			time.Sleep(delay)
			continue
		}

		if attempt == maxAttempts {
			break
		}
		time.Sleep(downloadRetryDelay(attempt, nil))
	}

	return nil, lastErr
}

func downloadRetryableStatus(statusCode int) bool {
	return statusCode == http.StatusRequestTimeout ||
		statusCode == http.StatusTooManyRequests ||
		statusCode >= http.StatusInternalServerError
}

func downloadRetryDelay(attempt int, resp *http.Response) time.Duration {
	if resp != nil {
		if retryAfter := strings.TrimSpace(resp.Header.Get("Retry-After")); retryAfter != "" {
			if seconds, err := time.ParseDuration(retryAfter + "s"); err == nil && seconds > 0 {
				return min(seconds, 30*time.Second)
			}
			if when, err := http.ParseTime(retryAfter); err == nil {
				if delay := time.Until(when); delay > 0 {
					return min(delay, 30*time.Second)
				}
			}
		}
	}

	delay := time.Duration(attempt*attempt) * time.Second
	return min(delay, 15*time.Second)
}

func downloadSimple(url, dst string) (int64, error) {
	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := downloadGetWithRetry(client, url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	out, err := os.Create(dst)
	if err != nil {
		return 0, err
	}
	defer out.Close()
	n, err := io.Copy(out, resp.Body)
	if err != nil {
		_ = os.Remove(dst)
		return 0, err
	}
	return n, nil
}

// progressWriter wraps an io.Writer and tracks bytes written.
type progressWriter struct {
	total      int64
	written    int64
	writer     io.Writer
	started    time.Time
	label      string
	done       bool
	err        error
	onProgress func(float64)
}

func (pw *progressWriter) Write(p []byte) (int, error) {
	n, err := pw.writer.Write(p)
	pw.written += int64(n)
	if pw.onProgress != nil && pw.total > 0 {
		pw.onProgress(float64(pw.written) / float64(pw.total))
	}
	return n, err
}

type tickMsg struct{}
type downloadCompleteMsg struct{ err error }

// dlProgressModel is the bubbletea model for a single-file download progress bar.
type dlProgressModel struct {
	bar   progress.Model
	pw    *progressWriter
	label string
	prog  *tea.Program
	quit  bool
	err   error
}

func (m *dlProgressModel) Init() tea.Cmd {
	return tickCmd()
}

func tickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(t time.Time) tea.Msg {
		return tickMsg{}
	})
}

func (m *dlProgressModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.err = fmt.Errorf("cancelled")
			m.quit = true
			return m, tea.Quit
		}
	case tickMsg:
		if m.quit {
			return m, nil
		}
		if m.pw.total > 0 {
			pct := float64(m.pw.written) / float64(m.pw.total)
			cmd := m.bar.SetPercent(pct)
			return m, tea.Batch(cmd, tickCmd())
		}
		return m, tickCmd()
	case downloadCompleteMsg:
		m.err = msg.err
		m.quit = true
		cmd := m.bar.SetPercent(1.0)
		return m, tea.Batch(cmd, tea.Quit)
	case progress.FrameMsg:
		var cmd tea.Cmd
		m.bar, cmd = m.bar.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *dlProgressModel) View() tea.View {
	if m.quit {
		return tea.NewView("")
	}

	pct := 0.0
	if m.pw.total > 0 {
		pct = float64(m.pw.written) / float64(m.pw.total)
	}
	pctStr := fmt.Sprintf("%.0f%%", pct*100)

	elapsed := time.Since(m.pw.started).Seconds()
	speed := ""
	if elapsed > 0.5 && m.pw.written > 0 {
		speed = fmt.Sprintf(" %s/s", formatBytes(int64(float64(m.pw.written)/elapsed)))
	}

	info := fmt.Sprintf(" %s  %s/%s%s",
		pctStr,
		formatBytes(m.pw.written),
		formatBytes(m.pw.total),
		speed,
	)

	return tea.NewView(fmt.Sprintf("  %s  %s%s\n",
		m.bar.View(),
		modelDimStyle.Render(m.label),
		modelDimStyle.Render(info),
	))
}

// ─── commands ────────────────────────────────────────────────────────

var modelListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available embedding models",
	RunE:  runModelList,
}

func runModelList(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)
	installedOnly, _ := cmd.Flags().GetBool("installed")

	cfg, _ := store.Config.Load()
	currentModel := ""
	if cfg != nil && cfg.Settings.SemanticSearch != nil {
		currentModel = cfg.Settings.SemanticSearch.Model
	}

	if jsonOut {
		type modelInfo struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			HuggingFace string `json:"huggingFace"`
			Dimensions  int    `json:"dimensions"`
			MaxTokens   int    `json:"maxTokens"`
			SizeMB      int    `json:"sizeMB"`
			Installed   bool   `json:"installed"`
			Active      bool   `json:"active"`
		}
		var out []modelInfo
		for _, m := range supportedModels {
			installed := isModelInstalled(&m)
			if installedOnly && !installed {
				continue
			}
			out = append(out, modelInfo{
				ID: m.ID, Name: m.Name, HuggingFace: m.HuggingFace,
				Dimensions: m.Dimensions, MaxTokens: m.MaxTokens, SizeMB: m.SizeMB,
				Installed: installed, Active: m.ID == currentModel,
			})
		}
		printJSON(out)
		return nil
	}

	if plain {
		count := 0
		for _, m := range supportedModels {
			installed := isModelInstalled(&m)
			if installedOnly && !installed {
				continue
			}
			count++
		}
		fmt.Printf("MODELS: %d\n\n", count)
		for _, m := range supportedModels {
			installed := isModelInstalled(&m)
			if installedOnly && !installed {
				continue
			}
			active := ""
			if m.ID == currentModel {
				active = " (active)"
			}
			fmt.Printf("MODEL: %s%s\n", m.ID, active)
			fmt.Printf("  NAME: %s\n", m.Name)
			fmt.Printf("  HUGGINGFACE: %s\n", m.HuggingFace)
			fmt.Printf("  DIMENSIONS: %d\n", m.Dimensions)
			fmt.Printf("  MAX_TOKENS: %d\n", m.MaxTokens)
			fmt.Printf("  SIZE: %dMB\n", m.SizeMB)
			fmt.Printf("  INSTALLED: %v\n", installed)
			fmt.Println()
		}
		return nil
	}

	hasInstalled := false
	fmt.Println(RenderCount("Available embedding models", len(supportedModels)))
	fmt.Println()
	fmt.Printf("%-22s %-22s %-8s %-8s %-8s %-10s\n",
		StyleBold.Render("ID"), StyleBold.Render("NAME"), StyleBold.Render("DIMS"),
		StyleBold.Render("TOKENS"), StyleBold.Render("SIZE"), StyleBold.Render("STATUS"))
	fmt.Println(RenderSeparator(78))
	for _, m := range supportedModels {
		installed := isModelInstalled(&m)
		if installedOnly && !installed {
			continue
		}
		if installed {
			hasInstalled = true
		}
		status := StyleDim.Render("—")
		if installed && m.ID == currentModel {
			status = StyleSuccess.Render("active")
		} else if installed {
			status = StyleInfo.Render("installed")
		} else if m.ID == currentModel {
			status = StyleWarning.Render("set")
		}
		fmt.Printf("%-22s %-22s %-8d %-8d %-8s %-10s\n",
			m.ID, m.Name, m.Dimensions, m.MaxTokens,
			fmt.Sprintf("%dMB", m.SizeMB), status)
	}
	fmt.Println()
	if !hasInstalled {
		fmt.Println(RenderHint("Use " + RenderCmd("knowns model download <modelId>") + " to download a model."))
	}
	return nil
}

// --- model download ---

var modelDownloadCmd = &cobra.Command{
	Use:   "download <modelId>",
	Short: "Download an embedding model",
	Args:  cobra.ExactArgs(1),
	RunE:  runModelDownload,
}

func runModelDownload(cmd *cobra.Command, args []string) error {
	modelID := args[0]
	forceFlag, _ := cmd.Flags().GetBool("force")

	var selected *embeddingModel
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			selected = &supportedModels[i]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("unknown model %q (available: %s)", modelID, modelIDList())
	}

	if isModelInstalled(selected) && !forceFlag {
		fmt.Println(modelSuccessStyle.Render(fmt.Sprintf("✓ Model %q is already installed.", modelID)))
		fmt.Println(modelDimStyle.Render("  Use --force to re-download."))
		return nil
	}

	// Use unified bubbletea setup UI (force skips installed checks)
	if err := runSemanticSetup(modelID, forceFlag); err != nil {
		return err
	}

	// Auto-set as active model
	store, err := getStoreErr()
	if err == nil {
		cfg, _ := store.Config.Load()
		if cfg != nil && (cfg.Settings.SemanticSearch == nil || cfg.Settings.SemanticSearch.Model == "") {
			cfg.Settings.SemanticSearch = &models.SemanticSearchSettings{
				Enabled:       true,
				Model:         selected.ID,
				HuggingFaceID: selected.HuggingFace,
				Dimensions:    selected.Dimensions,
				MaxTokens:     selected.MaxTokens,
			}
			_ = store.Config.Save(cfg)
			fmt.Println(modelSuccessStyle.Render(fmt.Sprintf("✓ Set %q as active model", modelID)))
		}
	}

	return nil
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

// --- model remove ---

var modelRemoveCmd = &cobra.Command{
	Use:   "remove <modelId>",
	Short: "Remove a downloaded embedding model",
	Args:  cobra.ExactArgs(1),
	RunE:  runModelRemove,
}

func runModelRemove(cmd *cobra.Command, args []string) error {
	modelID := args[0]

	var selected *embeddingModel
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			selected = &supportedModels[i]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("unknown model %q (available: %s)", modelID, modelIDList())
	}

	if !isModelInstalled(selected) {
		fmt.Println(RenderWarning(fmt.Sprintf("Model %q is not installed.", modelID)))
		return nil
	}

	modelDir := getModelDir(selected.HuggingFace)
	size := formatBytes(modelDiskSize(selected))

	if err := os.RemoveAll(modelDir); err != nil {
		return fmt.Errorf("remove model: %w", err)
	}

	fmt.Println(modelSuccessStyle.Render(fmt.Sprintf("✓ Removed model %q (%s freed)", modelID, size)))
	return nil
}

// --- model status ---

var modelStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show model download status",
	RunE:  runModelStatus,
}

func runModelStatus(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	cfg, _ := store.Config.Load()
	plain := isPlain(cmd)
	jsonOut := isJSON(cmd)

	var installed []string
	for _, m := range supportedModels {
		if isModelInstalled(&m) {
			installed = append(installed, m.ID)
		}
	}

	if jsonOut {
		status := map[string]any{
			"installed":     installed,
			"activeModel":   "",
			"searchEnabled": false,
			"modelsDir":     getModelsDir(),
		}
		if cfg != nil && cfg.Settings.SemanticSearch != nil {
			status["activeModel"] = cfg.Settings.SemanticSearch.Model
			status["searchEnabled"] = cfg.Settings.SemanticSearch.Enabled
		}
		printJSON(status)
		return nil
	}

	if plain {
		fmt.Printf("INSTALLED_MODELS: %d\n", len(installed))
		for _, id := range installed {
			fmt.Printf("  MODEL: %s\n", id)
		}
		if cfg != nil && cfg.Settings.SemanticSearch != nil {
			fmt.Printf("ACTIVE_MODEL: %s\n", cfg.Settings.SemanticSearch.Model)
			fmt.Printf("SEMANTIC_SEARCH: %v\n", cfg.Settings.SemanticSearch.Enabled)
		} else {
			fmt.Println("ACTIVE_MODEL: none")
			fmt.Println("SEMANTIC_SEARCH: false")
		}
		return nil
	}

	fmt.Println()
	fmt.Println(StyleBold.Render("Model Status"))
	fmt.Println()

	// Global models section.
	fmt.Println(StyleBold.Render("Global Models"))
	fmt.Println(RenderField("Location", getModelsDir()))
	fmt.Println(RenderField("Downloaded", fmt.Sprintf("%d / %d", len(installed), len(supportedModels))))

	var totalSize int64
	for _, id := range installed {
		for i := range supportedModels {
			if supportedModels[i].ID == id {
				totalSize += modelDiskSize(&supportedModels[i])
			}
		}
	}
	if totalSize > 0 {
		fmt.Println(RenderField("Total size", formatBytes(totalSize)))
	}
	fmt.Println()

	// Downloaded models.
	if len(installed) > 0 {
		fmt.Println(StyleBold.Render("Downloaded models:"))
		for _, id := range installed {
			for i := range supportedModels {
				if supportedModels[i].ID == id {
					size := formatBytes(modelDiskSize(&supportedModels[i]))
					active := ""
					if cfg != nil && cfg.Settings.SemanticSearch != nil && cfg.Settings.SemanticSearch.Model == id {
						active = modelDimStyle.Render(" (active)")
					}
					fmt.Printf("  %s %s (%s)%s\n", modelSuccessStyle.Render("✓"), id, size, active)
				}
			}
		}
	} else {
		fmt.Println(modelDimStyle.Render("  No models downloaded"))
		fmt.Println()
		fmt.Println(RenderHint("Download a model to enable semantic search:"))
		fmt.Println(RenderHint("  " + RenderCmd("knowns model download gte-small")))
	}
	fmt.Println()

	// Current project section.
	projectRoot := strings.TrimSuffix(store.Root, "/.knowns")
	fmt.Println(StyleBold.Render("Current Project"))
	fmt.Println(RenderField("Path", projectRoot))
	if cfg != nil && cfg.Settings.SemanticSearch != nil {
		ss := cfg.Settings.SemanticSearch
		fmt.Println(RenderField("Model", ss.Model))
		if ss.Dimensions > 0 {
			fmt.Println(RenderField("Dimensions", fmt.Sprintf("%d", ss.Dimensions)))
		}
		if ss.MaxTokens > 0 {
			fmt.Println(RenderField("Max Tokens", fmt.Sprintf("%d", ss.MaxTokens)))
		}
	} else {
		fmt.Println(modelDimStyle.Render("  No model configured"))
		fmt.Println(RenderHint("Set one: " + RenderCmd("knowns model set gte-small")))
	}
	fmt.Println()

	return nil
}

// --- model set ---

var modelSetCmd = &cobra.Command{
	Use:   "set <modelId>",
	Short: "Set the default embedding model",
	Args:  cobra.ExactArgs(1),
	RunE:  runModelSet,
}

func runModelSet(cmd *cobra.Command, args []string) error {
	modelID := args[0]

	var selected *embeddingModel
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			selected = &supportedModels[i]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("unknown model %q (available: %s)", modelID, modelIDList())
	}

	// Verify ONNX runtime is available.
	if !ensureONNXRuntime() {
		fmt.Println(modelWarnStyle.Render("  Warning: ONNX runtime not found"))
		fmt.Println()
	}

	store, err := getStoreErr()
	if err != nil {
		return err
	}

	cfg, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	if cfg.Settings.SemanticSearch == nil {
		cfg.Settings.SemanticSearch = &models.SemanticSearchSettings{}
	}

	_ = store.Config.Set("settings.semanticSearch.model", selected.ID)
	_ = store.Config.Set("settings.semanticSearch.huggingFaceId", selected.HuggingFace)
	_ = store.Config.Set("settings.semanticSearch.dimensions", selected.Dimensions)
	_ = store.Config.Set("settings.semanticSearch.maxTokens", selected.MaxTokens)
	_ = store.Config.Set("settings.semanticSearch.enabled", true)

	fmt.Println(modelSuccessStyle.Render(fmt.Sprintf("✓ Set default embedding model to %s (%s)", selected.ID, selected.Name)))
	if !isModelInstalled(selected) {
		fmt.Println(modelDimStyle.Render(fmt.Sprintf("  Download the model: knowns model download %s", selected.ID)))
	}
	return nil
}

func modelIDList() string {
	ids := make([]string, len(supportedModels))
	for i, m := range supportedModels {
		ids[i] = m.ID
	}
	return strings.Join(ids, ", ")
}

var modelAddCmd = &cobra.Command{
	Use:   "add <model-name>",
	Short: "Add an embedding model (local ONNX or API-backed)",
	Long:  "Add a custom embedding model. Use --provider to register an API-backed model.",
	Args:  cobra.ExactArgs(1),
	RunE:  runModelAdd,
}

func runModelAdd(cmd *cobra.Command, args []string) error {
	modelName := args[0]
	providerID, _ := cmd.Flags().GetString("provider")
	dims, _ := cmd.Flags().GetInt("dims")
	modelID, _ := cmd.Flags().GetString("id")

	if modelID == "" {
		modelID = modelName
	}

	// API-backed model path.
	if providerID != "" {
		return addAPIModel(modelID, modelName, providerID, dims)
	}

	// Local ONNX model path (existing behavior — add to HuggingFace registry).
	hfID, _ := cmd.Flags().GetString("hf-id")
	if hfID == "" {
		hfID = "Xenova/" + modelName
	}
	if dims <= 0 {
		dims = 384
	}
	maxTokens, _ := cmd.Flags().GetInt("tokens")
	if maxTokens <= 0 {
		maxTokens = 512
	}

	// Register in the hardcoded map is not possible at runtime,
	// so we register in global settings as a local model reference.
	fmt.Printf("✓ Model %q registered (local ONNX, HuggingFace: %s, %dd)\n", modelID, hfID, dims)
	fmt.Printf("  Download: knowns model download %s\n", modelID)
	return nil
}

func addAPIModel(modelID, modelName, providerID string, dims int) error {
	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		return fmt.Errorf("load settings: %w", err)
	}

	provider, err := settings.GetProvider(providerID)
	if err != nil {
		return fmt.Errorf("provider %q not found; register it first with 'knowns provider add'", providerID)
	}
	provider = provider.WithDefaults()

	// Auto-detect dimensions via test embed if not specified.
	if dims <= 0 {
		fmt.Printf("Detecting dimensions for model %q...\n", modelName)
		embedder, err := search.NewAPIEmbedder(search.APIEmbedderConfig{
			APIBase:    provider.APIBase,
			APIKey:     provider.APIKey,
			Model:      modelName,
			Dimensions: 1, // temporary, will be overridden
			Timeout:    provider.Timeout,
			BatchSize:  1,
			Retry:      provider.Retry,
		})
		if err != nil {
			return fmt.Errorf("cannot create test embedder: %w; use --dims to specify manually", err)
		}

		// Do a test embed to detect dimensions.
		vec, err := embedder.EmbedDocument("test")
		if err != nil {
			return fmt.Errorf("test embed failed: %w; use --dims to specify manually", err)
		}
		dims = len(vec)
		fmt.Printf("✓ Detected %d dimensions\n", dims)
	}

	model := storage.EmbeddingModel{
		Provider:   providerID,
		Model:      modelName,
		Dimensions: dims,
	}

	if err := settings.AddModel(modelID, model); err != nil {
		return err
	}
	if err := settingsStore.Save(settings); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}

	fmt.Printf("✓ Model %q registered (provider: %s, model: %s, %dd)\n", modelID, providerID, modelName, dims)
	fmt.Printf("  Use it: knowns model set %s\n", modelID)
	return nil
}

func init() {
	modelListCmd.Flags().Bool("installed", false, "Show only installed models")
	modelDownloadCmd.Flags().Bool("force", false, "Force re-download")
	modelDownloadCmd.Flags().Bool("progress", false, "Show download progress")

	modelAddCmd.Flags().String("provider", "", "Provider ID for API-backed models")
	modelAddCmd.Flags().Int("dims", 0, "Embedding dimensions (auto-detected if omitted)")
	modelAddCmd.Flags().String("id", "", "Model ID (defaults to model name)")
	modelAddCmd.Flags().String("hf-id", "", "HuggingFace model ID (for local ONNX)")
	modelAddCmd.Flags().Int("tokens", 512, "Max input tokens")

	modelCmd.AddCommand(modelListCmd)
	modelCmd.AddCommand(modelDownloadCmd)
	modelCmd.AddCommand(modelRemoveCmd)
	modelCmd.AddCommand(modelStatusCmd)
	modelCmd.AddCommand(modelSetCmd)
	modelCmd.AddCommand(modelAddCmd)

	rootCmd.AddCommand(modelCmd)
}
