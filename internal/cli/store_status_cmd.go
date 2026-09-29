package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/storesync"
	"github.com/spf13/cobra"
)

// storeStateDir is where the runtime persists per-store sync state.
var storeStateDir = func() string {
	return filepath.Join(runtimequeue.RuntimeRoot(), "stores")
}

// storeProjectStatus is one row of `knowns store status`.
type storeProjectStatus struct {
	Store         string    `json:"store"`
	Project       string    `json:"project"`
	CodeRoot      string    `json:"codeRoot"`
	Folder        string    `json:"folder"`
	State         string    `json:"state"`
	Cause         string    `json:"cause,omitempty"`
	PausedSince   time.Time `json:"pausedSince,omitempty"`
	ConflictPaths []string  `json:"conflictPaths,omitempty"`
	LastPush      time.Time `json:"lastPush,omitempty"`
	LastFetch     time.Time `json:"lastFetch,omitempty"`
	QueuedCommits int       `json:"queuedCommits"`
	LastError     string    `json:"lastError,omitempty"`
}

// Store project states.
const (
	storeStateHealthy        = "healthy"
	storeStateNotSynced      = "not synced yet"
	storeStatePausedConflict = "paused: conflict"
	storeStatePausedStore    = "paused: store"
)

var storeStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show sync state for every repository linked to a store",
	Long: `Show, for every repository linked to a knowledge store on this machine, the
store and project folder, the last push and fetch, commits waiting to be pushed,
and whether sync is healthy or paused and why.`,
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		rows, err := collectStoreStatus(storeStateDir())
		if err != nil {
			return err
		}
		if isJSON(cmd) {
			data, _ := json.MarshalIndent(rows, "", "  ")
			fmt.Fprintln(cmd.OutOrStdout(), string(data))
			return nil
		}
		printStoreStatus(cmd.OutOrStdout(), rows, time.Now())
		if len(rows) > 0 && !runtimequeue.IsRunning() && !runtimequeue.ShouldBypassDaemon() {
			fmt.Fprintln(cmd.OutOrStdout(), "\nThe runtime that syncs stores is not running; any Knowns command that writes knowledge starts it, as does 'knowns store resolve'.")
		}
		return nil
	},
}

func collectStoreStatus(stateDir string) ([]storeProjectStatus, error) {
	reg := registry.NewRegistryWithPath(filepath.Join(storage.GlobalRootPath(), "registry.json"))
	if err := reg.LoadReadOnly(); err != nil {
		return nil, fmt.Errorf("read registry: %w", err)
	}
	var rows []storeProjectStatus
	for _, p := range reg.Projects {
		if p.Store == nil {
			continue
		}
		row := storeProjectStatus{Store: p.Store.Name, Project: p.Store.Project, CodeRoot: p.Path, Folder: reg.KnowledgeRoot(p)}
		state, err := storesync.LoadState(stateDir, p.Store.Name)
		switch {
		case err != nil:
			row.State = storeStateNotSynced
			row.Cause = "the runtime has not synced this store yet; it starts with any Knowns command"
		case state.Paused:
			row.State = storeStatePausedStore
			row.Cause = state.PauseCause + ": " + state.PauseMessage
			row.PausedSince = state.PausedSince
		default:
			row.State = storeStateHealthy
		}
		if err == nil {
			row.LastPush, row.LastFetch, row.QueuedCommits, row.LastError = state.LastPush, state.LastFetch, state.QueuedCommits, state.LastError
			for _, c := range state.Conflicts {
				if c.Project == p.Store.Project && row.State != storeStatePausedStore {
					row.State = storeStatePausedConflict
					row.Cause = "conflicting changes in " + strings.Join(c.Paths, ", ") + "; run 'knowns store resolve'"
					row.PausedSince = c.Since
					row.ConflictPaths = c.Paths
				}
			}
		}
		rows = append(rows, row)
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Store != rows[j].Store {
			return rows[i].Store < rows[j].Store
		}
		return rows[i].Project < rows[j].Project
	})
	return rows, nil
}

func printStoreStatus(out io.Writer, rows []storeProjectStatus, now time.Time) {
	if len(rows) == 0 {
		fmt.Fprintln(out, "No repository on this machine is linked to a store. Link one with 'knowns store link <remote>'.")
		return
	}
	w := tabwriter.NewWriter(out, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "STORE\tPROJECT\tSTATE\tLAST PUSH\tLAST FETCH\tQUEUED")
	for _, r := range rows {
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%d\n", r.Store, r.Project, r.State, ago(r.LastPush, now), ago(r.LastFetch, now), r.QueuedCommits)
	}
	w.Flush()
	for _, r := range rows {
		if r.State == storeStateHealthy && r.LastError == "" {
			continue
		}
		fmt.Fprintf(out, "\n%s/%s (%s):\n", r.Store, r.Project, r.CodeRoot)
		if r.Cause != "" {
			line := "  " + r.Cause
			if !r.PausedSince.IsZero() {
				line += fmt.Sprintf(" (paused %s)", ago(r.PausedSince, now))
			}
			fmt.Fprintln(out, line)
		}
		if r.LastError != "" {
			fmt.Fprintln(out, "  last error: "+r.LastError)
		}
	}
}

func ago(t, now time.Time) string {
	if t.IsZero() {
		return "never"
	}
	d := now.Sub(t).Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

// --- store resolve ---

var storeResolveCmd = &cobra.Command{
	Use:   "resolve [project] [path...]",
	Short: "Settle conflicting changes that paused a project's sync",
	Long: `Without arguments, list projects paused by a conflict and their conflicting
entities. With a project, show the version in the store's history (remote) and
the version on this machine (local) for each conflicting path, or for the paths
given. With --keep, apply that choice to each of them and let sync resume:

  local   keep this machine's version; it is pushed once sync resumes
  remote  keep the version already in the store
  both    keep this machine's version in place and save the remote version
          beside the runtime state

Nothing is discarded without an explicit --keep.`,
	RunE: runStoreResolve,
}

func runStoreResolve(cmd *cobra.Command, args []string) error {
	out := cmd.OutOrStdout()
	stateDir := storeStateDir()
	rows, err := collectStoreStatus(stateDir)
	if err != nil {
		return err
	}
	if len(args) == 0 {
		found := false
		for _, r := range rows {
			if r.State != storeStatePausedConflict {
				continue
			}
			found = true
			fmt.Fprintf(out, "%s/%s paused %s:\n", r.Store, r.Project, ago(r.PausedSince, time.Now()))
			for _, p := range r.ConflictPaths {
				fmt.Fprintf(out, "  %s\n", p)
			}
		}
		if !found {
			fmt.Fprintln(out, "No project is paused by a conflict.")
			return nil
		}
		fmt.Fprintln(out, "\nShow versions with 'knowns store resolve <project>', then settle with --keep local|remote|both.")
		return nil
	}

	project := args[0]
	storeFlag, _ := cmd.Flags().GetString("store")
	var target *storeProjectStatus
	for i := range rows {
		if rows[i].Project == project && (storeFlag == "" || rows[i].Store == storeFlag) && rows[i].State == storeStatePausedConflict {
			if target != nil {
				return fmt.Errorf("project %q is paused in more than one store; choose one with --store", project)
			}
			target = &rows[i]
		}
	}
	if target == nil {
		return fmt.Errorf("project %q is not paused by a conflict", project)
	}

	paths, err := selectConflictPaths(target, args[1:])
	if err != nil {
		return err
	}
	clone := filepath.Dir(target.Folder)
	keep, _ := cmd.Flags().GetString("keep")
	if keep == "" {
		for _, p := range paths {
			diff, _ := storesync.Git(cmd.Context(), clone, 0, nil, "diff", "--no-color", "HEAD", "--", p)
			if strings.TrimSpace(diff) == "" {
				diff = "(local and remote versions are identical)\n"
			}
			fmt.Fprintf(out, "== %s\n-- remote: the version in the store's history\n++ local: the version on this machine\n%s\n", p, diff)
		}
		fmt.Fprintf(out, "Settle with: knowns store resolve %s %s --keep local|remote|both\n", project, strings.Join(args[1:], " "))
		return nil
	}
	if keep != "local" && keep != "remote" && keep != "both" {
		return fmt.Errorf("--keep must be local, remote or both, not %q", keep)
	}

	store := storage.NewStore(target.Folder)
	var rel []string
	for _, p := range paths {
		rel = append(rel, strings.TrimPrefix(filepath.ToSlash(p), target.Project+"/"))
	}
	var saved []string
	err = store.WithSyncLocks(cmd.Context(), rel, func() error {
		for _, p := range paths {
			switch keep {
			case "remote":
				if _, err := storesync.Git(cmd.Context(), clone, 0, nil, "checkout", "HEAD", "--", p); err != nil {
					return fmt.Errorf("restore remote version of %s: %w", p, err)
				}
			case "both":
				remote, err := storesync.Git(cmd.Context(), clone, 0, nil, "show", "HEAD:"+p)
				if err != nil {
					continue // deleted in the store; the local version stays
				}
				dst := filepath.Join(stateDir, target.Store+"-kept", time.Now().UTC().Format("20060102T150405Z"), filepath.FromSlash(p))
				if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(dst, []byte(remote), 0o644); err != nil {
					return err
				}
				saved = append(saved, dst)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := storesync.RecordResolution(stateDir, target.Store, storesync.Resolution{Project: target.Project, Paths: paths}); err != nil {
		return fmt.Errorf("record resolution: %w", err)
	}
	// The runtime applies the resolution; make sure it is running.
	if err := runtimequeue.EnsureDaemon(); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not start the runtime that syncs the store: %v\n", err)
	}
	fmt.Fprintf(out, "Kept the %s version of %d entit%s in %s/%s.\n", keep, len(paths), plural(len(paths), "y", "ies"), target.Store, target.Project)
	for _, s := range saved {
		fmt.Fprintf(out, "Saved the remote version to %s\n", s)
	}
	if remaining := len(target.ConflictPaths) - len(paths); remaining > 0 {
		fmt.Fprintf(out, "%d conflicting entit%s left; sync for %s resumes once all are settled.\n", remaining, plural(remaining, "y", "ies"), target.Project)
	} else {
		fmt.Fprintf(out, "Sync for %s resumes on the runtime's next pass.\n", target.Project)
	}
	return nil
}

// selectConflictPaths maps requested paths (relative to the clone or to the
// project folder) onto the recorded conflicting paths; none means all.
func selectConflictPaths(target *storeProjectStatus, requested []string) ([]string, error) {
	if len(requested) == 0 {
		return target.ConflictPaths, nil
	}
	known := map[string]bool{}
	for _, p := range target.ConflictPaths {
		known[p] = true
	}
	var out []string
	for _, r := range requested {
		r = filepath.ToSlash(strings.TrimSpace(r))
		candidate := r
		if !known[candidate] {
			candidate = target.Project + "/" + r
		}
		if !known[candidate] {
			return nil, fmt.Errorf("%s is not a conflicting path of %s; conflicting paths: %s", r, target.Project, strings.Join(target.ConflictPaths, ", "))
		}
		out = append(out, candidate)
	}
	return out, nil
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func init() {
	storeResolveCmd.Flags().String("keep", "", "Version to keep for each conflicting entity: local, remote or both")
	storeResolveCmd.Flags().String("store", "", "Store name, when the project folder name exists in more than one store")
	storeCmd.AddCommand(storeStatusCmd)
	storeCmd.AddCommand(storeResolveCmd)
}
