package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var syncCmd = &cobra.Command{
	Use:   "sync",
	Short: "Sync project from config.json (skills, instructions, model, search index)",
	Long: `Apply project configuration from .knowns/config.json.

This is the recommended command after cloning a repo with Knowns:
  git clone <repo>
  knowns sync

It reads config.json and sets up everything locally:
  • Skills — copies built-in skills to platform directories
  • Instructions — generates agent instruction files (CLAUDE.md, AGENTS.md, etc.)
  • Runtime hooks — installs current memory hooks for configured runtimes
  • Model — downloads the configured embedding model (if not installed)
  • Search index — rebuilds the semantic search index
  • Git integration — applies .gitignore rules for the configured tracking mode

Use flags to sync only specific parts.`,
	RunE: runSync,
}

func runSync(cmd *cobra.Command, args []string) error {
	store, err := getStoreErr()
	if err != nil {
		return err
	}

	force := true // sync always overwrites to keep files in sync with templates
	skillsOnly, _ := cmd.Flags().GetBool("skills")
	instructionsOnly, _ := cmd.Flags().GetBool("instructions")
	modelOnly, _ := cmd.Flags().GetBool("model")
	platform, _ := cmd.Flags().GetString("platform")

	// If no specific flag is set, sync everything
	specificFlag := skillsOnly || instructionsOnly || modelOnly
	syncSkills := !specificFlag || skillsOnly
	syncInstructions := !specificFlag || instructionsOnly
	syncModel := !specificFlag || modelOnly
	syncIndex := !specificFlag

	// Load project config
	cfg, err := store.Config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	projectRoot := filepath.Dir(store.Root)
	configPlatforms := cfg.Settings.Platforms
	selectedPlatforms, err := resolveSyncPlatformSelection(platform, configPlatforms)
	if err != nil {
		return err
	}

	fmt.Printf("%s\n\n", RenderInfo(fmt.Sprintf("Syncing project %s from config.json...", StyleBold.Render(cfg.Name))))

	// 1. Skills
	if syncSkills {
		if err := runSyncSkillsForScope(projectRoot, force, selectedPlatforms, resolveSkillsScope(cfg.Settings)); err != nil {
			return fmt.Errorf("sync skills: %w", err)
		}
		fmt.Println()
	}

	// 2. Instructions
	if syncInstructions {
		effectivePlatform := platform
		if strings.EqualFold(strings.TrimSpace(platform), "all") {
			effectivePlatform = ""
		}
		if err := runSyncInstructions(projectRoot, effectivePlatform, force, selectedPlatforms); err != nil {
			return fmt.Errorf("sync instructions: %w", err)
		}
		platformsForConfigs, err := resolveSyncPlatformTargets(effectivePlatform, selectedPlatforms)
		if err != nil {
			return fmt.Errorf("resolve platform configs: %w", err)
		}
		if err := runSyncPlatformConfigs(projectRoot, force, platformsForConfigs); err != nil {
			return fmt.Errorf("sync platform configs: %w", err)
		}
		fmt.Println()
	}

	// 3. Git integration
	if !specificFlag {
		if cfg.Settings.GitTrackingMode != "" {
			fmt.Println(RenderField("Git tracking mode", StyleBold.Render(cfg.Settings.GitTrackingMode)))
			if err := syncGitIntegration(projectRoot, cfg); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: git integration failed: %v\n", err)
			} else {
				fmt.Println(RenderSuccess("Git integration configured."))
			}
			fmt.Println()
		}
	}

	// 4. Model download / semantic store setup
	if syncModel {
		if err := runSyncModel(store, force); err != nil {
			// Non-fatal — warn and continue
			fmt.Fprintf(os.Stderr, "Warning: model sync failed: %v\n", err)
			fmt.Println()
		}
	}

	// 5. Import sync
	if !specificFlag {
		if err := runSyncImports(store, force); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: import sync failed: %v\n", err)
		}
	}

	// 6. Reindex
	if syncIndex {
		fmt.Println(StyleBold.Render("Rebuilding search index..."))
		if err := runReindex(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: reindex failed: %v\n", err)
		}
		fmt.Println()
	}

	// 7. Sync MCP configs (update binary paths)
	if !specificFlag {
		if err := syncMCPConfigs(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: MCP config sync failed: %v\n", err)
		}
	}

	// 8. Sync runtime hooks (remove stale hooks, install current ones)
	if !specificFlag {
		if err := runSyncRuntimeHooks(selectedPlatforms); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: runtime hooks sync failed: %v\n", err)
		}
	}

	fmt.Println(RenderSuccess("Sync complete."))
	return nil
}

func syncGitIntegration(projectRoot string, cfg *models.Project) error {
	if cfg == nil {
		return nil
	}
	return writeKnownsGitignore(projectRoot, cfg.Settings.GitTrackingMode, cfg.Settings.GitTracking)
}

type syncInstructionPlatformDef struct {
	name      string
	label     string
	filePath  string
	configIDs []string
	aliases   []string
}

func resolveSyncPlatformSelection(platform string, configPlatforms []string) ([]string, error) {
	if platform == "" {
		return configPlatforms, nil
	}

	normalized := strings.ToLower(strings.TrimSpace(platform))
	switch normalized {
	case "all":
		return allPlatformIDs, nil
	case "claude":
		return []string{"claude-code"}, nil
	case "claude-code", "opencode", "codex", "kiro", "hermes", "antigravity", "cursor", "gemini", "copilot", "agents":
		return []string{normalized}, nil
	default:
		return nil, fmt.Errorf("unknown platform %q (available: claude, opencode, codex, kiro, hermes, antigravity, cursor, gemini, copilot, agents, all)", platform)
	}
}

func resolveSyncPlatformTargets(platform string, configPlatforms []string) ([]string, error) {
	if platform == "" {
		return configPlatforms, nil
	}

	normalized := strings.ToLower(strings.TrimSpace(platform))
	switch normalized {
	case "codex", "cursor", "hermes", "antigravity":
		return []string{normalized}, nil
	case "all":
		return configPlatforms, nil
	case "claude", "claude-code", "opencode", "kiro", "gemini", "copilot", "agents":
		return nil, nil
	default:
		return nil, fmt.Errorf("unknown platform %q", platform)
	}
}

// runSyncPlatformConfigs syncs platform-specific integration artifacts that are
// not instruction shims, such as MCP config files and agent rule files.
// This intentionally requires explicit platform selection in config to avoid
// creating new global configs for older projects whose platform list is empty.
func runSyncPlatformConfigs(projectRoot string, force bool, platforms []string) error {
	if len(platforms) == 0 {
		return nil
	}

	if hasPlatform(platforms, "cursor") {
		if err := createCursorMCPConfigQuiet(projectRoot); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", StyleSuccess.Render("[cursor]"), StyleDim.Render(".cursor/mcp.json synced."))
	}

	if hasPlatform(platforms, "codex") {
		if err := createCodexMCPConfigQuiet(projectRoot); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", StyleSuccess.Render("[codex]"), StyleDim.Render(".codex/config.toml synced."))
	}

	if hasPlatform(platforms, "hermes") {
		if err := createHermesMCPConfigQuiet(projectRoot); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", StyleSuccess.Render("[hermes]"), StyleDim.Render("~/.hermes/config.yaml synced."))
	}

	if hasPlatform(platforms, "antigravity") {
		if err := createAntigravityRulesQuiet(projectRoot, force); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", StyleSuccess.Render("[antigravity]"), StyleDim.Render(".agents/rules/knowns.md synced."))

		if err := createAntigravityMCPConfigQuiet(projectRoot); err != nil {
			return err
		}
		fmt.Printf("  %s %s\n", StyleSuccess.Render("[antigravity]"), StyleDim.Render("~/.gemini/antigravity/mcp_config.json synced."))
	}

	return nil
}

// runSyncModel verifies the embedding provider configured in config.json is
// reachable. force is accepted for backward compatibility with callers that
// pre-date the removal of the local ONNX model download flow (spec
// ollama-only-embedding FR-1); every remaining provider is verified rather
// than downloaded, so there is nothing left to force.
func runSyncModel(store *storage.Store, _ bool) error {
	cfg, err := store.Config.Load()
	if err != nil {
		return nil // no config, skip silently
	}

	// Resolved per spec ollama-only-embedding D1/FR-3: provider: local (or
	// omitted) behaves as provider: ollama with the D2 default model here,
	// in memory only.
	ss := cfg.Settings.EffectiveSemanticSearch()
	if ss == nil {
		return nil
	}
	return runSyncModelAPI(ss)
}

// runSyncModelAPI verifies API provider reachability and model availability during sync.
// ss is already resolved (spec D1/FR-3): the caller passes
// EffectiveSemanticSearch(), never the raw stored settings.
func runSyncModelAPI(ss *models.SemanticSearchSettings) error {
	settingsStore := storage.NewEmbeddingSettingsStore()
	settings, err := settingsStore.Load()
	if err != nil {
		fmt.Printf("%s Could not load embedding settings: %v\n", StyleWarning.Render("⚠"), err)
		fmt.Println(StyleDim.Render("  Falling back to keyword-only search."))
		return nil
	}

	model, err := settings.GetModel(ss.Model)
	if err != nil {
		fmt.Printf("%s Embedding model %q not found in ~/.knowns/settings.json\n", StyleWarning.Render("⚠"), ss.Model)
		// `knowns model` was removed with the local ONNX path (D4). A model
		// reaches the registry by pulling it with Ollama and selecting it
		// with `knowns config`; naming the removed command here sent the
		// user to a command that no longer resolves.
		fmt.Println(StyleDim.Render("  Pull it with `ollama pull " + ss.Model + "`, then select it:"))
		fmt.Println(StyleDim.Render("  knowns config set settings.semanticSearch.model " + ss.Model))
		return nil
	}

	provider, err := settings.GetProvider(model.Provider)
	if err != nil {
		fmt.Printf("%s Provider %q not found in ~/.knowns/settings.json\n", StyleWarning.Render("⚠"), model.Provider)
		fmt.Println(StyleDim.Render("  Configure it: knowns provider add"))
		return nil
	}

	// Test connectivity.
	if err := testProviderConnectivity(provider.APIBase, provider.APIKey); err != nil {
		fmt.Printf("%s Provider %q unreachable at %s\n", StyleWarning.Render("⚠"), model.Provider, provider.APIBase)
		fmt.Println(StyleDim.Render("  Falling back to keyword-only search."))
		return nil
	}

	fmt.Printf("%s Semantic search ready (api: %s, model: %s, %dd)\n",
		StyleSuccess.Render("✓"), model.Provider, model.Model, model.Dimensions)
	return nil
}

// resolveSkillsScope answers where sync should materialize skills, using the
// shared chain so `knowns doctor` and `knowns sync` can never disagree about
// which directories a project is supposed to have.
func resolveSkillsScope(settings models.ProjectSettings) string {
	return models.ResolveSkillsScope(settings.SkillsScope, storage.GlobalSkillsScopeDefault())
}

// runSyncSkillsForScope routes skill materialization by the project's
// settings.skillsScope. Before this existed, sync always created the project
// skill directories, which silently shadowed a user's global install: a
// project copy wins over ~/.claude/skills, and sync always overwrites, so
// deleting the project copy never stuck.
func runSyncSkillsForScope(projectRoot string, force bool, platforms []string, scope string) error {
	switch scope {
	case models.SkillsScopeNone:
		fmt.Println(RenderInfo("Skills scope is \"none\": leaving skill directories untouched."))
		return nil
	case models.SkillsScopeGlobal:
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolve home directory: %w", err)
		}
		count, err := codegen.BuiltInSkillCount()
		if err != nil {
			return fmt.Errorf("count built-in skills: %w", err)
		}
		if count == 0 {
			fmt.Println(StyleDim.Render("No embedded built-in skills found. Skipping skill sync."))
			return nil
		}
		fmt.Printf("%s\n", RenderInfo(fmt.Sprintf("Syncing %s skill(s) to global directories...", StyleBold.Render(fmt.Sprintf("%d", count)))))
		if err := syncGlobalSkills(home, platforms); err != nil {
			return err
		}
		fmt.Println(RenderSuccess(fmt.Sprintf("Synced %d skill(s) globally. Project skill directories were left untouched.", count)))
		return nil
	default:
		return runSyncSkillsForPlatforms(projectRoot, force, platforms)
	}
}

// runSyncSkillsForPlatforms copies embedded built-in skills to the platform dirs
// determined by the given platform list (empty = all).
func runSyncSkillsForPlatforms(projectRoot string, force bool, platforms []string) error {
	count, err := codegen.BuiltInSkillCount()
	if err != nil {
		return fmt.Errorf("count built-in skills: %w", err)
	}
	if count == 0 {
		fmt.Println(StyleDim.Render("No embedded built-in skills found. Skipping skill sync."))
		return nil
	}

	fmt.Printf("%s\n", RenderInfo(fmt.Sprintf("Syncing %s skill(s)...", StyleBold.Render(fmt.Sprintf("%d", count)))))

	if err := codegen.SyncSkillsForPlatforms(projectRoot, platforms); err != nil {
		return err
	}

	if force {
		fmt.Printf("  %s\n", StyleWarning.Render("Force sync: overwritten all existing skill files."))
	}

	fmt.Println(RenderSuccess(fmt.Sprintf("Synced %d skill(s).", count)))
	return nil
}

// runSyncInstructions syncs the canonical guidance file and compatibility shims.
// platform filters to a single platform by name (overrides configPlatforms).
// configPlatforms restricts which platforms are active (empty = all).
func runSyncInstructions(projectRoot string, platform string, force bool, configPlatforms []string) error {
	// Define the known platforms and their instruction file paths.
	platforms := []syncInstructionPlatformDef{
		{name: "claude", label: "Claude Code", filePath: filepath.Join(projectRoot, "CLAUDE.md"), configIDs: []string{"claude-code"}, aliases: []string{"claude", "claude-code"}},
		{name: "opencode", label: "OpenCode", filePath: filepath.Join(projectRoot, "OPENCODE.md"), configIDs: []string{"opencode"}, aliases: []string{"opencode"}},
		{name: "gemini", label: "Gemini CLI", filePath: filepath.Join(projectRoot, "GEMINI.md"), configIDs: []string{"gemini"}, aliases: []string{"gemini"}},
		{name: "copilot", label: "GitHub Copilot", filePath: filepath.Join(projectRoot, ".github", "copilot-instructions.md"), configIDs: []string{"copilot"}, aliases: []string{"copilot"}},
		{name: "agents", label: "Generic AI", filePath: filepath.Join(projectRoot, "AGENTS.md"), configIDs: []string{"agents", "codex", "hermes"}, aliases: []string{"agents", "codex", "hermes"}},
	}

	// Filter by --platform flag first (single platform override).
	if platform != "" {
		var filtered []syncInstructionPlatformDef
		for _, p := range platforms {
			if syncPlatformDefMatches(p, platform) {
				filtered = append(filtered, p)
			}
		}
		if len(filtered) == 0 {
			return fmt.Errorf("unknown platform %q (available: claude, opencode, codex, hermes, gemini, copilot, agents)", platform)
		}
		platforms = filtered
	} else if len(configPlatforms) > 0 {
		// Apply config platform restriction when no explicit --platform flag.
		configSet := make(map[string]bool, len(configPlatforms))
		for _, id := range configPlatforms {
			configSet[id] = true
		}
		var filtered []syncInstructionPlatformDef
		for _, p := range platforms {
			if syncPlatformDefConfigured(p, configSet) {
				filtered = append(filtered, p)
			}
		}
		platforms = filtered
	}

	fmt.Println(StyleBold.Render("Checking agent instruction files..."))

	for _, p := range platforms {
		exists := false
		if _, err := os.Stat(p.filePath); err == nil {
			exists = true
		}

		if err := os.MkdirAll(filepath.Dir(p.filePath), 0755); err != nil {
			return fmt.Errorf("create directory %s: %w", filepath.Dir(p.filePath), err)
		}

		relPath := filepath.Base(p.filePath)
		if p.filePath == filepath.Join(projectRoot, ".github", "copilot-instructions.md") {
			relPath = filepath.Join(".github", "copilot-instructions.md")
		}
		newContent := generateInstructionContent(relPath, p.label, projectRoot)

		if exists {
			// Preserve user content outside the markers — only replace the
			// managed block between <!-- KNOWNS GUIDELINES START --> and
			// <!-- KNOWNS GUIDELINES END -->.
			if err := syncInstructionMarkerBlock(p.filePath, newContent); err != nil {
				return fmt.Errorf("sync %s: %w", p.filePath, err)
			}
			fmt.Printf("  %s %s %s\n", StyleSuccess.Render("["+p.name+"]"), filepath.Base(p.filePath), StyleDim.Render("synced."))
		} else {
			if err := os.WriteFile(p.filePath, []byte(newContent), 0644); err != nil {
				return fmt.Errorf("write %s: %w", p.filePath, err)
			}
			fmt.Printf("  %s %s %s\n", StyleSuccess.Render("["+p.name+"]"), filepath.Base(p.filePath), StyleDim.Render("created."))
		}
	}

	return nil
}

func syncPlatformDefMatches(p syncInstructionPlatformDef, platform string) bool {
	for _, alias := range p.aliases {
		if strings.EqualFold(alias, platform) {
			return true
		}
	}
	return false
}

func syncPlatformDefConfigured(p syncInstructionPlatformDef, configSet map[string]bool) bool {
	for _, id := range p.configIDs {
		if configSet[id] {
			return true
		}
	}
	return false
}

const (
	guidelinesMarkerStart = "<!-- KNOWNS GUIDELINES START -->"
	guidelinesMarkerEnd   = "<!-- KNOWNS GUIDELINES END -->"
)

// syncInstructionMarkerBlock replaces only the managed block (between the
// KNOWNS GUIDELINES markers) in an existing instruction file, preserving any
// user-added content outside the markers.  If the file has no markers the
// entire file is overwritten with newContent (backwards-compatible).
func syncInstructionMarkerBlock(filePath, newContent string) error {
	existing, err := os.ReadFile(filePath)
	if err != nil {
		// File unreadable — fall back to full overwrite.
		return os.WriteFile(filePath, []byte(newContent), 0644)
	}

	oldText := string(existing)
	startIdx := strings.Index(oldText, guidelinesMarkerStart)
	endIdx := strings.Index(oldText, guidelinesMarkerEnd)

	if startIdx < 0 || endIdx < 0 || endIdx <= startIdx {
		// No valid marker pair found — append the managed block to preserve
		// existing user content instead of overwriting the whole file.
		newStartIdx := strings.Index(newContent, guidelinesMarkerStart)
		newEndIdx := strings.Index(newContent, guidelinesMarkerEnd)
		if newStartIdx < 0 || newEndIdx < 0 || newEndIdx <= newStartIdx {
			return os.WriteFile(filePath, []byte(newContent), 0644)
		}
		block := newContent[newStartIdx : newEndIdx+len(guidelinesMarkerEnd)]
		separator := "\n\n"
		if strings.HasSuffix(oldText, "\n\n") {
			separator = ""
		} else if strings.HasSuffix(oldText, "\n") {
			separator = "\n"
		}
		return os.WriteFile(filePath, []byte(oldText+separator+block+"\n"), 0644)
	}

	// Extract the new managed block from the generated content.
	newStartIdx := strings.Index(newContent, guidelinesMarkerStart)
	newEndIdx := strings.Index(newContent, guidelinesMarkerEnd)

	if newStartIdx < 0 || newEndIdx < 0 || newEndIdx <= newStartIdx {
		// Generated content has no markers (unexpected) — overwrite.
		return os.WriteFile(filePath, []byte(newContent), 0644)
	}

	newBlock := newContent[newStartIdx : newEndIdx+len(guidelinesMarkerEnd)]
	oldBlock := oldText[startIdx : endIdx+len(guidelinesMarkerEnd)]

	result := oldText[:startIdx] + newBlock + oldText[endIdx+len(guidelinesMarkerEnd):]

	// Only write if something actually changed.
	if newBlock == oldBlock {
		return nil
	}

	return os.WriteFile(filePath, []byte(result), 0644)
}

// runSyncImports syncs all git-based imports during knowns sync.
func runSyncImports(store *storage.Store, force bool) error {
	importsDir := filepath.Join(store.Root, "imports")
	entries, err := os.ReadDir(importsDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}

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
		return nil
	}

	fmt.Printf("%s\n", RenderInfo(fmt.Sprintf("Syncing %d import(s)...", len(syncables))))

	for i, imp := range syncables {
		var added, updated, skipped int
		var commitHash string
		var isUpToDate bool
		label := fmt.Sprintf("Syncing %s (%d/%d)", imp.name, i+1, len(syncables))
		err := RunWithSpinner(label, func() error {
			var syncErr error
			added, updated, skipped, commitHash, syncErr = cliGitSync(imp.meta.Source, imp.meta.Ref, imp.importDir, imp.name, imp.meta.LastCommitHash, force)
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
			fmt.Printf("    %s\n", StyleDim.Render("already up to date"))
			continue
		}

		imp.meta.LastSync = time.Now().UTC().Format(time.RFC3339)
		imp.meta.LastCommitHash = commitHash
		if newData, err := json.MarshalIndent(imp.meta, "", "  "); err == nil {
			_ = os.WriteFile(imp.metaPath, newData, 0644)
		}

		fmt.Printf("    %s\n", StyleDim.Render(fmt.Sprintf("%d added, %d updated, %d skipped", added, updated, skipped)))
	}
	fmt.Println()
	return nil
}

func init() {
	syncCmd.Flags().Bool("force", false, "Force resync (overwrite existing files) [deprecated: sync always overwrites]")
	syncCmd.Flags().Bool("skills", false, "Sync skills only")
	syncCmd.Flags().Bool("instructions", false, "Sync instruction files only")
	syncCmd.Flags().Bool("model", false, "Download embedding model only")
	syncCmd.Flags().String("platform", "", "Sync specific platform (claude, opencode, codex, kiro, antigravity, cursor, gemini, copilot, agents, all)")

	rootCmd.AddCommand(syncCmd)
}

// runSyncRuntimeHooks re-installs runtime hooks for configured platforms,
// removing stale hook formats and writing the current one.
func runSyncRuntimeHooks(configPlatforms []string) error {
	opts := runtimeinstall.DefaultOptions()
	runtimeNames := runtimeinstall.RuntimeNames()

	targets := runtimeNames
	if len(configPlatforms) > 0 {
		configSet := make(map[string]bool, len(configPlatforms))
		for _, id := range configPlatforms {
			configSet[id] = true
		}
		targets = nil
		for _, name := range runtimeNames {
			if configSet[name] {
				targets = append(targets, name)
			}
		}
	}

	var synced int
	for _, name := range targets {
		if err := runtimeinstall.Install(name, opts); err != nil {
			continue
		}
		synced++
	}
	if synced > 0 {
		fmt.Printf("%s Runtime hooks synced for %d platform(s).\n", StyleSuccess.Render("✓"), synced)
	}
	return nil
}
