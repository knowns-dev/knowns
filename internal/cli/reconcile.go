package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

var reconcileExecute bool
var reconcileWait bool

var reconcileCmd = &cobra.Command{
	Use:   "reconcile",
	Short: "Preview or apply canonical Task/Doc filesystem reconciliation",
	RunE: func(cmd *cobra.Command, args []string) error {
		store, err := getStoreErr()
		if err != nil {
			return err
		}
		root := store.Root
		if reconcileExecute {
			job, err := runtimequeue.Enqueue(root, runtimequeue.JobReconcileKnowledge, "")
			if err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "queued job=%s kind=%s target=%s\n", job.ID, job.Kind, job.Target)
			if reconcileWait {
				result, waitErr := runtimequeue.WaitForJobContext(cmd.Context(), root, job.ID, 30*time.Second)
				if waitErr != nil {
					return waitErr
				}
				if !result.Success {
					return fmt.Errorf("reconcile job failed: %s", result.Error)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "completed job=%s\n", result.JobID)
			}
			return nil
		}
		r, err := storage.NewFilesystemReconciler(root)
		if err != nil {
			return err
		}
		results, err := r.Reconcile(cmd.Context(), false)
		if err != nil {
			return err
		}
		for _, result := range results {
			switch {
			case result.Diagnostic != "":
				fmt.Fprintf(cmd.OutOrStdout(), "unsafe path=%s diagnostic=%s\n", result.Path, result.Diagnostic)
			case result.Changed:
				fmt.Fprintf(cmd.OutOrStdout(), "would-reconcile type=%s id=%s path=%s revision=%d hash=%s\n", result.EntityType, result.EntityID, result.Path, result.Revision, result.Hash)
			default:
				fmt.Fprintf(cmd.OutOrStdout(), "unchanged type=%s id=%s path=%s hash=%s\n", result.EntityType, result.EntityID, result.Path, result.Hash)
			}
		}
		return nil
	},
}

var reconcileRestoreExecute bool

var reconcileRestoreCmd = &cobra.Command{
	Use:   "restore <task|doc> <id-or-path>",
	Short: "Preview or reactivate a Task or Doc whose history records a deletion",
	Long: `Reactivate a Task or Doc whose history head is a delete tombstone.

A Task is named by its ID and a Doc by its path. Without --execute the command
only reports what it would do. It refuses when the file on disk holds content
the tombstone did not record, so it never adopts bytes the entity did not own.

This is not "task unarchive": unarchive reopens an archived Task, restore undoes
a recorded deletion.`,
	Args: cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		kind := strings.ToLower(strings.TrimSpace(args[0]))
		if kind != "task" && kind != "doc" {
			return fmt.Errorf("unknown entity type %q: use task or doc", args[0])
		}
		store, err := getStoreErr()
		if err != nil {
			return err
		}
		plan, err := store.PlanTombstoneRestore(kind, args[1])
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		if !plan.Tombstoned {
			if reconcileRestoreExecute {
				return fmt.Errorf("%w: %s %s", storage.ErrNotTombstoned, plan.EntityType, args[1])
			}
			fmt.Fprintf(out, "not-tombstoned type=%s id=%s path=%s revision=%d\n", plan.EntityType, plan.EntityID, plan.Path, plan.Revision)
			return nil
		}
		if !reconcileRestoreExecute {
			fmt.Fprintf(out, "would-restore type=%s id=%s path=%s revision=%d file-present=%t\n", plan.EntityType, plan.EntityID, plan.Path, plan.Revision, plan.FilePresent)
			return nil
		}
		result, err := store.RestoreTombstoned(cmd.Context(), plan, cliLifecycleActor())
		if err != nil {
			return err
		}
		if plan.EntityType == "task" {
			search.BestEffortIndexTask(store, plan.EntityID)
		} else {
			search.BestEffortIndexDoc(store, plan.DocPath)
		}
		fmt.Fprintf(out, "restored type=%s id=%s path=%s revision=%d hash=%s\n", plan.EntityType, plan.EntityID, plan.Path, result.Revision, result.NewHash)
		return nil
	},
}

func init() {
	reconcileCmd.Flags().BoolVar(&reconcileExecute, "execute", false, "apply revisions and manifest updates (default is preview)")
	reconcileCmd.Flags().BoolVar(&reconcileWait, "wait", false, "wait for the reconciliation job to complete")
	reconcileRestoreCmd.Flags().BoolVar(&reconcileRestoreExecute, "execute", false, "reactivate the entity (default is preview)")
	reconcileCmd.AddCommand(reconcileRestoreCmd)
	rootCmd.AddCommand(reconcileCmd)
}
