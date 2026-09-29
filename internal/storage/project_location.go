package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
)

// ProjectLocation is where a project's knowledge and code live. The two roots
// are independent: a store-linked project keeps its knowledge in a store clone.
type ProjectLocation struct {
	KnowledgeRoot string
	ProjectRoot   string
	// Store names the store mapping the location came from; nil for an
	// in-repo project.
	Store *registry.StoreMapping
	// IgnoredKnowns is an in-repo .knowns/ directory that exists but is not
	// used because the project is linked to a store. Callers warn about it.
	IgnoredKnowns string
	// BrokenStore is a store mapping recorded for the repository whose folder
	// is missing or not initialized, so an in-repo .knowns/ is used instead.
	// Callers warn about it.
	BrokenStore *registry.StoreMapping
	// BrokenStoreFolder is where the broken mapping points.
	BrokenStoreFolder string
}

// Open returns a Store for the location.
func (l ProjectLocation) Open() *Store {
	return NewStoreWithProjectRoot(l.KnowledgeRoot, l.ProjectRoot)
}

// Warnings are the messages callers print for this location: an in-repo
// .knowns/ shadowed by a store, or a store mapping that cannot be used.
func (l ProjectLocation) Warnings() []string {
	var out []string
	if msg := l.IgnoredKnownsWarning(); msg != "" {
		out = append(out, msg)
	}
	if l.BrokenStore != nil {
		out = append(out, brokenStoreMessage(l.BrokenStore, l.BrokenStoreFolder)+fmt.Sprintf("; using %s meanwhile.", l.KnowledgeRoot))
	}
	return out
}

func brokenStoreMessage(m *registry.StoreMapping, folder string) string {
	return fmt.Sprintf("this repository is linked to store %q (folder %q), but %s is missing or not initialized; run 'knowns store link' again or check the store clone", m.Name, m.Project, folder)
}

// IgnoredKnownsWarning is the message callers print when an in-repo .knowns/
// is shadowed by a store mapping, or "" when nothing is ignored.
func (l ProjectLocation) IgnoredKnownsWarning() string {
	if l.IgnoredKnowns == "" || l.Store == nil {
		return ""
	}
	return fmt.Sprintf("%s is ignored: this project's knowledge lives in store %q (folder %q). Remove it once everyone on the project has migrated.", l.IgnoredKnowns, l.Store.Name, l.Store.Project)
}

// LocateProject walks up from startDir to the nearest directory that is a
// project, either through a store mapping in the machine registry or through
// an initialized in-repo .knowns/ directory. At the same directory a store
// mapping wins over an in-repo .knowns/.
func LocateProject(startDir string) (ProjectLocation, error) {
	reg := loadMachineRegistry()
	dir := startDir
	for {
		if loc, ok, err := locateAt(reg, dir); ok || err != nil {
			return loc, err
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ProjectLocation{}, fmt.Errorf("no .knowns/ directory found (started from %s)", startDir)
}

// LocateProjectAt resolves exactly projectRoot, without walking up, for callers
// that were handed a project directory such as --project or set_project.
func LocateProjectAt(projectRoot string) (ProjectLocation, error) {
	abs, err := filepath.Abs(projectRoot)
	if err != nil {
		return ProjectLocation{}, fmt.Errorf("resolve path: %w", err)
	}
	if loc, ok, err := locateAt(loadMachineRegistry(), abs); ok || err != nil {
		return loc, err
	}
	return ProjectLocation{}, fmt.Errorf("no initialized .knowns/ directory and no linked store at %s", abs)
}

// locateAt resolves dir itself. ok reports a project at dir; err reports a
// store mapping at dir that cannot be used and has no in-repo fallback.
func locateAt(reg *registry.Registry, dir string) (ProjectLocation, bool, error) {
	inRepo := filepath.Join(dir, ".knowns")
	inRepoValid := isInitializedKnowns(inRepo)

	var broken *registry.Project
	if reg != nil {
		if p := reg.FindStoreLinked(dir); p != nil {
			if reg.IsValid(*p) {
				loc := ProjectLocation{KnowledgeRoot: reg.KnowledgeRoot(*p), ProjectRoot: dir, Store: p.Store}
				if info, err := os.Stat(inRepo); err == nil && info.IsDir() {
					loc.IgnoredKnowns = inRepo
				}
				return loc, true, nil
			}
			broken = p
		}
	}
	if inRepoValid {
		loc := ProjectLocation{KnowledgeRoot: inRepo, ProjectRoot: dir}
		if broken != nil {
			loc.BrokenStore, loc.BrokenStoreFolder = broken.Store, reg.KnowledgeRoot(*broken)
		}
		return loc, true, nil
	}
	if broken != nil {
		return ProjectLocation{}, false, fmt.Errorf("%s", brokenStoreMessage(broken.Store, reg.KnowledgeRoot(*broken)))
	}
	return ProjectLocation{}, false, nil
}

func isInitializedKnowns(dir string) bool {
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, "config.json"))
	return err == nil
}

// projectRootForKnowledgeRoot is the code root for a Store built from a
// knowledge root alone. An in-repo .knowns/ sits inside its repository; a
// folder in a store clone belongs to whichever repository the registry maps to
// it. Other roots (global stores) keep the parent directory. NewStore runs on
// hot paths, so the in-repo case costs nothing and store lookups are cached.
func projectRootForKnowledgeRoot(knowledgeRoot string) string {
	if filepath.Base(knowledgeRoot) != ".knowns" && inStoresDir(knowledgeRoot) {
		if projectRoot, ok := storeProjectRoots.lookup(knowledgeRoot); ok {
			return projectRoot
		}
	}
	return inRepoProjectRoot(knowledgeRoot)
}

// inStoresDir is a cheap textual gate: every store folder sits under
// <global root>/stores, which always ends in .knowns/stores.
func inStoresDir(path string) bool {
	marker := string(filepath.Separator) + filepath.Join(".knowns", "stores") + string(filepath.Separator)
	return strings.Contains(filepath.Clean(path)+string(filepath.Separator), marker)
}

// storeProjectRootCache maps store folders to code roots, rebuilt whenever
// the registry file changes on disk.
type storeProjectRootCache struct {
	mu      sync.Mutex
	file    string
	modTime time.Time
	size    int64
	roots   map[string]string
}

var storeProjectRoots storeProjectRootCache

func (c *storeProjectRootCache) lookup(knowledgeRoot string) (string, bool) {
	file := filepath.Join(GlobalRootPath(), "registry.json")
	info, err := os.Stat(file)
	if err != nil {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.roots == nil || c.file != file || !c.modTime.Equal(info.ModTime()) || c.size != info.Size() {
		c.file, c.modTime, c.size, c.roots = file, info.ModTime(), info.Size(), map[string]string{}
	}
	if root, ok := c.roots[knowledgeRoot]; ok {
		return root, root != ""
	}
	root := ""
	if reg := loadMachineRegistry(); reg != nil {
		if p := reg.FindByKnowledgeRoot(knowledgeRoot); p != nil {
			root = p.Path
		}
	}
	c.roots[knowledgeRoot] = root
	return root, root != ""
}

// loadMachineRegistry reads ~/.knowns/registry.json. A missing or unreadable
// registry means no store mappings; resolution falls back to in-repo projects.
func loadMachineRegistry() *registry.Registry {
	reg := registry.NewRegistryWithPath(filepath.Join(GlobalRootPath(), "registry.json"))
	if err := reg.LoadReadOnly(); err != nil {
		return nil
	}
	return reg
}
