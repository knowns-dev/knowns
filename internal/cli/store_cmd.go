package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/registry"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/storesync"
	"github.com/spf13/cobra"
)

// storeGitTimeout bounds every Git operation a store command runs, so an
// unreachable remote fails instead of hanging.
var storeGitTimeout = 2 * time.Minute

var storeCmd = &cobra.Command{
	Use:   "store",
	Short: "Keep project knowledge in a shared Git store instead of the repository",
}

// --- store link ---

var storeLinkCmd = &cobra.Command{
	Use:   "link <remote>",
	Short: "Link this repository to a knowledge store",
	Long: `Link the current code repository to a project folder in a store: a Git
repository that holds the knowledge of one or more projects.

The store is cloned into ~/.knowns/stores/<store>/ when it is not already
present, the project folder is created or adopted, and the link is recorded
in ~/.knowns/registry.json. No file is written into the code repository.

Git uses your existing ssh-agent or credential helper; Knowns never stores a
credential and never prompts.`,
	Args: cobra.ExactArgs(1),
	RunE: runStoreLink,
}

func runStoreLink(cmd *cobra.Command, args []string) error {
	remote := strings.TrimSpace(args[0])
	codeRoot, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("cannot determine working directory: %w", err)
	}
	project, _ := cmd.Flags().GetString("as")
	if project == "" {
		project = filepath.Base(codeRoot)
	}
	storeName, _ := cmd.Flags().GetString("store")
	if storeName == "" {
		storeName = storeNameFromRemote(remote)
	}
	migrate, _ := cmd.Flags().GetBool("migrate")
	inRepo := filepath.Join(codeRoot, ".knowns")
	if migrate && !isInitializedFolder(inRepo) {
		return fmt.Errorf("--migrate needs an initialized %s to move into the store", inRepo)
	}

	reg := registry.NewRegistryWithPath(filepath.Join(storage.GlobalRootPath(), "registry.json"))
	if err := reg.Load(); err != nil {
		return fmt.Errorf("read registry: %w", err)
	}
	mapping := registry.StoreMapping{Name: storeName, Project: project, Remote: remote}
	if !isStoreSegment(storeName) || !isStoreSegment(project) {
		return fmt.Errorf("store name %q and project %q must each be a single folder name; use --store and --as to choose them", storeName, project)
	}

	clone := filepath.Join(reg.StoresRoot(), storeName)
	cloned, err := ensureStoreClone(cmd.Context(), clone, remote)
	if err != nil {
		return err
	}

	if _, err := storage.EnsureStoreGitignore(clone); err != nil {
		return err
	}

	folder := filepath.Join(clone, project)
	adopted := isInitializedFolder(folder)
	var migrated *migrationReport
	switch {
	case migrate:
		if folderHasContent(folder) {
			return fmt.Errorf("store folder %s already has content; migrate into another folder with --as", folder)
		}
		report, err := copyKnowledge(inRepo, folder)
		if err != nil {
			return fmt.Errorf("copy %s into the store: %w", inRepo, err)
		}
		migrated = &report
	case !adopted:
		if err := storage.NewStoreWithProjectRoot(folder, codeRoot).Init(project); err != nil {
			return fmt.Errorf("initialize project folder %s: %w", folder, err)
		}
	}

	if _, err := reg.AddStoreLinked(codeRoot, mapping); err != nil {
		return err
	}
	if migrated != nil {
		// Move personal and machine settings out of the team file before the
		// first sync commits it (D13).
		if loc, err := storage.LocateProjectAt(codeRoot); err == nil {
			store := loc.Open()
			if project, err := store.Config.Load(); err == nil {
				if err := store.Config.Save(project); err != nil {
					return fmt.Errorf("split migrated configuration: %w", err)
				}
			}
		}
	}
	// The shared runtime keeps the store in sync from now on.
	if err := runtimequeue.EnsureDaemon(); err != nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: could not start the runtime that syncs the store: %v\n", err)
	}

	action := "Created"
	if adopted {
		action = "Adopted"
	}
	if migrated != nil {
		action = "Migrated into"
	}
	out := cmd.OutOrStdout()
	if cloned {
		fmt.Fprintf(out, "Cloned store %s into %s\n", remote, clone)
	}
	fmt.Fprintf(out, "%s project folder %s\n", action, folder)
	fmt.Fprintf(out, "Linked %s to store %q (project %q)\n", codeRoot, storeName, project)
	if migrated != nil {
		printMigrationReport(out, *migrated, inRepo)
		return nil
	}
	if _, err := os.Stat(filepath.Join(codeRoot, ".knowns")); err == nil {
		fmt.Fprintf(cmd.ErrOrStderr(), "Warning: %s is ignored from now on; move its contents into the store before removing it.\n", filepath.Join(codeRoot, ".knowns"))
	}
	return nil
}

// ensureStoreClone makes sure dir is a clone of remote. It clones when dir is
// absent and reports whether it did; an existing clone of another remote is an
// error rather than something to overwrite.
func ensureStoreClone(ctx context.Context, dir, remote string) (bool, error) {
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		origin, err := runStoreGit(ctx, dir, "remote", "get-url", "origin")
		if err != nil {
			return false, fmt.Errorf("%s exists but is not a Git clone of a store: %w", dir, err)
		}
		if strings.TrimSpace(origin) != remote {
			return false, fmt.Errorf("%s is already a clone of %s, not %s; use --store to pick another store name", dir, strings.TrimSpace(origin), remote)
		}
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return false, fmt.Errorf("create stores directory: %w", err)
	}
	// Knowledge files are hashed byte for byte; keep Git on Windows from turning LF into CRLF in the
	// clone. -c on clone is stored in the new repository, so every later sync keeps it.
	if _, err := runStoreGit(ctx, "", "clone", "-c", "core.autocrlf=false", "--", remote, dir); err != nil {
		_ = os.RemoveAll(dir)
		return false, fmt.Errorf("could not clone store %s: %w", remote, err)
	}
	return true, nil
}

func runStoreGit(ctx context.Context, dir string, args ...string) (string, error) {
	return storesync.Git(ctx, dir, storeGitTimeout, nil, args...)
}

// --- store unlink ---

var storeUnlinkCmd = &cobra.Command{
	Use:   "unlink",
	Short: "Remove this repository's link to a knowledge store",
	Long: `Remove the store link recorded for the current code repository. The store
clone and the code repository are left intact.`,
	Args: cobra.NoArgs,
	RunE: runStoreUnlink,
}

func runStoreUnlink(cmd *cobra.Command, args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("cannot determine working directory: %w", err)
	}
	loc, err := storage.LocateProject(cwd)
	if err != nil || loc.Store == nil {
		return fmt.Errorf("no store is linked for %s", cwd)
	}
	reg := registry.NewRegistryWithPath(filepath.Join(storage.GlobalRootPath(), "registry.json"))
	if err := reg.Load(); err != nil {
		return fmt.Errorf("read registry: %w", err)
	}
	p := reg.FindStoreLinked(loc.ProjectRoot)
	if p == nil {
		return fmt.Errorf("no store is linked for %s", loc.ProjectRoot)
	}
	if err := reg.ClearStore(p.Path); err != nil {
		return err
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Unlinked %s from store %q; the store clone at %s was left in place\n", p.Path, loc.Store.Name, loc.KnowledgeRoot)
	return nil
}

// storeNameFromRemote derives a store folder name from a Git remote:
// git@host:team/knowledge.git, https://host/team/knowledge and a Windows
// path C:\git\knowledge.git all give "knowledge".
func storeNameFromRemote(remote string) string {
	name := strings.TrimRight(remote, `/\`)
	if i := strings.LastIndexAny(name, `/\:`); i >= 0 {
		name = name[i+1:]
	}
	return strings.TrimSuffix(name, ".git")
}

func isStoreSegment(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\:`)
}

func isInitializedFolder(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "config.json"))
	return err == nil
}

func init() {
	storeLinkCmd.Flags().String("as", "", "Project folder name in the store (default: current directory name)")
	storeLinkCmd.Flags().String("store", "", "Store folder name under ~/.knowns/stores (default: derived from the remote)")
	storeLinkCmd.Flags().Bool("migrate", false, "Copy this repository's .knowns/ into the store folder, keeping every ID; the repository is left untouched")
	storeCmd.AddCommand(storeLinkCmd)
	storeCmd.AddCommand(storeUnlinkCmd)
	rootCmd.AddCommand(storeCmd)
}
