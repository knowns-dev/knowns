package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SyncArrival records that a file of a store-linked project last changed
// through store sync: who wrote it and when it arrived here. It lives in the
// machine-local history state, which is never synced (store spec D1).
type SyncArrival struct {
	// Path is relative to the knowledge root, slash-separated.
	Path      string    `json:"path"`
	Author    string    `json:"author"`
	Commit    string    `json:"commit,omitempty"`
	ArrivedAt time.Time `json:"arrivedAt"`
	// ContentSHA is the SHA-256 of the file as it arrived. A later local
	// write changes the file, so the arrival no longer explains its state.
	ContentSHA string `json:"contentSha"`
}

func syncArrivalsPath(knowledgeRoot string) string {
	return filepath.Join(knowledgeRoot, "history", "state", "sync-arrivals.json")
}

// RecordSyncArrivals remembers files that just arrived through sync. The
// content hash is taken from the file on disk when not supplied; a path that
// no longer exists (deleted upstream) is forgotten.
func RecordSyncArrivals(knowledgeRoot string, arrivals []SyncArrival) error {
	if len(arrivals) == 0 {
		return nil
	}
	known := map[string]SyncArrival{}
	_ = readJSON(syncArrivalsPath(knowledgeRoot), &known)
	for _, a := range arrivals {
		a.Path = filepath.ToSlash(a.Path)
		if a.ContentSHA == "" {
			sum, err := fileSHA(filepath.Join(knowledgeRoot, filepath.FromSlash(a.Path)))
			if err != nil {
				delete(known, a.Path)
				continue
			}
			a.ContentSHA = sum
		}
		known[a.Path] = a
	}
	return writeJSON(syncArrivalsPath(knowledgeRoot), known)
}

// syncArrivalFor returns the arrival that explains the current content of
// rel, if its content is still exactly what arrived.
func (s *Store) syncArrivalFor(rel string) (SyncArrival, bool) {
	known := map[string]SyncArrival{}
	if err := readJSON(syncArrivalsPath(s.Root), &known); err != nil {
		return SyncArrival{}, false
	}
	a, ok := known[filepath.ToSlash(rel)]
	if !ok {
		return SyncArrival{}, false
	}
	sum, err := fileSHA(filepath.Join(s.Root, filepath.FromSlash(rel)))
	if err != nil || sum != a.ContentSHA {
		return SyncArrival{}, false
	}
	return a, true
}

// SyncConflictError is a stale write whose current state arrived through
// store sync. Its message tells the caller everything needed to recover
// without another diagnostic call (FR-12, FR-13).
type SyncConflictError struct {
	*MutationConflictError
	Path      string
	Author    string
	ArrivedAt time.Time
}

func (e *SyncConflictError) Error() string {
	noun := e.EntityType
	return fmt.Sprintf("%s %q was changed by %s and arrived through store sync at %s, after the version your write was based on. Nothing was written. Reread the %s and apply your change to the version you just read.",
		noun, e.label(), e.Author, e.ArrivedAt.UTC().Format(time.RFC3339), noun)
}

// label names the entity the way its caller addressed it: a Doc by its path,
// a task by its ID.
func (e *SyncConflictError) label() string {
	if e.EntityType == "doc" && strings.HasPrefix(e.Path, "docs/") {
		return strings.TrimSuffix(strings.TrimPrefix(e.Path, "docs/"), ".md")
	}
	return e.EntityID
}

func (e *SyncConflictError) Unwrap() error { return e.MutationConflictError }

// explainConflict turns a stale-hash conflict into a SyncConflictError when
// the entity's current state is exactly what store sync delivered. Any other
// error is returned unchanged.
func (s *Store) explainConflict(err error) error {
	var conflict *MutationConflictError
	if err == nil || !errors.As(err, &conflict) {
		return err
	}
	var already *SyncConflictError
	if errors.As(err, &already) {
		return err
	}
	for _, rel := range s.conflictPaths(conflict) {
		if a, ok := s.syncArrivalFor(rel); ok {
			author := a.Author
			if author == "" {
				author = "a teammate"
			}
			return &SyncConflictError{MutationConflictError: conflict, Path: rel, Author: author, ArrivedAt: a.ArrivedAt}
		}
	}
	return err
}

// conflictPaths lists the files, relative to the knowledge root, that may
// hold the entity of a conflict.
func (s *Store) conflictPaths(c *MutationConflictError) []string {
	switch c.EntityType {
	case "task":
		abs, err := s.Tasks.CanonicalPath(c.EntityID)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(s.Root, abs)
		if err != nil {
			return nil
		}
		return []string{filepath.ToSlash(rel)}
	case "doc":
		id := normalizeDocPath(c.EntityID)
		paths := []string{"docs/" + id + ".md"}
		if _, err := os.Stat(filepath.Join(s.Root, "docs", filepath.FromSlash(id)+".md")); err != nil {
			if docs, err := s.Docs.List(); err == nil {
				for _, d := range docs {
					if d.ID == c.EntityID {
						paths = append(paths, "docs/"+strings.TrimSuffix(d.Path, ".md")+".md")
					}
				}
			}
		}
		return paths
	}
	return nil
}

func fileSHA(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
