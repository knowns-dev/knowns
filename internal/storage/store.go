// Package storage provides read/write access to the .knowns/ directory format.
// It is fully backward-compatible with the TypeScript Knowns CLI.
package storage

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"github.com/howznguyen/knowns/internal/models"
)

const globalSemanticStoreDir = "global"

// Store is the top-level coordinator for all .knowns/ sub-stores.
type Store struct {
	// Root is the absolute path to the .knowns/ directory.
	Root       string
	Tasks      *TaskStore
	Docs       *DocStore
	Config     *ConfigStore
	Time       *TimeStore
	Templates  *TemplateStore
	Versions   *VersionStore
	Workspaces *WorkspaceStore
	Chats      *ChatStore
	Memory     *MemoryStore
	Decisions  *DecisionStore

	taskLifecycleLock *taskLifecycleLock
}

// NewStore creates a Store rooted at the given .knowns/ directory path.
// The directory does not need to exist yet; call Init to create it.
func NewStore(root string) *Store {
	globalRoot := GlobalRootPath()

	lifecycleLock := newTaskLifecycleLock(root)
	s := &Store{Root: root, taskLifecycleLock: lifecycleLock}
	s.Tasks = &TaskStore{root: root, lifecycleLock: lifecycleLock}
	s.Docs = &DocStore{root: root}
	s.Config = &ConfigStore{root: root}
	s.Time = &TimeStore{root: root, lifecycleLock: lifecycleLock}
	s.Templates = &TemplateStore{root: root}
	s.Versions = &VersionStore{root: root, lifecycleLock: lifecycleLock}
	s.Workspaces = &WorkspaceStore{root: root}
	s.Chats = &ChatStore{root: root}
	s.Memory = &MemoryStore{root: root, globalRoot: globalRoot}
	s.Decisions = &DecisionStore{root: root}
	return s
}

// WithTaskLifecycleTransaction serializes a lifecycle mutation across all
// Store instances and processes that point at the same project. The callback
// receives lock-aware storage primitives and must not call the public TaskStore
// mutation methods, which acquire the same lock.
func (s *Store) WithTaskLifecycleTransaction(ctx context.Context, fn func(*TaskLifecycleTransaction) error) error {
	if s == nil || s.taskLifecycleLock == nil {
		return fmt.Errorf("task lifecycle transaction: store is not initialized")
	}
	if fn == nil {
		return fmt.Errorf("task lifecycle transaction: callback is required")
	}
	return s.taskLifecycleLock.with(ctx, func() error {
		return fn(&TaskLifecycleTransaction{store: s})
	})
}

// GlobalRootPath returns the machine-level Knowns root (~/.knowns).
func GlobalRootPath() string {
	if home := os.Getenv("HOME"); home != "" {
		return filepath.Join(home, ".knowns")
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".knowns")
}

// GlobalSemanticStoreRoot returns the dedicated store root for global semantic
// config and indices under the machine-level Knowns directory.
func GlobalSemanticStoreRoot() string {
	return filepath.Join(GlobalRootPath(), globalSemanticStoreDir)
}

// NewGlobalSemanticStore creates a store used for global semantic config and
// indices while continuing to read global memories from ~/.knowns/memory.
func NewGlobalSemanticStore() *Store {
	return NewStore(GlobalSemanticStoreRoot())
}

// SemanticDB returns a connection to the semantic search database (index.db).
// Returns nil if the database does not exist.
func (s *Store) SemanticDB() *sql.DB {
	dbPath := filepath.Join(s.Root, ".search", "index.db")
	if _, err := os.Stat(dbPath); err != nil {
		return nil
	}
	db, err := sql.Open("sqlite", dbPath+"?mode=ro")
	if err != nil {
		return nil
	}
	return db
}

// SemanticDBWritable returns a writable connection to the semantic search database.
// Returns nil if the database does not exist.
func (s *Store) SemanticDBWritable() *sql.DB {
	dbPath := filepath.Join(s.Root, ".search", "index.db")
	if _, err := os.Stat(dbPath); err != nil {
		return nil
	}
	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil
	}
	return db
}

// CodeRefIndexExists is retained as a compatibility stub after code edge storage removal.
func (s *Store) CodeRefIndexExists() bool {
	return false
}

// CodeRefExists is retained as a compatibility stub after code edge storage removal.
// docPath is the file path, symbol is the symbol name (empty for file refs).
func (s *Store) CodeRefExists(docPath, symbol string) bool {
	return false
}

// FindProjectRoot walks up from startDir looking for a .knowns/ directory
// that contains a config.json (i.e. a properly initialized project).
// Returns the absolute path to the .knowns/ directory, or an error if not found.
func FindProjectRoot(startDir string) (string, error) {
	dir := startDir
	for {
		candidate := filepath.Join(dir, ".knowns")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			if _, cfgErr := os.Stat(filepath.Join(candidate, "config.json")); cfgErr == nil {
				return candidate, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("no .knowns/ directory found (started from %s)", startDir)
}

// Init creates the .knowns/ directory structure for a new project.
func (s *Store) Init(name string) error {
	dirs := []string{
		s.Root,
		filepath.Join(s.Root, "tasks"),
		filepath.Join(s.Root, "docs"),
		filepath.Join(s.Root, "archive"),
		filepath.Join(s.Root, "versions"),
		filepath.Join(s.Root, "templates"),
		filepath.Join(s.Root, "imports"),
		filepath.Join(s.Root, ".search"),
		filepath.Join(s.Root, "memory"),
		filepath.Join(s.Root, "decisions"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return fmt.Errorf("init: create dir %s: %w", d, err)
		}
	}

	// Write default config if it does not exist yet.
	configPath := filepath.Join(s.Root, "config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		if err := s.Config.initDefault(name); err != nil {
			return fmt.Errorf("init: write config: %w", err)
		}
	}

	// Write empty time state if it does not exist.
	timePath := filepath.Join(s.Root, "time.json")
	if _, err := os.Stat(timePath); os.IsNotExist(err) {
		if err := s.Time.SaveState(&models.TimeState{Active: []models.ActiveTimer{}}); err != nil {
			return fmt.Errorf("init: write time.json: %w", err)
		}
	}

	// Write empty time-entries if it does not exist.
	entriesPath := filepath.Join(s.Root, "time-entries.json")
	if _, err := os.Stat(entriesPath); os.IsNotExist(err) {
		if err := writeJSON(entriesPath, map[string]interface{}{}); err != nil {
			return fmt.Errorf("init: write time-entries.json: %w", err)
		}
	}

	// Write empty workspaces list if it does not exist.
	wsPath := filepath.Join(s.Root, "workspaces.json")
	if _, err := os.Stat(wsPath); os.IsNotExist(err) {
		if err := writeJSON(wsPath, []interface{}{}); err != nil {
			return fmt.Errorf("init: write workspaces.json: %w", err)
		}
	}

	// Write empty chats list if it does not exist.
	chatsPath := filepath.Join(s.Root, "chats.json")
	if _, err := os.Stat(chatsPath); os.IsNotExist(err) {
		if err := writeJSON(chatsPath, []interface{}{}); err != nil {
			return fmt.Errorf("init: write chats.json: %w", err)
		}
	}

	return nil
}
