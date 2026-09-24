package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ErrNotTombstoned reports a restore requested for an entity whose history
// does not end in a delete tombstone.
var ErrNotTombstoned = errors.New("entity is not tombstoned")

// TombstoneRestorePlan is a read-only preview of reactivating a Task or Doc
// whose history head is a delete tombstone.
type TombstoneRestorePlan struct {
	EntityType  string `json:"entityType"`
	EntityID    string `json:"entityId"`
	DocPath     string `json:"docPath,omitempty"`
	Path        string `json:"path"`
	Tombstoned  bool   `json:"tombstoned"`
	FilePresent bool   `json:"filePresent"`
	Revision    int    `json:"revision"`
	Hash        string `json:"hash"`
}

// PlanTombstoneRestore resolves a Task ID or a Doc path to the entity and the
// canonical path a restore would use, and writes nothing. A Doc whose file is
// gone is found through the history path index.
func (s *Store) PlanTombstoneRestore(entityType, ref string) (TombstoneRestorePlan, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return TombstoneRestorePlan{}, fmt.Errorf("restore: a %s reference is required", entityType)
	}
	plan := TombstoneRestorePlan{EntityType: entityType}
	switch entityType {
	case "task":
		plan.EntityID = ref
	case "doc":
		// Normalise exactly as the history writer does, so the lookup key and
		// the stored key cannot drift apart.
		docPath := normalizeDocPath(filepath.ToSlash(ref))
		plan.DocPath = docPath
		plan.Path = "docs/" + docPath + ".md"
		if doc, err := s.Docs.Get(docPath); err == nil && strings.TrimSpace(doc.ID) != "" {
			plan.EntityID = doc.ID
		} else {
			// The file is gone, so the stable ID comes from the history itself.
			id, ok, findErr := s.Versions.historyStore().FindEntityByPathMetadata(context.Background(), "doc", docPath)
			if findErr != nil {
				return plan, findErr
			}
			if ok {
				plan.EntityID = id
			}
		}
		if plan.EntityID == "" {
			return plan, fmt.Errorf("restore: no history found for doc %q", docPath)
		}
	default:
		return plan, fmt.Errorf("restore: unknown entity type %q: use task or doc", entityType)
	}
	stream, err := NewHistoryStore(s.Root).ReadPreview(entityType, plan.EntityID)
	if err != nil {
		return plan, err
	}
	if len(stream.Records) == 0 {
		return plan, fmt.Errorf("restore: %s %q has no history", entityType, plan.EntityID)
	}
	head := stream.Records[len(stream.Records)-1]
	plan.Revision, plan.Hash = head.Revision, head.NewHash
	plan.Tombstoned = head.Tombstone && head.Operation == LifecycleOperationDelete
	if entityType == "task" && strings.HasPrefix(filepath.ToSlash(head.CurrentPath), "tasks/") {
		plan.Path = filepath.ToSlash(head.CurrentPath)
	}
	if plan.Path != "" {
		if _, statErr := os.Stat(filepath.Join(s.Root, filepath.FromSlash(plan.Path))); statErr == nil {
			plan.FilePresent = true
		}
	}
	return plan, nil
}

// RestoreTombstoned reactivates the entity a plan describes. The plan's head
// hash is the expected base, so a history that moved after the plan was made
// fails with a conflict instead of restoring stale state. It refuses, through
// Restore, when the file on disk holds content the tombstone did not record.
func (s *Store) RestoreTombstoned(ctx context.Context, plan TombstoneRestorePlan, actor string) (ReconcileResult, error) {
	if !plan.Tombstoned {
		return ReconcileResult{}, fmt.Errorf("%w: %s %s", ErrNotTombstoned, plan.EntityType, plan.EntityID)
	}
	r, err := NewFilesystemReconciler(s.Root)
	if err != nil {
		return ReconcileResult{}, err
	}
	return r.Restore(ctx, plan.EntityType, plan.EntityID, RestoreOptions{Path: plan.Path, ExpectedBaseHash: plan.Hash, Actor: actor})
}
