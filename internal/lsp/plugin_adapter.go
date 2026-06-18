package lsp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// PluginAdapterManifest is the JSON schema for user-contributed LSP adapters.
// It is intentionally metadata-only: launched servers still run through Manager
// and Server.
type PluginAdapterManifest struct {
	ID                     string                    `json:"id,omitempty"`
	LanguageID             string                    `json:"language_id,omitempty"`
	BackendID              string                    `json:"backend_id,omitempty"`
	Name                   string                    `json:"name,omitempty"`
	Extensions             []string                  `json:"extensions,omitempty"`
	Binaries               []BinaryCandidate         `json:"binaries,omitempty"`
	BinaryCandidates       []BinaryCandidate         `json:"binary_candidates,omitempty"`
	DefaultArgs            []string                  `json:"default_args,omitempty"`
	Prerequisites          []Prerequisite            `json:"prerequisites,omitempty"`
	InstallGuide           InstallGuide              `json:"install_guide,omitempty"`
	RuntimeDependencies    []RuntimeDependency       `json:"runtime_dependencies,omitempty"`
	RuntimeDeps            []RuntimeDependency       `json:"runtime_deps,omitempty"`
	InitializationOptions  map[string]any            `json:"initialization_options,omitempty"`
	IgnoredDirs            []string                  `json:"ignored_dirs,omitempty"`
	Capabilities           PluginAdapterCapabilities `json:"capabilities,omitempty"`
	SupportsImplementation *bool                     `json:"supports_implementation,omitempty"`
	SupportsReferences     *bool                     `json:"supports_references,omitempty"`
}

type PluginAdapterCapabilities struct {
	Implementation *bool `json:"implementation,omitempty"`
	References     *bool `json:"references,omitempty"`
}

type PluginAdapterLoadOptions struct {
	Dir string
}

type PluginAdapterLoadResult struct {
	Adapters []LanguageAdapter
	Errors   []PluginAdapterLoadError
}

type PluginAdapterLoadError struct {
	Path string
	Err  error
}

func (e PluginAdapterLoadError) Error() string {
	if e.Path == "" {
		return e.Err.Error()
	}
	return fmt.Sprintf("%s: %v", e.Path, e.Err)
}

func (e PluginAdapterLoadError) Unwrap() error {
	return e.Err
}

// PluginAdapter implements LanguageAdapter from a manifest.
type PluginAdapter struct {
	BaseAdapter

	manifest  PluginAdapterManifest
	source    string
	ignored   map[string]struct{}
	id        string
	binaries  []BinaryCandidate
	runtime   []RuntimeDependency
	extension []string
}

func DefaultPluginAdapterDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".knowns", "lsp-adapters")
	}
	return filepath.Join(home, ".knowns", "lsp-adapters")
}

func LoadPluginAdapters(opts PluginAdapterLoadOptions) PluginAdapterLoadResult {
	dir := opts.Dir
	if dir == "" {
		dir = DefaultPluginAdapterDir()
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return PluginAdapterLoadResult{}
		}
		return PluginAdapterLoadResult{Errors: []PluginAdapterLoadError{{Path: dir, Err: err}}}
	}

	var paths []string
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		paths = append(paths, filepath.Join(dir, entry.Name()))
	}
	sort.Strings(paths)

	result := PluginAdapterLoadResult{Adapters: make([]LanguageAdapter, 0, len(paths))}
	for _, path := range paths {
		adapter, err := loadPluginAdapterFile(path)
		if err != nil {
			result.Errors = append(result.Errors, PluginAdapterLoadError{Path: path, Err: err})
			continue
		}
		result.Adapters = append(result.Adapters, adapter)
	}
	return result
}

func loadPluginAdapterFile(path string) (LanguageAdapter, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var manifest PluginAdapterManifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return nil, err
	}
	adapter, err := NewPluginAdapter(manifest)
	if err != nil {
		return nil, err
	}
	adapter.source = path
	return adapter, nil
}

func NewPluginAdapter(manifest PluginAdapterManifest) (*PluginAdapter, error) {
	adapter := &PluginAdapter{manifest: manifest}
	if err := adapter.normalize(); err != nil {
		return nil, err
	}
	return adapter, nil
}

func (a *PluginAdapter) SourcePath() string { return a.source }

func (a *PluginAdapter) ID() string { return a.id }

func (a *PluginAdapter) Name() string { return strings.TrimSpace(a.manifest.Name) }

func (a *PluginAdapter) Extensions() []string { return append([]string(nil), a.extension...) }

func (a *PluginAdapter) Binaries() []BinaryCandidate {
	out := cloneBinaryCandidates(a.binaries)
	defaultArgs := a.DefaultArgs()
	for i := range out {
		if len(out[i].Args) == 0 && len(defaultArgs) > 0 {
			out[i].Args = append([]string(nil), defaultArgs...)
		}
	}
	return out
}

func (a *PluginAdapter) Prerequisites() []Prerequisite {
	return append([]Prerequisite(nil), a.manifest.Prerequisites...)
}

func (a *PluginAdapter) CheckPrerequisites(ctx context.Context) error {
	for _, prereq := range a.manifest.Prerequisites {
		fields := strings.Fields(prereq.CheckCmd)
		if len(fields) == 0 {
			continue
		}
		cmd := exec.CommandContext(ctx, fields[0], fields[1:]...)
		output, err := cmd.CombinedOutput()
		if err != nil {
			name := prereq.Name
			if name == "" {
				name = prereq.CheckCmd
			}
			return fmt.Errorf("%s prerequisite failed: %w: %s", name, err, strings.TrimSpace(string(output)))
		}
	}
	return nil
}

func (a *PluginAdapter) InstallGuide() InstallGuide { return a.manifest.InstallGuide }

func (a *PluginAdapter) CanInstall() bool { return len(a.runtime) > 0 }

func (a *PluginAdapter) RuntimeDeps() []RuntimeDependency {
	return cloneRuntimeDependencies(a.runtime)
}

func (a *PluginAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	if len(a.runtime) == 0 {
		return "", fmt.Errorf("plugin adapter %q has no runtime dependencies", a.ID())
	}
	return NewInstaller(targetDir).Install(ctx, a)
}

func (a *PluginAdapter) InstalledPath() (string, bool) {
	if len(a.runtime) == 0 {
		return "", false
	}
	return NewInstaller(DefaultLSPBaseDir()).IsInstalled(a)
}

func (a *PluginAdapter) DefaultArgs() []string {
	return append([]string(nil), a.manifest.DefaultArgs...)
}

func (a *PluginAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	params := map[string]any{"rootUri": FileURI(root)}
	if options := a.InitializationOptions(settings); len(options) > 0 {
		params["initializationOptions"] = options
	}
	return params
}

func (a *PluginAdapter) InitializationOptions(settings map[string]any) map[string]any {
	options := cloneAnyMap(a.manifest.InitializationOptions)
	if settings != nil {
		overlay := settings
		if nested, ok := settings["initializationOptions"].(map[string]any); ok {
			overlay = nested
		}
		if len(overlay) > 0 {
			if options == nil {
				options = map[string]any{}
			}
			maps.Copy(options, overlay)
		}
	}
	if options == nil {
		return map[string]any{}
	}
	return options
}

func (a *PluginAdapter) IsIgnoredDir(name string) bool {
	_, ok := a.ignored[name]
	return ok
}

func (a *PluginAdapter) SupportsImplementation() bool {
	if a.manifest.SupportsImplementation != nil {
		return *a.manifest.SupportsImplementation
	}
	if a.manifest.Capabilities.Implementation != nil {
		return *a.manifest.Capabilities.Implementation
	}
	return true
}

func (a *PluginAdapter) SupportsReferences() bool {
	if a.manifest.SupportsReferences != nil {
		return *a.manifest.SupportsReferences
	}
	if a.manifest.Capabilities.References != nil {
		return *a.manifest.Capabilities.References
	}
	return true
}

func (a *PluginAdapter) normalize() error {
	id, err := manifestID(a.manifest)
	if err != nil {
		return err
	}
	if !validPluginID(id) {
		return fmt.Errorf("invalid adapter id %q", id)
	}
	if strings.TrimSpace(a.manifest.Name) == "" {
		return fmt.Errorf("name is required")
	}

	extensions, err := normalizeManifestExtensions(a.manifest.Extensions)
	if err != nil {
		return err
	}
	binaries := a.manifest.Binaries
	if len(binaries) == 0 {
		binaries = a.manifest.BinaryCandidates
	}
	if len(binaries) == 0 {
		return fmt.Errorf("at least one binary candidate is required")
	}
	binaries = cloneBinaryCandidates(binaries)
	for i := range binaries {
		binaries[i].Name = strings.TrimSpace(binaries[i].Name)
		if binaries[i].Name == "" {
			return fmt.Errorf("binary candidate %d name is required", i)
		}
	}

	runtimeDeps := a.manifest.RuntimeDependencies
	if len(runtimeDeps) == 0 {
		runtimeDeps = a.manifest.RuntimeDeps
	}
	runtimeDeps = cloneRuntimeDependencies(runtimeDeps)
	for i, dep := range runtimeDeps {
		if strings.TrimSpace(dep.ID) == "" {
			return fmt.Errorf("runtime dependency %d id is required", i)
		}
	}

	a.id = id
	a.extension = extensions
	a.binaries = binaries
	a.runtime = runtimeDeps
	a.ignored = make(map[string]struct{}, len(a.manifest.IgnoredDirs))
	for _, dir := range a.manifest.IgnoredDirs {
		dir = strings.TrimSpace(dir)
		if dir != "" {
			a.ignored[dir] = struct{}{}
		}
	}
	return nil
}

func manifestID(manifest PluginAdapterManifest) (string, error) {
	id := strings.TrimSpace(manifest.ID)
	languageID := strings.TrimSpace(manifest.LanguageID)
	if id != "" && languageID != "" && id != languageID {
		return "", fmt.Errorf("id %q and language_id %q must match", id, languageID)
	}
	if id == "" {
		id = languageID
	}
	if id == "" {
		return "", fmt.Errorf("id or language_id is required")
	}
	return id, nil
}

func validPluginID(id string) bool {
	return id != "" && !strings.ContainsAny(id, " \t\r\n/\\")
}

func normalizeManifestExtensions(extensions []string) ([]string, error) {
	if len(extensions) == 0 {
		return nil, fmt.Errorf("at least one extension is required")
	}
	seen := make(map[string]struct{}, len(extensions))
	out := make([]string, 0, len(extensions))
	for _, ext := range extensions {
		ext = strings.ToLower(strings.TrimSpace(ext))
		if ext == "" {
			return nil, fmt.Errorf("extension cannot be empty")
		}
		if !strings.HasPrefix(ext, ".") {
			return nil, fmt.Errorf("extension %q must start with '.'", ext)
		}
		if strings.ContainsAny(ext, "/\\") {
			return nil, fmt.Errorf("extension %q cannot contain path separators", ext)
		}
		if _, ok := seen[ext]; ok {
			continue
		}
		seen[ext] = struct{}{}
		out = append(out, ext)
	}
	return out, nil
}

func cloneBinaryCandidates(in []BinaryCandidate) []BinaryCandidate {
	if in == nil {
		return nil
	}
	out := make([]BinaryCandidate, len(in))
	for i, candidate := range in {
		out[i] = candidate
		out[i].Args = append([]string(nil), candidate.Args...)
		out[i].CheckArgs = append([]string(nil), candidate.CheckArgs...)
	}
	return out
}

func cloneRuntimeDependencies(in []RuntimeDependency) []RuntimeDependency {
	if in == nil {
		return nil
	}
	out := make([]RuntimeDependency, len(in))
	for i, dep := range in {
		out[i] = dep
		out[i].Packages = append([]string(nil), dep.Packages...)
	}
	return out
}

func cloneAnyMap(in map[string]any) map[string]any {
	if in == nil {
		return nil
	}
	return maps.Clone(in)
}
