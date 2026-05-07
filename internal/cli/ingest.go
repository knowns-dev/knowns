package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/progress"
	tea "charm.land/bubbletea/v2"
	"github.com/spf13/cobra"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

var ingestCmd = &cobra.Command{
	Use:   "ingest",
	Short: "Index code files using AST-based code intelligence",
	Long: `Index all code files in the project using tree-sitter AST parsing.

This command walks the project directory, parses AST for Go, TypeScript,
JavaScript, Python, Java, Rust, and C# files, and stores code symbols as
indexed code data.

Files matching .gitignore and test files (*_test.go, *.spec.ts, etc.)
are skipped by default. Use --include-tests to include them.

Examples:
  knowns code ingest              # Index all code files
  knowns code ingest --dry-run    # Preview what would be indexed
  knowns code ingest --include-tests  # Include test files`,
	RunE: runIngest,
}

var ingestDryRun bool
var ingestIncludeTests bool
var ingestBackground bool
var ingestFull bool

func registerIngestFlags(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&ingestDryRun, "dry-run", false, "Print what would be indexed without writing to disk")
	cmd.Flags().BoolVar(&ingestIncludeTests, "include-tests", false, "Include test files in indexing")
	cmd.Flags().BoolVar(&ingestBackground, "background", false, "Enqueue to shared runtime daemon and return; follow with `knowns runtime ps --watch`")
	cmd.Flags().BoolVar(&ingestFull, "full", false, "Force full re-ingest, ignoring cached hashes")
}

func init() {
	registerIngestFlags(ingestCmd)
}

// ─── ingest progress model (bubbletea) ───────────────────────────────

type ingestPhase struct {
	name    string
	total   int
	current int
}

type ingestState struct {
	phase     string
	processed int
	total     int
	done      bool
	err       error
}

type ingestDoneMsg struct {
	err       error
	symCount  int
	fileCount int
	edgeCount int
}

type ingestModel struct {
	bar             progress.Model
	state           *ingestState
	quit            bool
	startTime       time.Time
	phaseStartTime  time.Time
	prog            *tea.Program
	lastPhase       string
	lastTotal       int
	completedPhases []struct {
		name  string
		count int
	}
	symCount  int
	fileCount int
	edgeCount int
}

func ingestTickCmd() tea.Cmd {
	return tea.Tick(80*time.Millisecond, func(t time.Time) tea.Msg {
		return reindexTickMsg{}
	})
}

func (m *ingestModel) Init() tea.Cmd {
	return ingestTickCmd()
}

func (m *ingestModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyPressMsg:
		if msg.String() == "ctrl+c" {
			m.quit = true
			return m, tea.Quit
		}
	case reindexTickMsg:
		if m.quit {
			return m, nil
		}
		if m.state.phase != m.lastPhase && m.lastPhase != "" {
			m.completedPhases = append(m.completedPhases, struct {
				name  string
				count int
			}{
				name:  m.lastPhase,
				count: m.lastTotal,
			})
			m.phaseStartTime = time.Now()
		}
		m.lastPhase = m.state.phase
		m.lastTotal = m.state.total

		pct := 0.0
		if m.state.total > 0 {
			pct = float64(m.state.processed) / float64(m.state.total)
		}
		cmd := m.bar.SetPercent(pct)
		return m, tea.Batch(cmd, ingestTickCmd())
	case ingestDoneMsg:
		if m.lastPhase != "" {
			m.completedPhases = append(m.completedPhases, struct {
				name  string
				count int
			}{
				name:  m.lastPhase,
				count: m.lastTotal,
			})
		}
		m.state.done = true
		m.state.err = msg.err
		m.symCount = msg.symCount
		m.fileCount = msg.fileCount
		m.edgeCount = msg.edgeCount
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

func (m *ingestModel) View() tea.View {
	var b strings.Builder

	if m.quit {
		for _, cp := range m.completedPhases {
			b.WriteString(fmt.Sprintf("  %s Indexed %s (%d)\n",
				searchSuccessStyle.Render("✓"), cp.name, cp.count))
		}
		return tea.NewView(b.String())
	}

	for _, cp := range m.completedPhases {
		b.WriteString(fmt.Sprintf("  %s Indexed %s (%d)\n",
			searchSuccessStyle.Render("✓"), cp.name, cp.count))
	}

	processed := m.state.processed
	total := m.state.total
	phase := m.state.phase

	elapsed := time.Since(m.phaseStartTime)
	eta := ""
	if elapsed.Seconds() > 0.5 && processed > 0 && processed < total {
		itemsPerSec := float64(processed) / elapsed.Seconds()
		remaining := float64(total-processed) / itemsPerSec
		if remaining >= 1 {
			eta = fmt.Sprintf("  %s remaining", formatDuration(int(remaining)))
		}
	}

	info := fmt.Sprintf("Indexing %s (%d/%d)%s", phase, processed, total, eta)
	b.WriteString(fmt.Sprintf("  %s  %s\n", m.bar.View(), searchDimStyle.Render(info)))
	return tea.NewView(b.String())
}

// runIngestWithProgress runs the ingest with a bubbletea progress UI.
// When forceFull is false, it uses two-tier delta detection:
//   - Tier 1: file hash (SHA-256) to skip parsing unchanged files
//   - Tier 2: chunk content hash to skip re-embedding unchanged symbols
func runIngestWithProgress(projectRoot string, includeTests bool, forceFull bool) (symCount, fileCount, edgeCount int, err error) {
	candidates, err := search.ListCodeCandidateFiles(projectRoot, includeTests)
	if err != nil {
		return 0, 0, 0, err
	}
	state := &ingestState{phase: "scanning files", total: len(candidates)}
	if state.total == 0 {
		state.total = 1
	}

	bar := NewBrandProgressBar()
	m := &ingestModel{
		bar:            bar,
		state:          state,
		startTime:      time.Now(),
		phaseStartTime: time.Now(),
	}

	p := tea.NewProgram(m, tea.WithInput(os.Stdin))
	m.prog = p

	go func() {
		store := getStore()
		embedder, vecStore, err := search.InitSemantic(store)
		if err != nil {
			p.Send(ingestDoneMsg{err: fmt.Errorf("init semantic search: %w", err)})
			return
		}
		defer embedder.Close()
		defer vecStore.Close()

		db := store.SemanticDBWritable()

		// Load cached file hashes (nil if first run or --full).
		var cachedHashes map[string]search.CodeFileHash
		if !forceFull && db != nil {
			cachedHashes, _ = search.LoadCodeFileHashes(db)
		}

		// ── Tier 1: File-level delta detection ──────────────────────
		var delta *search.DeltaResult

		if cachedHashes != nil && len(cachedHashes) > 0 {
			delta, err = search.ComputeFileDelta(projectRoot, candidates, cachedHashes)
			if err != nil {
				p.Send(ingestDoneMsg{err: fmt.Errorf("compute delta: %w", err)})
				return
			}
		}

		var allSymbols []search.CodeSymbol
		var allEdges []search.CodeEdge
		filesToParse := candidates // default: parse all

		if delta != nil {
			// Only parse changed + new files.
			filesToParse = append(delta.ChangedFiles, delta.NewFiles...)

			// For unchanged files, we need their symbols for edge resolution.
			// Re-parse them (fast, no embedding needed) to get symbol data.
			// This is necessary because we don't cache symbol data, only hashes.
			for _, rel := range delta.UnchangedFiles {
				absPath := filepath.Join(projectRoot, filepath.FromSlash(rel))
				syms, eds, parseErr := search.IndexFile(rel, absPath)
				if parseErr == nil {
					allSymbols = append(allSymbols, syms...)
					allEdges = append(allEdges, eds...)
				}
				state.processed++
			}
		}

		// ── Phase 1: Parse changed/new files ────────────────────────
		state.phase = "parsing files"
		state.total = len(filesToParse)
		if delta != nil {
			state.total = len(candidates)
			// Already processed unchanged files above.
		}
		if state.total == 0 {
			state.total = 1
		}
		p.Send(reindexTickMsg{})

		var changedSyms []search.CodeSymbol
		var changedEdges []search.CodeEdge
		for _, rel := range filesToParse {
			absPath := filepath.Join(projectRoot, filepath.FromSlash(rel))
			syms, eds, parseErr := search.IndexFile(rel, absPath)
			if parseErr == nil {
				changedSyms = append(changedSyms, syms...)
				changedEdges = append(changedEdges, eds...)
			}
			state.processed++
		}

		allSymbols = append(allSymbols, changedSyms...)
		allEdges = append(allEdges, changedEdges...)
		fileCount = countUniqueFiles(allSymbols)

		// ── Phase 2: Embed (with chunk-level delta) ─────────────────
		p.Send(reindexTickMsg{})
		state.phase = "embedding"
		state.processed = 0

		// Determine which chunks need embedding.
		type indexedChunk struct {
			idx   int
			chunk search.Chunk
		}

		// Build all chunks from all symbols.
		allChunks := make([]indexedChunk, 0, len(allSymbols))
		for i, sym := range allSymbols {
			allChunks = append(allChunks, indexedChunk{idx: i, chunk: sym.ToChunk()})
		}

		// Truncate embedding content.
		const maxEmbedChars = 2000
		for i := range allChunks {
			if len(allChunks[i].chunk.Content) > maxEmbedChars {
				allChunks[i].chunk.Content = allChunks[i].chunk.Content[:maxEmbedChars]
			}
		}

		// ── Tier 2: Chunk-level delta detection ─────────────────────
		var chunksToEmbed []indexedChunk
		var cachedChunks []search.Chunk
		newFileHashes := make(map[string]search.CodeFileHash)

		if delta != nil && !forceFull {
			// Build chunk hashes for all symbols and compare against cache.
			// Unchanged files: all their chunks are cached (skip embed).
			// Changed/new files: compare chunk hashes.
			unchangedFileSet := make(map[string]bool, len(delta.UnchangedFiles))
			for _, f := range delta.UnchangedFiles {
				unchangedFileSet[f] = true
			}

			for _, ic := range allChunks {
				contentHash := search.HashString(ic.chunk.Content)
				docPath := ic.chunk.DocPath

				// Track hash for saving later.
				fh, ok := newFileHashes[docPath]
				if !ok {
					absPath := filepath.Join(projectRoot, filepath.FromSlash(docPath))
					fileHash, _ := search.HashFileContent(absPath)
					fh = search.CodeFileHash{
						FilePath:    docPath,
						FileHash:    fileHash,
						ChunkHashes: make(map[string]string),
					}
				}
				fh.ChunkHashes[ic.chunk.ID] = contentHash
				newFileHashes[docPath] = fh

				if unchangedFileSet[docPath] {
					// Unchanged file — chunk is cached, no re-embed needed.
					cachedChunks = append(cachedChunks, ic.chunk)
					continue
				}

				// Changed or new file — check chunk hash.
				if prev, exists := cachedHashes[docPath]; exists {
					if prevHash, ok := prev.ChunkHashes[ic.chunk.ID]; ok && prevHash == contentHash {
						// Chunk content unchanged — skip embed.
						cachedChunks = append(cachedChunks, ic.chunk)
						continue
					}
				}

				// Needs embedding.
				chunksToEmbed = append(chunksToEmbed, ic)
			}

			// Remove deleted files from vector store.
			if len(delta.DeletedFiles) > 0 {
				var idsToRemove []string
				for _, delFile := range delta.DeletedFiles {
					if prev, exists := cachedHashes[delFile]; exists {
						for chunkID := range prev.ChunkHashes {
							idsToRemove = append(idsToRemove, chunkID)
						}
					}
					// Also remove file-level chunk.
					idsToRemove = append(idsToRemove, search.CodeChunkID(delFile, ""))
				}
				vecStore.RemoveByIDs(idsToRemove)
			}

			// Remove stale chunks from changed files (symbols that no longer exist).
			for _, changedFile := range delta.ChangedFiles {
				if prev, exists := cachedHashes[changedFile]; exists {
					newChunkIDs := make(map[string]bool)
					if fh, ok := newFileHashes[changedFile]; ok {
						for id := range fh.ChunkHashes {
							newChunkIDs[id] = true
						}
					}
					var staleIDs []string
					for oldID := range prev.ChunkHashes {
						if !newChunkIDs[oldID] {
							staleIDs = append(staleIDs, oldID)
						}
					}
					if len(staleIDs) > 0 {
						vecStore.RemoveByIDs(staleIDs)
					}
				}
			}
		} else {
			// Full ingest: embed everything, clear old data.
			vecStore.RemoveByPrefix("code::")
			chunksToEmbed = allChunks

			// Build file hashes for saving.
			for _, ic := range allChunks {
				contentHash := search.HashString(ic.chunk.Content)
				docPath := ic.chunk.DocPath
				fh, ok := newFileHashes[docPath]
				if !ok {
					absPath := filepath.Join(projectRoot, filepath.FromSlash(docPath))
					fileHash, _ := search.HashFileContent(absPath)
					fh = search.CodeFileHash{
						FilePath:    docPath,
						FileHash:    fileHash,
						ChunkHashes: make(map[string]string),
					}
				}
				fh.ChunkHashes[ic.chunk.ID] = contentHash
				newFileHashes[docPath] = fh
			}
		}

		state.total = len(chunksToEmbed)
		if state.total == 0 {
			state.total = 1
		}
		p.Send(reindexTickMsg{})

		// Sort by content length for efficient batching.
		sort.Slice(chunksToEmbed, func(a, b int) bool {
			return len(chunksToEmbed[a].chunk.Content) < len(chunksToEmbed[b].chunk.Content)
		})

		// Batch embed changed chunks.
		var embeddedChunks []search.Chunk
		i := 0
		for i < len(chunksToEmbed) {
			batchSize := 64
			if len(chunksToEmbed[i].chunk.Content) > 1000 {
				batchSize = 32
			}
			end := i + batchSize
			if end > len(chunksToEmbed) {
				end = len(chunksToEmbed)
			}
			batch := chunksToEmbed[i:end]

			texts := make([]string, len(batch))
			for j, ic := range batch {
				texts[j] = ic.chunk.Content
			}

			vecs, err := embedder.EmbedDocumentBatch(texts)
			if err != nil {
				for j, ic := range batch {
					vec, err := embedder.EmbedDocument(ic.chunk.Content)
					if err != nil {
						continue
					}
					ic.chunk.Embedding = vec
					embeddedChunks = append(embeddedChunks, ic.chunk)
					state.processed = i + j + 1
				}
				i = end
				continue
			}

			for j := range batch {
				batch[j].chunk.Embedding = vecs[j]
				embeddedChunks = append(embeddedChunks, batch[j].chunk)
			}
			state.processed = end
			i = end
		}

		// For cached chunks that were not re-embedded, we need to keep them
		// in the vector store. They're already there from the previous run,
		// so we only need to add newly embedded chunks.
		// But for unchanged chunks in changed files that we skipped embedding,
		// they might have been removed by RemoveByIDs of stale chunks.
		// Actually, we only removed stale (deleted) chunk IDs, not cached ones.
		// So cached chunks from changed files are still in the store.

		// Add newly embedded chunks to vector store.
		// First remove any existing entries for these IDs (in case of re-embed).
		if len(embeddedChunks) > 0 {
			reembedIDs := make([]string, len(embeddedChunks))
			for i, c := range embeddedChunks {
				reembedIDs[i] = c.ID
			}
			vecStore.RemoveByIDs(reembedIDs)
			vecStore.AddChunks(embeddedChunks)
		}

		if err := vecStore.Save(); err != nil {
			p.Send(ingestDoneMsg{err: fmt.Errorf("save index: %w", err)})
			return
		}

		// ── Phase 3: Edge resolution (always full) ──────────────────
		if db != nil && len(allEdges) > 0 {
			resolvedEdges := search.ResolveCodeEdges(allSymbols, allEdges)
			if dbErr := search.SaveCodeEdges(db, resolvedEdges); dbErr == nil {
				edgeCount = len(resolvedEdges)
			}
		}

		// ── Save file hashes ────────────────────────────────────────
		if db != nil {
			search.SaveCodeFileHashes(db, newFileHashes)
		}

		totalEmbedded := len(embeddedChunks)
		totalCached := len(cachedChunks)
		_ = totalCached

		p.Send(ingestDoneMsg{
			err:       nil,
			symCount:  totalEmbedded + totalCached,
			fileCount: fileCount,
			edgeCount: edgeCount,
		})
	}()

	if _, runErr := p.Run(); runErr != nil {
		return 0, 0, 0, runErr
	}
	if m.state.err != nil {
		return 0, 0, 0, m.state.err
	}
	return m.symCount, m.fileCount, m.edgeCount, nil
}

func runIngest(cmd *cobra.Command, args []string) error {
	knDir, err := findProjectRoot()
	if err != nil {
		return fmt.Errorf("find project root: %w", err)
	}

	if _, err := os.Stat(knDir); err != nil {
		return fmt.Errorf("not a knowns project (no .knowns/ directory): %w", err)
	}

	store := storage.NewStore(knDir)

	semanticEnabled, err := isSemanticSearchEnabled(store)
	if err != nil {
		return fmt.Errorf("check semantic search: %w", err)
	}
	if !semanticEnabled {
		return fmt.Errorf("semantic search is not enabled. Run 'knowns model set' to configure an embedding model")
	}

	projectRoot := filepath.Dir(knDir)

	if ingestDryRun {
		syms, _, err := search.IndexAllFiles(projectRoot, ingestIncludeTests)
		if err != nil {
			return fmt.Errorf("index files: %w", err)
		}
		fmt.Printf("Would index %d symbols:\n\n", len(syms))
		for _, sym := range syms {
			fmt.Printf("  [%s] %s — %s\n", sym.Kind, sym.Name, sym.DocPath)
		}
		return nil
	}

	// Default: in-process so the user sees the rich bubbletea progress bar.
	// `--background` routes through the shared runtime daemon and returns
	// immediately so the user can follow with `knowns runtime ps --watch`.
	if !ingestBackground || ingestIncludeTests || runtimequeue.ShouldBypassDaemon() {
		symCount, fileCount, edgeCount, err := runIngestWithProgress(projectRoot, ingestIncludeTests, ingestFull)
		if err != nil {
			return err
		}
		fmt.Println()
		fmt.Println(searchSuccessStyle.Render(fmt.Sprintf(
			"✓ Indexed %d symbols (%d files, %d edges)", symCount, fileCount, edgeCount)))
		return nil
	}

	job, err := runtimequeue.Enqueue(store.Root, runtimequeue.JobIndexAll, projectRoot)
	if err != nil {
		return fmt.Errorf("enqueue ingest job: %w", err)
	}
	fmt.Printf("  %s queued ingest job %s — follow with: %s\n",
		searchDimStyle.Render("·"),
		job.ID,
		searchDimStyle.Render("knowns runtime ps --watch"))
	return nil
}

func countUniqueFiles(symbols []search.CodeSymbol) int {
	files := make(map[string]bool)
	for _, s := range symbols {
		files[s.DocPath] = true
	}
	return len(files)
}

func isSemanticSearchEnabled(store *storage.Store) (bool, error) {
	cfg, err := store.Config.Load()
	if err != nil {
		return false, err
	}
	if cfg == nil || cfg.Settings.SemanticSearch == nil {
		return false, nil
	}
	return cfg.Settings.SemanticSearch.Enabled, nil
}

func findProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return storage.FindProjectRoot(dir)
}
