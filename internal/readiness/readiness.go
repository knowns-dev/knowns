// Package readiness provides a unified readiness payload for Knowns projects.
// It collects knowledge counts, search status, runtime health, and capabilities
// into one canonical model consumed by CLI, server API, and MCP.
package readiness

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/lsp"
	"github.com/howznguyen/knowns/internal/lsp/adapters"
	"github.com/howznguyen/knowns/internal/permissions"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/util"
)

// Payload is the canonical readiness response.
// Fields active, projectName, projectPath are preserved for backward compat
// with the existing GET /api/status contract.
type Payload struct {
	Active      bool   `json:"active"`
	ProjectName string `json:"projectName"`
	ProjectPath string `json:"projectPath"`
	Version     string `json:"version"`

	Knowledge    *KnowledgeStatus  `json:"knowledge,omitempty"`
	Search       *SearchStatus     `json:"search,omitempty"`
	Runtime      *RuntimeStatus    `json:"runtime,omitempty"`
	LSP          []LSPStatus       `json:"lsp,omitempty"`
	Permissions  *PermissionStatus `json:"permissions,omitempty"`
	Capabilities []string          `json:"capabilities,omitempty"`
}

// KnowledgeStatus reports entity counts.
type KnowledgeStatus struct {
	Docs      int          `json:"docs"`
	Tasks     int          `json:"tasks"`
	Templates int          `json:"templates"`
	Memories  MemoryCounts `json:"memories"`
	Relations int          `json:"relations"`
	Imports   int          `json:"imports"`
}

// MemoryCounts breaks memory count by layer.
type MemoryCounts struct {
	Project int `json:"project"`
	Global  int `json:"global"`
}

// SearchStatus reports semantic search readiness.
type SearchStatus struct {
	SemanticEnabled   bool       `json:"semanticEnabled"`
	ModelConfigured   bool       `json:"modelConfigured"`
	ModelInstalled    bool       `json:"modelInstalled"`
	ProjectIndexReady bool       `json:"projectIndexReady"`
	GlobalIndexReady  bool       `json:"globalIndexReady"`
	LastReindex       *time.Time `json:"lastReindex,omitempty"`
}

// RuntimeStatus reports runtime health. This is typically injected from a
// cached snapshot on the server side, or probed directly by the CLI.
type RuntimeStatus struct {
	Enabled          bool   `json:"enabled"`
	Running          bool   `json:"running"`
	ConnectedClients int    `json:"connectedClients"`
	QueuedJobs       int    `json:"queuedJobs"`
	RunningJobs      int    `json:"runningJobs"`
	State            string `json:"state"` // "healthy", "degraded", "stopped"
}

// LSPStatus reports per-language LSP server availability.
type LSPStatus struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Binary     string `json:"binary,omitempty"`
	Source     string `json:"source,omitempty"`
	InstallCmd string `json:"installCmd,omitempty"`
}

// PermissionStatus reports the active AI permission policy.
type PermissionStatus struct {
	Preset              string   `json:"preset"`
	AllowedCapabilities []string `json:"allowedCapabilities"`
	DeniedCapabilities  []string `json:"deniedCapabilities"`
	IsDefault           bool     `json:"isDefault"`
}

// Options configures how BuildReadiness collects data.
type Options struct {
	// Runtime is an optional pre-built runtime snapshot (from server cache).
	// When nil, runtime section is omitted or shows disabled.
	Runtime *RuntimeStatus
}

// BuildReadiness collects all readiness sections from the given store.
// Entity counts and search status are computed real-time.
// Runtime health comes from opts.Runtime (cached snapshot).
func BuildReadiness(store *storage.Store, opts Options) Payload {
	projectPath := filepath.Dir(store.Root)
	projectName := filepath.Base(projectPath)

	p := Payload{
		Active:      true,
		ProjectName: projectName,
		ProjectPath: projectPath,
		Version:     util.Version,
	}

	p.Knowledge = buildKnowledge(store)
	p.Search = buildSearch(store)
	p.Runtime = opts.Runtime
	p.LSP = buildLSP(projectPath, store)
	p.Permissions = buildPermissions(store)
	p.Capabilities = buildCapabilities(p.Search, p.Runtime)

	return p
}

// InactivePayload returns a minimal payload for when no project is active.
func InactivePayload() Payload {
	return Payload{
		Active:  false,
		Version: util.Version,
	}
}

func buildKnowledge(store *storage.Store) *KnowledgeStatus {
	ks := &KnowledgeStatus{}

	if docs, err := store.Docs.List(); err == nil {
		ks.Docs = len(docs)
	}
	if tasks, err := store.Tasks.List(); err == nil {
		ks.Tasks = len(tasks)
	}
	if templates, err := store.Templates.List(); err == nil {
		ks.Templates = len(templates)
	}

	// Memory counts by layer.
	if local, err := store.Memory.ListLocal(); err == nil {
		ks.Memories.Project = len(local)
	}
	if global, err := store.Memory.ListGlobalOnly(); err == nil {
		ks.Memories.Global = len(global)
	}

	// Import count: count subdirectories in .knowns/imports/ that have _import.json.
	importsDir := filepath.Join(store.Root, "imports")
	if entries, err := os.ReadDir(importsDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			metaPath := filepath.Join(importsDir, e.Name(), "_import.json")
			if _, err := os.Stat(metaPath); err == nil {
				ks.Imports++
			}
		}
	}

	// Relations: count from code_edges if available.
	if store.CodeRefIndexExists() {
		db := store.SemanticDB()
		if db != nil {
			var count int
			if err := db.QueryRow("SELECT COUNT(*) FROM code_edges").Scan(&count); err == nil {
				ks.Relations = count
			}
			db.Close()
		}
	}

	return ks
}

func buildSearch(store *storage.Store) *SearchStatus {
	ss := &SearchStatus{}

	cfg, err := store.Config.Load()
	if err != nil {
		return ss
	}

	if cfg.Settings.SemanticSearch != nil {
		sem := cfg.Settings.SemanticSearch
		ss.SemanticEnabled = sem.Enabled
		ss.ModelConfigured = sem.Model != ""

		// Check if ONNX runtime is available.
		onnxAvail, _ := search.IsONNXAvailable()
		ss.ModelInstalled = onnxAvail && sem.Model != ""
	}

	// Project index readiness.
	searchDir := filepath.Join(store.Root, ".search")
	vs := search.NewSQLiteVectorStore(searchDir, "", 0)
	count, _, indexedAt := vs.Stats()
	ss.ProjectIndexReady = count > 0
	if !indexedAt.IsZero() {
		ss.LastReindex = &indexedAt
	}

	// Global index readiness.
	globalRoot := storage.GlobalSemanticStoreRoot()
	globalSearchDir := filepath.Join(globalRoot, ".search")
	gvs := search.NewSQLiteVectorStore(globalSearchDir, "", 0)
	gCount, _, _ := gvs.Stats()
	ss.GlobalIndexReady = gCount > 0

	return ss
}

func buildLSP(projectPath string, store *storage.Store) []LSPStatus {
	project, _ := store.Config.Load()
	cfg := lsp.ConfigFromProject(project)
	detected := detectLSPLanguages(projectPath)

	statuses := make([]LSPStatus, 0, len(adapters.All()))
	for _, adapter := range adapters.All() {
		status := "not-installed"
		binary := ""
		source := ""
		installCmd := ""

		if !cfg.Enabled(adapter.ID()) {
			status = "disabled"
		} else if path, ok := findLSPBinary(adapter, cfg.BinaryOverride(adapter.ID())); ok {
			binary = firstLSPBinaryName(adapter)
			source = lspBinarySource(path, cfg.BinaryOverride(adapter.ID()))
			status = "installed"
			if detected[adapter.ID()] {
				status = "running"
			}
		} else if guide := adapter.InstallGuide(); guide.KnownsCmd != "" {
			installCmd = guide.KnownsCmd
		} else if adapter.CanInstall() {
			installCmd = "knowns lsp install " + adapter.ID()
		}

		statuses = append(statuses, LSPStatus{
			ID:         adapter.ID(),
			Name:       adapter.Name(),
			Status:     status,
			Binary:     binary,
			Source:     source,
			InstallCmd: installCmd,
		})
	}
	return statuses
}

func detectLSPLanguages(root string) map[string]bool {
	seen := make(map[string]bool)
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

func findLSPBinary(adapter lsp.LanguageAdapter, override string) (string, bool) {
	binaries := adapter.Binaries()
	if override != "" {
		binaries = []lsp.BinaryCandidate{{Name: override}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for _, binary := range binaries {
		path, err := exec.LookPath(binary.Name)
		if err != nil {
			continue
		}
		if len(binary.CheckArgs) > 0 {
			if err := exec.CommandContext(ctx, path, binary.CheckArgs...).Run(); err != nil {
				continue
			}
		}
		return path, true
	}
	return "", false
}

func firstLSPBinaryName(adapter lsp.LanguageAdapter) string {
	binaries := adapter.Binaries()
	if len(binaries) == 0 {
		return adapter.ID()
	}
	return binaries[0].Name
}

func lspBinarySource(_ string, override string) string {
	if override != "" {
		return "config"
	}
	return "PATH"
}

func buildCapabilities(ss *SearchStatus, rs *RuntimeStatus) []string {
	var caps []string

	// Always available when project is active.
	caps = append(caps, "task-updates", "doc-updates", "memory-tools", "validation")

	// Search capabilities.
	caps = append(caps, "search") // keyword search always available
	if ss != nil && ss.SemanticEnabled && ss.ModelInstalled && ss.ProjectIndexReady {
		caps = append(caps, "semantic-search")
	}

	// Template generation always available.
	caps = append(caps, "template-generation")

	// Code and graph features if code index exists.
	if ss != nil && ss.ProjectIndexReady {
		caps = append(caps, "code-search", "graph")
	}

	// Browser chat requires runtime.
	if rs != nil && rs.Running && rs.State == "healthy" {
		caps = append(caps, "browser-chat")
	}

	return caps
}

func buildPermissions(store *storage.Store) *PermissionStatus {
	cfg, err := store.Config.Load()
	if err != nil {
		// Can't load config — report default.
		return &PermissionStatus{
			Preset:              permissions.DefaultPreset,
			AllowedCapabilities: sortedKeys(permissions.EffectivePolicy(nil).Allowed),
			DeniedCapabilities:  sortedKeys(permissions.EffectivePolicy(nil).Denied),
			IsDefault:           true,
		}
	}

	permCfg := cfg.Settings.Permissions
	isDefault := permCfg == nil || permCfg.Preset == ""
	policy := permissions.EffectivePolicy(permCfg)

	ps := &PermissionStatus{
		Preset:              policy.Name,
		AllowedCapabilities: sortedKeys(policy.Allowed),
		DeniedCapabilities:  sortedKeys(policy.Denied),
		IsDefault:           isDefault,
	}

	return ps
}

// sortedKeys returns the keys of a bool map in sorted order.
func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Simple insertion sort for small slices.
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j] < keys[j-1]; j-- {
			keys[j], keys[j-1] = keys[j-1], keys[j]
		}
	}
	return keys
}
