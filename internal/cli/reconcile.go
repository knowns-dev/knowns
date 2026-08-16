package cli

import (
	"fmt"
	"time"

	"github.com/howznguyen/knowns/internal/runtimequeue"
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

func init() {
	reconcileCmd.Flags().BoolVar(&reconcileExecute, "execute", false, "apply revisions and manifest updates (default is preview)")
	reconcileCmd.Flags().BoolVar(&reconcileWait, "wait", false, "wait for the reconciliation job to complete")
	rootCmd.AddCommand(reconcileCmd)
}
