package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// PurgeTaskLifecycle is the storage-internal Task hard-delete coordinator.
// Public adapters never construct HardDeleteOptions.Trusted themselves. The
// coordinator first exact-bootstraps the target into the filesystem history
// (without an index callback), then invokes the phased reconciler purge with
// the caller's already-authorized remove handoff.
func PurgeTaskLifecycle(ctx context.Context, root, taskID, canonicalPath, expectedHash, actor, reason string, remove func(string) error) error {
	if strings.TrimSpace(taskID) == "" || strings.TrimSpace(canonicalPath) == "" {
		return fmt.Errorf("task lifecycle purge requires task identity and canonical path")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	absPath := canonicalPath
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(absRoot, canonicalPath)
	}
	absPath, err = filepath.Abs(absPath)
	if err != nil {
		return err
	}
	if !under(absRoot, absPath) || filepath.Ext(absPath) != ".md" {
		return fmt.Errorf("task lifecycle purge canonical path is outside project root")
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil || rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("task lifecycle purge canonical path is outside project root")
	}
	rel = filepath.ToSlash(rel)
	if !strings.HasPrefix(rel, "tasks/") && !strings.HasPrefix(rel, "archive/") {
		return fmt.Errorf("task lifecycle purge canonical path is outside Task roots")
	}

	bootstrap, err := newFilesystemReconciler(absRoot, true)
	if err != nil {
		return err
	}
	// A missing canonical is a valid retry state after reservation/canonical
	// removal. The exact batch is still run so an existing manifest/history is
	// never reconciled opportunistically.
	if _, statErr := os.Lstat(absPath); statErr == nil {
		results, err := bootstrap.ReconcileLifecycleBatch(ctx, LifecycleBatch{
			Source:          "task-hard-delete-bootstrap",
			Limit:           4,
			ExactEntityType: "task",
			ExactEntityID:   taskID,
			ExactPath:       rel,
			Hints:           []ReconcileHint{{Path: absPath, Event: "hard_delete", EntityType: "task", EntityID: taskID}},
		}, true)
		if err != nil {
			return err
		}
		for _, result := range results {
			if result.Diagnostic != "" {
				return errors.New(result.Diagnostic)
			}
		}
	} else if !os.IsNotExist(statErr) {
		return statErr
	}

	var handoff func(ReconcileResult) error
	if remove != nil {
		handoff = func(result ReconcileResult) error {
			if result.Operation != LifecycleOperationHardDelete {
				return nil
			}
			return remove(result.EntityID)
		}
	}
	purge, err := newFilesystemReconciler(absRoot, true, handoff)
	if err != nil {
		return err
	}
	return purge.HardDelete(ctx, "task", taskID, HardDeleteOptions{
		Trusted:      true,
		Confirmed:    true,
		Reason:       reason,
		Actor:        actor,
		Path:         rel,
		ExpectedHash: expectedHash,
	})
}
