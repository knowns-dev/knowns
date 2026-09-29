package storesync

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Resolution marks conflicting paths of a paused project as settled by the
// user. Resolvers never edit the runtime's state file directly: they append a
// Resolution, and the runtime applies it on its next tick.
type Resolution struct {
	Project    string    `json:"project"`
	Paths      []string  `json:"paths"`
	ResolvedAt time.Time `json:"resolvedAt"`
}

func resolutionsPath(stateDir, store string) string {
	return filepath.Join(stateDir, store+".resolved.json")
}

// RecordResolution queues a resolution for the runtime to apply.
func RecordResolution(stateDir, store string, r Resolution) error {
	if r.ResolvedAt.IsZero() {
		r.ResolvedAt = time.Now().UTC()
	}
	var pending []Resolution
	if data, err := os.ReadFile(resolutionsPath(stateDir, store)); err == nil {
		_ = json.Unmarshal(data, &pending)
	}
	pending = append(pending, r)
	data, err := json.MarshalIndent(pending, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return err
	}
	tmp := resolutionsPath(stateDir, store) + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, resolutionsPath(stateDir, store))
}

// applyResolutions drops resolved paths from the store's conflicts; a
// project with no conflicting path left resumes syncing.
func (s *Service) applyResolutions(rt *storeRuntime) {
	if s.cfg.StateDir == "" {
		return
	}
	path := resolutionsPath(s.cfg.StateDir, rt.state.Store)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var pending []Resolution
	if err := json.Unmarshal(data, &pending); err != nil {
		rt.state.LastError = fmt.Sprintf("unreadable resolutions file %s: %v", path, err)
		return
	}
	for _, r := range pending {
		resolved := map[string]bool{}
		for _, p := range r.Paths {
			resolved[p] = true
		}
		kept := rt.state.Conflicts[:0]
		for _, c := range rt.state.Conflicts {
			if c.Project == r.Project {
				var remaining []string
				for _, p := range c.Paths {
					if !resolved[p] {
						remaining = append(remaining, p)
					}
				}
				c.Paths = remaining
				if len(c.Paths) == 0 {
					continue
				}
			}
			kept = append(kept, c)
		}
		rt.state.Conflicts = kept
	}
	sort.Slice(rt.state.Conflicts, func(i, j int) bool { return rt.state.Conflicts[i].Project < rt.state.Conflicts[j].Project })
	_ = os.Remove(path)
	s.persist(rt.state)
}
