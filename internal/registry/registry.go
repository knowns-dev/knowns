// Package registry manages a global project registry at ~/.knowns/registry.json.
// It tracks known Knowns projects with their paths, names, and last-used timestamps.
package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/util"
)

// Project represents a registered Knowns project.
type Project struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	LastUsed time.Time `json:"lastUsed"`
	// Store links the project to a folder in a store clone instead of an
	// in-repo .knowns/ directory. Nil for projects that keep knowledge in the
	// repository, including every entry written before stores existed.
	Store *StoreMapping `json:"store,omitempty"`
	// Machine holds this machine's state for a store-linked project (server
	// port, language server settings): values that must not sync with the
	// team configuration. Keys are config setting names.
	Machine map[string]json.RawMessage `json:"machine,omitempty"`
}

// StoreMapping names where a store-linked project keeps its knowledge: the
// folder Project inside the clone of store Name under ~/.knowns/stores/.
type StoreMapping struct {
	Name    string `json:"name"`
	Project string `json:"project"`
	Remote  string `json:"remote,omitempty"`
}

// Registry manages the list of known projects.
type Registry struct {
	Projects []Project `json:"projects"`
	filePath string
}

// NewRegistry creates a Registry with the default path (~/.knowns/registry.json).
func NewRegistry() *Registry {
	home, _ := os.UserHomeDir()
	return &Registry{
		filePath: filepath.Join(home, ".knowns", "registry.json"),
	}
}

// NewRegistryWithPath creates a Registry with a custom file path (for testing).
func NewRegistryWithPath(path string) *Registry {
	return &Registry{filePath: path}
}

// StoresRoot is the directory holding store clones, next to the registry file.
func (r *Registry) StoresRoot() string {
	return filepath.Join(filepath.Dir(r.filePath), "stores")
}

// KnowledgeRoot is where a project's knowledge lives: its folder in a store
// clone when it has a store mapping, otherwise its in-repo .knowns/ directory.
func (r *Registry) KnowledgeRoot(p Project) string {
	if p.Store != nil {
		return filepath.Join(r.StoresRoot(), p.Store.Name, p.Store.Project)
	}
	return filepath.Join(p.Path, ".knowns")
}

// IsValid reports whether a registered project can be opened: it has an
// initialized knowledge root, in the repository or in a store.
func (r *Registry) IsValid(p Project) bool {
	return isInitializedKnowledgeRoot(r.KnowledgeRoot(p))
}

func isInitializedKnowledgeRoot(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "config.json"))
	return err == nil
}

// Load reads the registry from disk. If the file doesn't exist, starts empty.
// Entries stored under a stale path spelling are repaired and written back.
func (r *Registry) Load() error {
	return r.load(true)
}

// LoadReadOnly reads the registry like Load but never writes the file, for
// callers that only resolve projects.
func (r *Registry) LoadReadOnly() error {
	return r.load(false)
}

func (r *Registry) load(repair bool) error {
	data, err := os.ReadFile(r.filePath)
	if err != nil {
		if os.IsNotExist(err) {
			r.Projects = []Project{}
			return nil
		}
		return fmt.Errorf("read registry: %w", err)
	}
	if err := json.Unmarshal(data, &r.Projects); err != nil {
		return err
	}
	// Rewrite stored paths to their on-disk spelling, then deduplicate on that
	// canonical key (keep last occurrence so most recent wins). Registries
	// written before paths were canonicalized can hold one folder twice under
	// two spellings; this collapses them without hand-editing the file.
	changed := false
	seen := make(map[string]int)
	deduped := r.Projects[:0]
	for _, p := range r.Projects {
		if canonical := util.CanonicalPath(p.Path); canonical != p.Path {
			// Only refresh a name that was derived from the path, so a name
			// set elsewhere survives the rewrite.
			if p.Name == filepath.Base(p.Path) {
				p.Name = filepath.Base(canonical)
			}
			p.Path = canonical
			changed = true
		}
		if idx, exists := seen[p.Path]; exists {
			deduped[idx] = p // overwrite with newer entry
			changed = true
		} else {
			seen[p.Path] = len(deduped)
			deduped = append(deduped, p)
		}
	}
	r.Projects = deduped
	if changed && repair {
		// The in-memory registry is already correct, so a registry that cannot
		// be written (read-only home, for example) must not fail the read.
		_ = r.Save()
	}
	return nil
}

// Save writes the registry to disk, creating parent directories if needed.
func (r *Registry) Save() error {
	if err := os.MkdirAll(filepath.Dir(r.filePath), 0755); err != nil {
		return fmt.Errorf("create registry dir: %w", err)
	}
	data, err := json.MarshalIndent(r.Projects, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal registry: %w", err)
	}
	return os.WriteFile(r.filePath, data, 0644)
}

// Add registers a project that keeps its knowledge in an in-repo .knowns/
// directory. If the path is already registered, returns the existing entry
// without duplicating. A store-linked project is registered with AddStoreLinked.
func (r *Registry) Add(projectPath string) (*Project, error) {
	absPath, err := canonicalAbs(projectPath)
	if err != nil {
		return nil, err
	}

	// Dedup by path. A store-linked project stays valid without a local .knowns/.
	if existing := r.FindByPath(absPath); existing != nil && existing.Store != nil {
		return existing, nil
	}

	knDir := filepath.Join(absPath, ".knowns")
	if info, err := os.Stat(knDir); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("no .knowns/ directory found at %s and no store is linked; run 'knowns init' to keep knowledge in the repository, or 'knowns store link <remote>' to keep it in a store", absPath)
	}
	if _, err := os.Stat(filepath.Join(knDir, "config.json")); err != nil {
		return nil, fmt.Errorf("no config.json found at %s — run 'knowns init' first", absPath)
	}

	if existing := r.FindByPath(absPath); existing != nil {
		return existing, nil
	}

	p := Project{
		ID:       util.GenerateID(),
		Name:     filepath.Base(absPath),
		Path:     absPath,
		LastUsed: time.Now(),
	}
	r.Projects = append(r.Projects, p)
	return &p, r.Save()
}

// AddStoreLinked registers a project whose knowledge lives in a store, or
// records the mapping on an existing entry. The code repository needs no
// .knowns/ directory; the mapping must resolve to an initialized project
// folder in a store clone.
func (r *Registry) AddStoreLinked(projectPath string, mapping StoreMapping) (*Project, error) {
	absPath, err := canonicalAbs(projectPath)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(absPath); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("project directory not found at %s", absPath)
	}
	if !isPathSegment(mapping.Name) || !isPathSegment(mapping.Project) {
		return nil, fmt.Errorf("store mapping needs a store name and a project folder, each a single path segment (got %q and %q)", mapping.Name, mapping.Project)
	}
	candidate := Project{Path: absPath, Store: &mapping}
	if !r.IsValid(candidate) {
		return nil, fmt.Errorf("store %q has no initialized project folder %q at %s", mapping.Name, mapping.Project, r.KnowledgeRoot(candidate))
	}

	if existing := r.FindByPath(absPath); existing != nil {
		existing.Store = &mapping
		return existing, r.Save()
	}
	p := Project{
		ID:       util.GenerateID(),
		Name:     filepath.Base(absPath),
		Path:     absPath,
		LastUsed: time.Now(),
		Store:    &mapping,
	}
	r.Projects = append(r.Projects, p)
	return &p, r.Save()
}

// SetMachine replaces the machine-state settings of the store-linked project
// registered for projectPath. An empty map removes them.
func (r *Registry) SetMachine(projectPath string, machine map[string]json.RawMessage) error {
	p := r.FindStoreLinked(projectPath)
	if p == nil {
		return fmt.Errorf("no store is linked at %s", projectPath)
	}
	if len(machine) == 0 {
		p.Machine = nil
	} else {
		p.Machine = machine
	}
	return r.Save()
}

// ClearStore removes the store mapping from the project at projectPath. The
// entry stays registered; it becomes an in-repo project again.
func (r *Registry) ClearStore(projectPath string) error {
	absPath, err := canonicalAbs(projectPath)
	if err != nil {
		return err
	}
	existing := r.FindByPath(absPath)
	if existing == nil || existing.Store == nil {
		return fmt.Errorf("no store is linked at %s", absPath)
	}
	existing.Store = nil
	return r.Save()
}

// isPathSegment reports whether name is one plain directory name, so a store
// mapping can never resolve outside the stores directory.
func isPathSegment(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name && !strings.ContainsAny(name, `/\`)
}

func canonicalAbs(projectPath string) (string, error) {
	absPath, err := filepath.Abs(projectPath)
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	// Store the on-disk spelling so the same folder reached through a
	// differently cased path resolves to one entry.
	return util.CanonicalPath(absPath), nil
}

// Remove deletes a project from the registry by ID.
func (r *Registry) Remove(id string) error {
	for i, p := range r.Projects {
		if p.ID == id {
			r.Projects = append(r.Projects[:i], r.Projects[i+1:]...)
			return r.Save()
		}
	}
	return fmt.Errorf("project %s not found", id)
}

// SetActive updates the LastUsed timestamp for the given project ID.
func (r *Registry) SetActive(id string) error {
	for i, p := range r.Projects {
		if p.ID == id {
			r.Projects[i].LastUsed = time.Now()
			return r.Save()
		}
	}
	return fmt.Errorf("project %s not found", id)
}

// GetActive returns the most recently used project, or nil if empty.
func (r *Registry) GetActive() *Project {
	if len(r.Projects) == 0 {
		return nil
	}
	best := &r.Projects[0]
	for i := 1; i < len(r.Projects); i++ {
		if r.Projects[i].LastUsed.After(best.LastUsed) {
			best = &r.Projects[i]
		}
	}
	return best
}

// FindByPath returns the project with the given absolute path, or nil.
// The lookup compares on-disk spelling, so any casing that names the stored
// folder finds it. Stored paths are canonicalized by Add and Load.
func (r *Registry) FindByPath(absPath string) *Project {
	canonical := util.CanonicalPath(absPath)
	for i, p := range r.Projects {
		if p.Path == canonical {
			return &r.Projects[i]
		}
	}
	return nil
}

// FindStoreLinked returns the store-linked project registered for dir, also
// when dir and the registered path name the same folder through different
// symlinks (a shell cwd is usually symlink-resolved, a registered path may
// not be).
func (r *Registry) FindStoreLinked(dir string) *Project {
	if p := r.FindByPath(dir); p != nil {
		if p.Store != nil {
			return p
		}
		return nil
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil
	}
	for i, p := range r.Projects {
		if p.Store == nil {
			continue
		}
		if candidate, err := filepath.EvalSymlinks(p.Path); err == nil && candidate == resolved {
			return &r.Projects[i]
		}
	}
	return nil
}

// FindByKnowledgeRoot returns the store-linked project whose knowledge lives
// at dir, or nil. In-repo projects are found by path with FindByPath.
func (r *Registry) FindByKnowledgeRoot(dir string) *Project {
	canonical := util.CanonicalPath(dir)
	resolved, resolveErr := filepath.EvalSymlinks(dir)
	for i, p := range r.Projects {
		if p.Store == nil {
			continue
		}
		root := r.KnowledgeRoot(p)
		if util.CanonicalPath(root) == canonical {
			return &r.Projects[i]
		}
		if resolveErr == nil {
			if candidate, err := filepath.EvalSymlinks(root); err == nil && candidate == resolved {
				return &r.Projects[i]
			}
		}
	}
	return nil
}

// Scan walks the given directories (depth 1) looking for subdirectories
// that contain a .knowns/ folder. Newly discovered projects are added to
// the registry. Returns the list of newly added projects.
func (r *Registry) Scan(dirs []string) ([]Project, error) {
	var added []Project
	for _, dir := range dirs {
		absDir, err := filepath.Abs(dir)
		if err != nil {
			continue
		}
		entries, err := os.ReadDir(absDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			candidate := filepath.Join(absDir, entry.Name())
			knDir := filepath.Join(candidate, ".knowns")
			if info, err := os.Stat(knDir); err == nil && info.IsDir() {
				if _, cfgErr := os.Stat(filepath.Join(knDir, "config.json")); cfgErr != nil {
					continue // not a properly initialized project
				}
				if r.FindByPath(candidate) != nil {
					continue // already registered
				}
				p, err := r.Add(candidate)
				if err == nil && p != nil {
					added = append(added, *p)
				}
			}
		}
	}
	return added, nil
}
