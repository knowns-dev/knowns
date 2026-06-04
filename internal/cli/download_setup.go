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
	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

// ─── download step ───────────────────────────────────────────────────

type downloadStep struct {
	label   string
	url     string
	dst     string
	size    int64 // populated at runtime from HEAD
	written int64
	done    bool
	err     error
	// post-download hook (e.g. extract archive)
	postHook func(dst string) error
}

// ─── multi-step setup model (bubbletea) ──────────────────────────────

type setupModel struct {
	steps    []downloadStep
	current  int
	bar      progress.Model
	spinner  spinner.Model
	started  time.Time
	quitting bool
	err      error

	// background download state
	resp    *http.Response
	outFile *os.File
	doneCh  chan error
}

// setupTickMsg triggers periodic UI refresh during download.
type setupTickMsg struct{}

// setupStepDoneMsg signals current step finished downloading.
type setupStepDoneMsg struct{ err error }

// setupPostHookDoneMsg signals post-hook finished.
type setupPostHookDoneMsg struct{ err error }

func newSetupModel(steps []downloadStep) *setupModel {
	bar := NewBrandProgressBar(
		progress.WithoutPercentage(),
	)
	sp := spinner.New(
		spinner.WithSpinner(spinner.Dot),
		spinner.WithStyle(StyleDim),
	)
	return &setupModel{
		steps:   steps,
		bar:     bar,
		spinner: sp,
		started: time.Now(),
	}
}

func (m *setupModel) Init() tea.Cmd {
	return tea.Batch(
		m.spinner.Tick,
		m.startCurrentStep(),
	)
}

func (m *setupModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.err = fmt.Errorf("cancelled")
			m.quitting = true
			m.cleanup()
			return m, tea.Quit
		}

	case setupTickMsg:
		if m.quitting {
			return m, nil
		}
		step := &m.steps[m.current]
		if step.size > 0 {
			pct := float64(step.written) / float64(step.size)
			cmd := m.bar.SetPercent(pct)
			return m, tea.Batch(cmd, m.tickCmd())
		}
		return m, m.tickCmd()

	case setupStepDoneMsg:
		step := &m.steps[m.current]
		if msg.err != nil {
			step.err = msg.err
			m.err = msg.err
			m.quitting = true
			return m, tea.Quit
		}
		// Run post-hook if present
		if step.postHook != nil {
			return m, func() tea.Msg {
				err := step.postHook(step.dst)
				return setupPostHookDoneMsg{err: err}
			}
		}
		return m, m.advanceStep()

	case setupPostHookDoneMsg:
		if msg.err != nil {
			m.steps[m.current].err = msg.err
			m.err = msg.err
			m.quitting = true
			return m, tea.Quit
		}
		return m, m.advanceStep()

	case progress.FrameMsg:
		var cmd tea.Cmd
		m.bar, cmd = m.bar.Update(msg)
		return m, cmd

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m *setupModel) View() tea.View {
	var b strings.Builder

	for i, step := range m.steps {
		if step.done {
			sizeInfo := ""
			if step.written > 0 {
				sizeInfo = StyleDim.Render(fmt.Sprintf(" (%s)", formatBytes(step.written)))
			}
			b.WriteString(fmt.Sprintf("  %s %s%s\n",
				StyleSuccess.Render("✓"),
				step.label,
				sizeInfo,
			))
		} else if i == m.current && !m.quitting {
			// Active step
			pct := 0.0
			if step.size > 0 {
				pct = float64(step.written) / float64(step.size)
			}
			pctStr := fmt.Sprintf("%.0f%%", pct*100)

			elapsed := time.Since(m.started).Seconds()
			speed := ""
			if elapsed > 0.5 && step.written > 0 {
				speed = fmt.Sprintf("  %s/s", formatBytes(int64(float64(step.written)/elapsed)))
			}

			sizeInfo := ""
			if step.size > 0 {
				sizeInfo = fmt.Sprintf("  %s/%s", formatBytes(step.written), formatBytes(step.size))
			}

			b.WriteString(fmt.Sprintf("  %s %s\n", m.spinner.View(), step.label))
			b.WriteString(fmt.Sprintf("    %s %s%s%s\n",
				m.bar.View(),
				StyleDim.Render(pctStr),
				StyleDim.Render(sizeInfo),
				StyleDim.Render(speed),
			))
		} else if step.err != nil {
			b.WriteString(fmt.Sprintf("  %s %s %s\n",
				StyleWarning.Render("✗"),
				step.label,
				StyleWarning.Render(step.err.Error()),
			))
		} else {
			b.WriteString(fmt.Sprintf("  %s %s\n",
				StyleDim.Render("○"),
				StyleDim.Render(step.label),
			))
		}
	}

	return tea.NewView(b.String())
}

func (m *setupModel) tickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(t time.Time) tea.Msg {
		return setupTickMsg{}
	})
}

func (m *setupModel) advanceStep() tea.Cmd {
	m.steps[m.current].done = true
	m.current++
	if m.current >= len(m.steps) {
		m.quitting = true
		return tea.Quit
	}
	m.started = time.Now()
	return m.startCurrentStep()
}

func (m *setupModel) startCurrentStep() tea.Cmd {
	step := &m.steps[m.current]
	url := step.url
	dst := step.dst

	return func() tea.Msg {
		client := &http.Client{Timeout: 30 * time.Minute}

		// HEAD to get content length
		headResp, err := client.Head(url)
		if err == nil {
			step.size = headResp.ContentLength
			headResp.Body.Close()
		}

		// Ensure parent dir
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return setupStepDoneMsg{err: err}
		}

		resp, err := downloadGetWithRetry(client, url)
		if err != nil {
			return setupStepDoneMsg{err: err}
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return setupStepDoneMsg{err: fmt.Errorf("HTTP %d", resp.StatusCode)}
		}

		if step.size <= 0 {
			step.size = resp.ContentLength
		}

		outFile, err := os.Create(dst)
		if err != nil {
			resp.Body.Close()
			return setupStepDoneMsg{err: err}
		}

		// Stream download with progress tracking
		buf := make([]byte, 32*1024)
		for {
			n, readErr := resp.Body.Read(buf)
			if n > 0 {
				if _, writeErr := outFile.Write(buf[:n]); writeErr != nil {
					outFile.Close()
					resp.Body.Close()
					return setupStepDoneMsg{err: writeErr}
				}
				step.written += int64(n)
			}
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				outFile.Close()
				resp.Body.Close()
				return setupStepDoneMsg{err: readErr}
			}
		}

		outFile.Close()
		resp.Body.Close()
		return setupStepDoneMsg{err: nil}
	}
}

func (m *setupModel) cleanup() {
	if m.resp != nil {
		m.resp.Body.Close()
	}
	if m.outFile != nil {
		m.outFile.Close()
	}
}

// ─── public API ──────────────────────────────────────────────────────

// buildSemanticDownloadSteps returns initSteps for downloading ONNX Runtime
// and embedding model files. Returns (steps, alreadyInstalled, error).
// Used by the init command to integrate downloads into the progressive step UI.
func buildSemanticDownloadSteps(modelID string) ([]initStep, bool, error) {
	var selected *embeddingModel
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			selected = &supportedModels[i]
			break
		}
	}
	if selected == nil {
		return nil, false, fmt.Errorf("unknown model %q", modelID)
	}

	// Model files are downloaded lazily on first embed call,
	// using transformers.js's own cache layout.
	if isModelInstalled(selected) {
		return nil, true, nil
	}
	return nil, true, nil
}

// runSemanticSetup downloads ONNX Runtime (if needed) and the embedding model
// using a unified bubbletea multi-step progress UI.
// Pass force=true to re-download even if already installed.
func runSemanticSetup(modelID string, force ...bool) error {
	forceDownload := len(force) > 0 && force[0]

	// Find the model
	var selected *embeddingModel
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			selected = &supportedModels[i]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("unknown model %q", modelID)
	}

	if !forceDownload && isModelInstalled(selected) {
		return nil
	}

	// Build download steps
	var steps []downloadStep

	// Model files (lazy-download via transformers.js cache;
	// pre-download is optional, intended for offline-prep).
	if forceDownload || !isModelInstalled(selected) {
		modelDir := getModelDir(selected.HuggingFace)
		for _, file := range selected.Files {
			url := fmt.Sprintf("https://huggingface.co/%s/resolve/main/%s", selected.HuggingFace, file)
			dst := filepath.Join(modelDir, file)
			steps = append(steps, downloadStep{
				label: fmt.Sprintf("%s — %s", selected.Name, file),
				url:   url,
				dst:   dst,
			})
		}
	}

	if len(steps) == 0 {
		fmt.Println(StyleSuccess.Render("✓ Semantic search already set up"))
		return nil
	}

	fmt.Println()
	fmt.Printf("  %s\n\n", RenderInfo(fmt.Sprintf("Setting up semantic search (%d downloads)...", len(steps))))

	if !isTTY() {
		for i, step := range steps {
			if err := os.MkdirAll(filepath.Dir(step.dst), 0755); err != nil {
				return err
			}
			n, err := downloadSimple(step.url, step.dst)
			if err != nil {
				return err
			}
			if step.postHook != nil {
				if err := step.postHook(step.dst); err != nil {
					return err
				}
			}
			fmt.Printf("  %s %s (%d/%d, %s)\n", StyleSuccess.Render("✓"), step.label, i+1, len(steps), formatBytes(n))
		}
		fmt.Println()
		fmt.Println(StyleSuccess.Render("✓ Semantic search ready"))
		return nil
	}

	// Drain any pending terminal escape responses from prior bubbletea/huh
	// programs to prevent ^[[?2026;2$y leak in output.
	drainStdin()

	m := newSetupModel(steps)
	p := tea.NewProgram(m, tea.WithInput(os.Stdin))
	if _, err := p.Run(); err != nil {
		return err
	}

	if m.err != nil {
		return m.err
	}

	fmt.Println()
	fmt.Println(StyleSuccess.Render("✓ Semantic search ready"))
	return nil
}

// ensureONNXRuntime reports whether the ONNX runtime library is available.
func ensureONNXRuntime() bool {
	avail, _ := search.IsONNXAvailable()
	return avail
}

func ensureSemanticStoreReady(store *storage.Store, defaultModelID string) (bool, error) {
	if store == nil {
		return false, fmt.Errorf("store is required")
	}
	if err := ensureSemanticStoreInitialized(store); err != nil {
		return false, err
	}
	changed, modelID, err := ensureSemanticConfig(store, defaultModelID)
	if err != nil {
		return false, err
	}
	if modelID == "" {
		return changed, nil
	}
	if err := runSemanticSetup(modelID); err != nil {
		return changed, err
	}
	return changed, nil
}

func ensureSemanticStoreInitialized(store *storage.Store) error {
	if store == nil {
		return fmt.Errorf("store is required")
	}
	if _, err := os.Stat(store.Root); err == nil {
		return nil
	}
	return store.Init(filepath.Base(filepath.Dir(store.Root)))
}

func ensureSemanticConfig(store *storage.Store, defaultModelID string) (bool, string, error) {
	if defaultModelID == "" {
		defaultModelID = "multilingual-e5-small"
	}
	model := findSupportedModel(defaultModelID)
	if model == nil {
		return false, "", fmt.Errorf("unknown model %q", defaultModelID)
	}
	cfg, err := store.Config.Load()
	if err != nil {
		return false, "", err
	}
	changed := false
	if cfg.Settings.SemanticSearch == nil {
		cfg.Settings.SemanticSearch = &models.SemanticSearchSettings{}
		changed = true
	}
	ss := cfg.Settings.SemanticSearch
	if ss.Model == "" {
		ss.Model = model.ID
		ss.HuggingFaceID = model.HuggingFace
		ss.Dimensions = model.Dimensions
		ss.MaxTokens = model.MaxTokens
		changed = true
	}
	if !ss.Enabled {
		ss.Enabled = true
		changed = true
	}
	if changed {
		if err := store.Config.Save(cfg); err != nil {
			return false, "", err
		}
	}
	return changed, ss.Model, nil
}

func findSupportedModel(modelID string) *embeddingModel {
	for i := range supportedModels {
		if supportedModels[i].ID == modelID {
			return &supportedModels[i]
		}
	}
	return nil
}

func ensureProjectAndGlobalSemanticReady(projectStore *storage.Store, defaultModelID string) (bool, bool, error) {
	projectChanged, err := ensureSemanticStoreReady(projectStore, defaultModelID)
	if err != nil {
		return false, false, err
	}
	globalChanged, err := ensureSemanticStoreReady(storage.NewGlobalSemanticStore(), defaultModelID)
	if err != nil {
		return projectChanged, false, err
	}
	// Print ready message once after both stores are set up.
	fmt.Println(StyleSuccess.Render(fmt.Sprintf("✓ Semantic search ready (model: %s)", defaultModelID)))
	return projectChanged, globalChanged, nil
}
