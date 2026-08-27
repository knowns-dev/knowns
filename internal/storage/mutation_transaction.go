package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
)

// DocMutationOptions carries the audit context for an atomic document
// mutation. Rename reference rewrites are part of the same transaction.
type DocMutationOptions struct {
	Actor             string
	Source            string
	Section           string
	RewriteReferences bool
	ExpectedHash      string
}

// DocDeleteOptions carries the optimistic-concurrency base and audit context
// for a durable, restorable document tombstone.
type DocDeleteOptions struct {
	ExpectedHash string
	Actor        string
	Source       string
	BatchID      string
}

type docDeleteTransaction struct {
	SchemaVersion int       `json:"schemaVersion"`
	EntityID      string    `json:"entityId"`
	Path          string    `json:"path"`
	Hash          string    `json:"hash"`
	Actor         string    `json:"actor,omitempty"`
	Source        string    `json:"source,omitempty"`
	BatchID       string    `json:"batchId,omitempty"`
	Timestamp     time.Time `json:"timestamp"`
}

func docDeleteTransactionDir(root string) string {
	return filepath.Join(root, "history", "state", "doc-delete-transactions")
}
func docDeleteTransactionPath(root, id string) string {
	sum := sha256.Sum256([]byte(id))
	return filepath.Join(docDeleteTransactionDir(root), hex.EncodeToString(sum[:])+".json")
}
func writeDocDeleteTransaction(root string, m docDeleteTransaction) error {
	dir := docDeleteTransactionDir(root)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".doc-delete-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, docDeleteTransactionPath(root, m.EntityID)); err != nil {
		return err
	}
	return syncDirectory(dir)
}
func removeDocDeleteTransaction(root, id string) error {
	p := docDeleteTransactionPath(root, id)
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return err
	}
	return syncDirectory(filepath.Dir(p))
}

// DeleteDocWithExpectedHash removes a document only when its fresh canonical
// hash matches the caller's expected base and durable history head.
func (s *Store) DeleteDocWithExpectedHash(ctx context.Context, path string, opts DocDeleteOptions) error {
	if s == nil || s.Docs == nil {
		return fmt.Errorf("document delete: store is unavailable")
	}
	canonicalPath := normalizeDocPath(path)
	if canonicalPath == "" {
		return fmt.Errorf("document delete: path is required")
	}
	pre, err := s.Docs.Get(canonicalPath)
	if err != nil {
		return err
	}
	if strings.TrimSpace(pre.ID) == "" {
		return fmt.Errorf("document delete: stable doc ID is required")
	}
	return s.Versions.historyStore().withEntityLock(ctx, "doc", "__lifecycle__:"+pre.ID, func() error {
		return s.withDocMutationLocks(ctx, []string{canonicalPath}, func() error {
			expected := strings.TrimSpace(opts.ExpectedHash)
			if expected == "" {
				return fmt.Errorf("document delete: expected canonical hash is required")
			}
			current, err := s.Docs.Get(canonicalPath)
			if err != nil {
				return err
			}
			if strings.TrimSpace(current.ID) == "" {
				return fmt.Errorf("document delete: stable doc ID is required")
			}
			if current.ID != pre.ID {
				return &MutationConflictError{EntityType: "doc", EntityID: pre.ID, ExpectedHash: "stable ID " + pre.ID, CurrentHash: "stable ID " + current.ID}
			}
			currentHash := CanonicalDocHash(current)
			if expected != currentHash {
				return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(current.ID, current.Path), ExpectedHash: expected, CurrentHash: currentHash}
			}
			history := s.Versions.historyStore()
			stream, err := history.Read(ctx, "doc", current.ID)
			if err != nil {
				return fmt.Errorf("document delete: read history: %w", err)
			}
			if len(stream.Records) == 0 {
				return fmt.Errorf("document delete: durable history head is required")
			}
			head := stream.Records[len(stream.Records)-1]
			if head.Tombstone || head.Operation == LifecycleOperationDelete {
				return fmt.Errorf("document delete: document is already tombstoned; restore reconciliation is required")
			}
			if head.NewHash != currentHash {
				return &MutationConflictError{EntityType: "doc", EntityID: current.ID, ExpectedHash: head.NewHash, CurrentHash: currentHash}
			}
			canonicalHistoryPath := "docs/" + normalizeDocPath(current.Path) + ".md"
			canonicalDir := filepath.Dir(filepath.Join(s.Root, filepath.FromSlash(canonicalHistoryPath)))
			actor := strings.TrimSpace(opts.Actor)
			if actor == "" {
				actor = "system"
			}
			source := strings.TrimSpace(opts.Source)
			if source == "" {
				source = "delete"
			}
			marker := docDeleteTransaction{SchemaVersion: 1, EntityID: current.ID, Path: canonicalHistoryPath, Hash: currentHash, Actor: actor, Source: source, BatchID: opts.BatchID, Timestamp: time.Now().UTC()}
			if err := writeDocDeleteTransaction(s.Root, marker); err != nil {
				return fmt.Errorf("document delete: persist transaction marker: %w", err)
			}
			if err := s.Docs.Delete(canonicalPath); err != nil {
				_ = removeDocDeleteTransaction(s.Root, current.ID)
				return err
			}
			if err := syncDirectory(canonicalDir); err != nil {
				return err
			}
			record := models.HistoryRecord{EntityType: "doc", EntityID: current.ID, Operation: "delete", Tombstone: true, BaseHash: currentHash, NewHash: currentHash, Checkpoint: true, CheckpointPayload: DocToSnapshot(current), CurrentPath: canonicalHistoryPath, PreviousPath: canonicalHistoryPath, Actor: actor, Source: source, BatchID: opts.BatchID, Timestamp: time.Now().UTC()}
			if err := history.Append(ctx, record); err != nil {
				rollbackErr := s.Docs.writeExact(current)
				if rollbackErr == nil {
					rollbackErr = syncDirectory(canonicalDir)
				}
				if rollbackErr == nil {
					rollbackErr = removeDocDeleteTransaction(s.Root, current.ID)
				}
				return combineMutationRollbackError(err, rollbackErr)
			}
			return removeDocDeleteTransaction(s.Root, current.ID)
		})
	})
}

// CreateTaskWithHistory creates a Task and its initial history record under
// one lifecycle lock. A failed history append removes the newly-created Task.
// An empty task.ID is allocated from the project default ID prefix.
func (s *Store) CreateTaskWithHistory(ctx context.Context, task *models.Task, version models.TaskVersion) error {
	return s.CreateTaskWithHistoryPrefixed(ctx, task, version, "")
}

// CreateTaskWithHistoryPrefixed is CreateTaskWithHistory with an explicit
// one-off ID prefix. A non-empty prefix overrides the project default for this
// Task only and never mutates project settings. Callers that already assigned
// task.ID keep it, which preserves import and compatibility paths.
func (s *Store) CreateTaskWithHistoryPrefixed(ctx context.Context, task *models.Task, version models.TaskVersion, prefix string) error {
	if task == nil {
		return fmt.Errorf("create task with history: task is required")
	}
	// Reject a malformed prefix before taking the lifecycle lock. The message is
	// user-facing and already self-describing, so it is returned unwrapped.
	explicitPrefix, err := models.NormalizeTaskIDPrefix(prefix)
	if err != nil {
		return err
	}
	return s.WithTaskLifecycleTransaction(ctx, func(tx *TaskLifecycleTransaction) error {
		allocated := false
		if task.ID == "" {
			effectivePrefix := explicitPrefix
			if effectivePrefix == "" {
				project, err := s.Config.Load()
				if err != nil {
					return fmt.Errorf("resolve default task ID prefix: %w", err)
				}
				effectivePrefix = project.Settings.DefaultTaskIDPrefix
			}
			id, err := s.Tasks.allocateTaskIDUnlocked(effectivePrefix)
			if err != nil {
				return err
			}
			task.ID = id
			allocated = true
		}
		if err := tx.CreateTask(task); err != nil {
			if allocated {
				task.ID = ""
			}
			return err
		}
		// A caller-supplied snapshot is captured before the ID exists, so it must
		// be recomputed whenever this call allocated the ID.
		if allocated || len(version.Snapshot) == 0 {
			version.Snapshot = TaskToSnapshot(task)
		}
		if len(version.Changes) == 0 {
			version.Changes = s.Versions.TrackChanges(nil, task)
		}
		if err := s.Versions.saveVersionUnlocked(task.ID, version); err != nil {
			if rollbackErr := tx.DeleteTask(task.ID); rollbackErr != nil {
				return fmt.Errorf("%w; rollback Task create: %w", err, rollbackErr)
			}
			return err
		}
		return nil
	})
}

// MutateDocWithHistory atomically creates, updates, or renames a canonical
// document and appends its history. oldDoc must be the caller's observed
// state for updates and renames; it is re-read under the path lock.
func (s *Store) MutateDocWithHistory(ctx context.Context, oldDoc, newDoc *models.Doc, opts DocMutationOptions) error {
	if s == nil || s.Docs == nil || s.Versions == nil {
		return fmt.Errorf("document mutation: store is unavailable")
	}
	if newDoc == nil || strings.TrimSpace(newDoc.Path) == "" {
		return fmt.Errorf("document mutation: new document path is required")
	}
	newPath := normalizeDocPath(newDoc.Path)
	oldPath := ""
	if oldDoc != nil {
		oldPath = normalizeDocPath(oldDoc.Path)
		if oldPath == "" {
			return fmt.Errorf("document mutation: old document path is required")
		}
	}
	newDoc.Path = newPath
	paths := []string{newPath}
	if oldPath != "" {
		paths = append(paths, oldPath)
	}
	if oldDoc != nil && oldPath != newPath {
		return s.mutateRenamedDocWithReferences(ctx, oldDoc, newDoc, opts)
	}
	return s.withDocMutationLocks(ctx, paths, func() error {
		if oldDoc == nil {
			if _, err := s.Docs.Get(newPath); err == nil {
				return fmt.Errorf("document %q already exists", newPath)
			}
			if strings.TrimSpace(newDoc.ID) == "" {
				newDoc.ID = newDocID()
			}
			if err := s.Docs.ValidateStableID(newDoc.ID, newPath); err != nil {
				return err
			}
			if err := s.Docs.Create(newDoc); err != nil {
				return err
			}
			if err := s.Versions.SaveDocRevisionWithOptions(nil, newDoc, DocRevisionOptions{Actor: opts.Actor, Source: opts.Source}); err != nil {
				if rollbackErr := s.Docs.Delete(newPath); rollbackErr != nil {
					return fmt.Errorf("%w; rollback Doc create: %v", err, rollbackErr)
				}
				return err
			}
			newDoc.CanonicalHash = CanonicalDocHash(newDoc)
			return nil
		}

		current, err := s.Docs.Get(oldPath)
		if err != nil {
			return fmt.Errorf("%w: document changed or was deleted", ErrHistoryConflict)
		}
		if err := s.Docs.ValidateStableID(firstNonEmpty(current.ID, newDoc.ID), oldPath); err != nil {
			return err
		}
		expected := strings.TrimSpace(opts.ExpectedHash)
		if expected == "" {
			expected = hashDoc(oldDoc)
		}
		currentHash := hashDoc(current)
		if expected != currentHash {
			return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(current.ID, newDoc.ID, oldPath), ExpectedHash: expected, CurrentHash: currentHash}
		}
		if newDoc.ID == "" {
			newDoc.ID = current.ID
		}
		if current.ID != "" && newDoc.ID != current.ID {
			return &DocIdentityConflictError{EntityID: current.ID, RequestedID: newDoc.ID}
		}
		if newDoc.ID == "" {
			if history, historyErr := s.Versions.docHistoryForWrite(oldPath, ""); historyErr != nil {
				return historyErr
			} else if history != nil {
				newDoc.ID = history.DocID
			}
		}
		if newDoc.ID == "" {
			newDoc.ID = newDocID()
		}
		if newDoc.ID != current.ID {
			if err := s.Docs.ValidateStableID(newDoc.ID, newPath); err != nil {
				return err
			}
		}
		if oldPath != newPath {
			if _, err := s.Docs.Get(newPath); err == nil {
				return fmt.Errorf("%w: document target already exists", ErrHistoryConflict)
			}
		}

		oldCanonical := *current
		candidate := *newDoc
		if err := s.Docs.Update(&candidate); err != nil {
			return err
		}

		historyOpts := DocRevisionOptions{Actor: opts.Actor, Source: opts.Source, Section: opts.Section}
		if err := s.Versions.SaveDocRevisionWithOptions(&oldCanonical, &candidate, historyOpts); err != nil {
			var rollbackErr error
			rollbackErr = s.Docs.writeExact(&oldCanonical)
			return combineMutationRollbackError(err, rollbackErr)
		}
		newDoc.CanonicalHash = CanonicalDocHash(&candidate)
		return nil
	})
}

// mutateRenamedDocWithReferences composes the rename, reference rewrites, and
// every affected Task/Doc history append under one deterministic lock order:
// global rename lock -> sorted Doc locks -> Task lifecycle lock -> sorted
// Memory locks. Public MemoryStore mutations acquire only their Memory lock,
// so there is no inverse path that can deadlock this composition.
// The preflight snapshot is only an observation: every affected canonical
// entity is re-read after all locks are held before any write is performed.
func (s *Store) mutateRenamedDocWithReferences(ctx context.Context, oldDoc, newDoc *models.Doc, opts DocMutationOptions) error {
	state, err := s.captureDocReferenceState()
	if err != nil {
		return fmt.Errorf("capture document references: %w", err)
	}
	type docRewrite struct {
		before  *models.Doc
		after   *models.Doc
		updated bool
		history bool
	}
	type taskRewrite struct {
		before  *models.Task
		after   *models.Task
		eventID string
		updated bool
		history bool
	}
	type memoryRewrite struct {
		before        *models.MemoryEntry
		after         *models.MemoryEntry
		committedHash string
		updated       bool
	}
	var docPlan []docRewrite
	var taskPlan []taskRewrite
	var memoryPlan []*models.MemoryEntry
	paths := []string{oldDoc.Path, newDoc.Path}
	for _, original := range state.docs {
		if original == nil || original.Path == oldDoc.Path || original.Path == newDoc.Path {
			continue
		}
		after := cloneDocExact(original)
		after.Content = references.RewriteDocPath(after.Content, oldDoc.Path, newDoc.Path)
		if after.Content == original.Content {
			continue
		}
		after.UpdatedAt = time.Now().UTC()
		docPlan = append(docPlan, docRewrite{before: original, after: &after})
		paths = append(paths, original.Path)
	}
	for _, original := range state.tasks {
		if original == nil {
			continue
		}
		after := cloneTask(original)
		changed := false
		if after.Spec == oldDoc.Path {
			after.Spec = newDoc.Path
			changed = true
		}
		for field, value := range map[string]string{
			"description": after.Description,
			"plan":        after.ImplementationPlan,
			"notes":       after.ImplementationNotes,
		} {
			rewritten := references.RewriteDocPath(value, oldDoc.Path, newDoc.Path)
			if rewritten == value {
				continue
			}
			changed = true
			switch field {
			case "description":
				after.Description = rewritten
			case "plan":
				after.ImplementationPlan = rewritten
			case "notes":
				after.ImplementationNotes = rewritten
			}
		}
		if !changed {
			continue
		}
		after.UpdatedAt = time.Now().UTC()
		taskPlan = append(taskPlan, taskRewrite{before: original, after: &after, eventID: fmt.Sprintf("doc-rename-%d-%s", time.Now().UnixNano(), original.ID)})
	}
	for _, original := range state.memories {
		if original == nil {
			continue
		}
		after := cloneMemory(original)
		after.Content = references.RewriteDocPath(after.Content, oldDoc.Path, newDoc.Path)
		if after.Content == original.Content {
			continue
		}
		after.UpdatedAt = time.Now().UTC()
		memoryPlan = append(memoryPlan, &after)
	}
	sort.Slice(docPlan, func(i, j int) bool { return docPlan[i].before.Path < docPlan[j].before.Path })
	sort.Slice(taskPlan, func(i, j int) bool { return taskPlan[i].before.ID < taskPlan[j].before.ID })
	sort.Slice(memoryPlan, func(i, j int) bool {
		return memoryPlan[i].ID+"\x00"+memoryPlan[i].Layer < memoryPlan[j].ID+"\x00"+memoryPlan[j].Layer
	})
	memoryIDs := make([]string, 0, len(memoryPlan))
	for _, memory := range memoryPlan {
		memoryIDs = append(memoryIDs, memory.ID)
	}
	if s.renameReferencePreflight != nil {
		s.renameReferencePreflight()
	}

	return s.Versions.historyStore().withEntityLock(ctx, "doc", "rename-references", func() error {
		return s.withDocMutationLocks(ctx, paths, func() error {
			return s.WithTaskLifecycleTransaction(ctx, func(tx *TaskLifecycleTransaction) error {
				current, err := s.Docs.Get(oldDoc.Path)
				if err != nil {
					return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(oldDoc.ID, oldDoc.Path), ExpectedHash: hashDoc(oldDoc), CurrentHash: ""}
				}
				expected := strings.TrimSpace(opts.ExpectedHash)
				if expected == "" {
					expected = hashDoc(oldDoc)
				}
				if currentHash := CanonicalDocHash(current); currentHash != expected {
					return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(current.ID, oldDoc.ID, oldDoc.Path), ExpectedHash: expected, CurrentHash: currentHash}
				}
				if err := s.Docs.ValidateStableID(firstNonEmpty(current.ID, newDoc.ID), oldDoc.Path); err != nil {
					return err
				}
				candidate := *newDoc
				if candidate.ID == "" {
					candidate.ID = current.ID
				}
				if current.ID != "" && candidate.ID != current.ID {
					return &DocIdentityConflictError{EntityID: current.ID, RequestedID: candidate.ID}
				}
				if candidate.ID == "" {
					candidate.ID = newDocID()
				}
				if _, err := s.Docs.Get(candidate.Path); err == nil {
					return fmt.Errorf("%w: document target already exists", ErrHistoryConflict)
				}

				for _, rewrite := range docPlan {
					fresh, getErr := s.Docs.Get(rewrite.before.Path)
					if getErr != nil {
						return getErr
					}
					if got, want := CanonicalDocHash(fresh), CanonicalDocHash(rewrite.before); got != want {
						return &MutationConflictError{EntityType: "doc", EntityID: firstNonEmpty(fresh.ID, fresh.Path), ExpectedHash: want, CurrentHash: got}
					}
				}
				for _, rewrite := range taskPlan {
					fresh, getErr := tx.GetTask(rewrite.before.ID)
					if getErr != nil {
						return getErr
					}
					if got, want := CanonicalTaskHash(fresh), CanonicalTaskHash(rewrite.before); got != want {
						return &MutationConflictError{EntityType: "task", EntityID: fresh.ID, ExpectedHash: want, CurrentHash: got}
					}
				}

				committedDocs := make([]docRewrite, 0, len(docPlan))
				committedTasks := make([]taskRewrite, 0, len(taskPlan))
				committedMemories := make([]*memoryRewrite, 0, len(memoryPlan))
				primaryHistory := false
				rollback := func(cause error) error {
					var rollbackErrors []error
					for i := len(committedMemories) - 1; i >= 0; i-- {
						currentMemory, getErr := s.Memory.GetInLayer(committedMemories[i].before.ID, committedMemories[i].before.Layer)
						if getErr == nil {
							entry := committedMemories[i]
							if CanonicalMemoryHash(currentMemory) != entry.committedHash {
								rollbackErrors = append(rollbackErrors, fmt.Errorf("memory %q changed after rename; rollback skipped", entry.before.ID))
								continue
							}
							if entry.before != nil {
								copy := cloneMemory(entry.before)
								if restoreErr := s.Memory.writeExisting(&copy, currentMemory, false); restoreErr != nil {
									rollbackErrors = append(rollbackErrors, restoreErr)
								}
							}
						}
					}
					for i := len(committedTasks) - 1; i >= 0; i-- {
						entry := committedTasks[i]
						if entry.history {
							if rollbackErr := tx.RollbackTaskLifecycleVersion(entry.before.ID, entry.eventID); rollbackErr != nil {
								rollbackErrors = append(rollbackErrors, rollbackErr)
							}
						}
						if entry.updated {
							if rollbackErr := tx.UpdateTask(entry.before); rollbackErr != nil {
								rollbackErrors = append(rollbackErrors, rollbackErr)
							}
						}
					}
					for i := len(committedDocs) - 1; i >= 0; i-- {
						entry := committedDocs[i]
						if entry.history {
							if rollbackErr := s.rollbackDocHistory(entry.after); rollbackErr != nil {
								rollbackErrors = append(rollbackErrors, rollbackErr)
							}
						}
						if entry.updated {
							var rollbackErr error
							if raw := state.docRaw[entry.before.Path]; raw != nil {
								rollbackErr = s.Docs.writeRaw(entry.before.Path, raw)
							} else {
								rollbackErr = s.Docs.writeExact(entry.before)
							}
							if rollbackErr != nil {
								rollbackErrors = append(rollbackErrors, rollbackErr)
							}
						}
					}
					if primaryHistory {
						if rollbackErr := s.rollbackDocHistory(&candidate); rollbackErr != nil {
							rollbackErrors = append(rollbackErrors, rollbackErr)
						}
					}
					var rollbackErr error
					if raw := state.docRaw[current.Path]; raw != nil {
						rollbackErr = s.Docs.renameRaw(candidate.Path, current.Path, raw)
					} else {
						rollbackErr = s.Docs.renameExact(candidate.Path, current)
					}
					if rollbackErr != nil {
						rollbackErrors = append(rollbackErrors, rollbackErr)
					}
					return combineMutationRollbackError(cause, errors.Join(rollbackErrors...))
				}

				if err := s.Docs.Rename(current.Path, &candidate); err != nil {
					return err
				}
				for _, rewrite := range docPlan {
					if err := s.Docs.Update(rewrite.after); err != nil {
						return rollback(err)
					}
					rewrite.updated = true
					committedDocs = append(committedDocs, rewrite)
					if err := s.Versions.SaveDocRevisionWithOptions(rewrite.before, rewrite.after, DocRevisionOptions{Actor: opts.Actor, Source: opts.Source}); err != nil {
						return rollback(err)
					}
					rewrite.history = true
					committedDocs[len(committedDocs)-1] = rewrite
				}
				for _, rewrite := range taskPlan {
					committedTasks = append(committedTasks, rewrite)
					if err := tx.UpdateTask(rewrite.after); err != nil {
						return rollback(err)
					}
					rewrite.updated = true
					if err := tx.SaveTaskVersion(rewrite.before, rewrite.after, opts.Actor, time.Now().UTC(), rewrite.eventID); err != nil {
						return rollback(err)
					}
					rewrite.history = true
					committedTasks[len(committedTasks)-1] = rewrite
				}
				return s.Memory.withMemoryLocks(ctx, memoryIDs, func() error {
					for _, original := range memoryPlan {
						currentMemory, getErr := s.Memory.GetInLayer(original.ID, original.Layer)
						if getErr != nil {
							return rollback(getErr)
						}
						// Re-read under the per-memory lock and apply only the
						// reference rewrite. Unrelated concurrent edits survive.
						rewrite := cloneMemory(currentMemory)
						rewrite.Content = references.RewriteDocPath(currentMemory.Content, oldDoc.Path, newDoc.Path)
						if rewrite.Content == currentMemory.Content {
							continue
						}
						rewrite.UpdatedAt = time.Now().UTC()
						committed := &memoryRewrite{before: cloneMemoryPtr(currentMemory), after: cloneMemoryPtr(&rewrite)}
						committedMemories = append(committedMemories, committed)
						if err := s.Memory.writeExisting(&rewrite, currentMemory, false); err != nil {
							return rollback(err)
						}
						committed.updated = true
						committed.committedHash = CanonicalMemoryHash(&rewrite)
					}
					if err := s.Versions.SaveDocRevisionWithOptions(current, &candidate, DocRevisionOptions{Actor: opts.Actor, Source: opts.Source, Section: opts.Section}); err != nil {
						return rollback(err)
					}
					primaryHistory = true
					newDoc.CanonicalHash = CanonicalDocHash(&candidate)
					return nil
				})
			})
		})
	})
}

func (s *Store) rollbackDocHistory(doc *models.Doc) error {
	if doc == nil || strings.TrimSpace(doc.ID) == "" || !s.Versions.hasJSONLHistory("doc", doc.ID) {
		return nil
	}
	return s.Versions.historyStore().RemoveLast(context.Background(), "doc", doc.ID)
}

func combineMutationRollbackError(primary, rollback error) error {
	if rollback == nil {
		return primary
	}
	return fmt.Errorf("%w; rollback failed: %w", primary, rollback)
}

type docReferenceState struct {
	docs     map[string]*models.Doc
	docRaw   map[string][]byte
	tasks    map[string]*models.Task
	memories map[string]*models.MemoryEntry
}

func (s *Store) captureDocReferenceState() (*docReferenceState, error) {
	docs, err := s.Docs.List()
	if err != nil {
		return nil, err
	}
	tasks, err := s.Tasks.ListAll()
	if err != nil {
		return nil, err
	}
	memories, err := s.Memory.List("")
	if err != nil {
		return nil, err
	}
	state := &docReferenceState{
		docs:     make(map[string]*models.Doc, len(docs)),
		docRaw:   make(map[string][]byte, len(docs)),
		tasks:    make(map[string]*models.Task, len(tasks)),
		memories: make(map[string]*models.MemoryEntry, len(memories)),
	}
	for _, doc := range docs {
		if doc != nil && !doc.IsImported {
			fullDoc, err := s.Docs.Get(doc.Path)
			if err != nil {
				return nil, err
			}
			copy := cloneDocExact(fullDoc)
			state.docs[copy.Path] = &copy
			if _, absPath, pathErr := resolveDocPath(s.Docs.docsDir(), copy.Path); pathErr == nil {
				if raw, readErr := os.ReadFile(absPath); readErr == nil {
					state.docRaw[copy.Path] = append([]byte(nil), raw...)
				}
			}
		}
	}
	for _, task := range tasks {
		if task != nil {
			copy := cloneTask(task)
			state.tasks[copy.ID] = &copy
		}
	}
	for _, memory := range memories {
		if memory != nil {
			copy := cloneMemory(memory)
			state.memories[copy.ID+"\x00"+copy.Layer] = &copy
		}
	}
	return state, nil
}

func (s *Store) rollbackRenamedDoc(oldPath, newPath string, oldDoc *models.Doc, state *docReferenceState) error {
	var rollbackErrors []error
	if state != nil {
		if err := s.restoreDocReferences(state, oldPath, newPath); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		}
	}
	restored := *oldDoc
	var err error
	if state != nil && state.docRaw[oldPath] != nil {
		err = s.Docs.renameRaw(newPath, oldPath, state.docRaw[oldPath])
	} else {
		err = s.Docs.renameExact(newPath, &restored)
	}
	if err != nil {
		rollbackErrors = append(rollbackErrors, err)
	}
	return errors.Join(rollbackErrors...)
}

// restoreDocReferences restores entities changed by RewriteDocReferences. It
// deliberately does not reverse substitutions, since that cannot distinguish
// references that already contained the destination path.
func (s *Store) restoreDocReferences(state *docReferenceState, oldPath, newPath string) error {
	var rollbackErrors []error
	currentDocs, err := s.Docs.List()
	if err != nil {
		rollbackErrors = append(rollbackErrors, fmt.Errorf("list docs: %w", err))
	} else {
		for _, current := range currentDocs {
			if current == nil || current.IsImported || current.Path == oldPath || current.Path == newPath {
				continue
			}
			fullCurrent, getErr := s.Docs.Get(current.Path)
			if getErr != nil {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("get doc %q: %w", current.Path, getErr))
				continue
			}
			current = fullCurrent
			original := state.docs[current.Path]
			if original == nil {
				continue
			}
			restore, divergent := docReferenceRewriteState(current, original, oldPath, newPath)
			if divergent {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("doc %q changed during rename rollback", current.Path))
				continue
			}
			if !restore {
				continue
			}
			copy := cloneDocExact(original)
			var restoreErr error
			if raw := state.docRaw[current.Path]; raw != nil {
				restoreErr = s.Docs.writeRaw(current.Path, raw)
			} else {
				restoreErr = s.Docs.writeExact(&copy)
			}
			if restoreErr != nil {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("restore doc %q: %w", current.Path, restoreErr))
			}
		}
	}

	if err := s.restoreTaskReferences(state.tasks, oldPath, newPath); err != nil {
		rollbackErrors = append(rollbackErrors, err)
	}
	currentMemories, err := s.Memory.List("")
	if err != nil {
		rollbackErrors = append(rollbackErrors, fmt.Errorf("list memories: %w", err))
	} else {
		for _, current := range currentMemories {
			if current == nil {
				continue
			}
			original := state.memories[current.ID+"\x00"+current.Layer]
			if original == nil {
				continue
			}
			restore, divergent := memoryReferenceRewriteState(current, original, oldPath, newPath)
			if divergent {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("memory %q changed during rename rollback", current.ID))
				continue
			}
			if !restore {
				continue
			}
			copy := cloneMemory(original)
			if err := s.Memory.withMemoryLock(context.Background(), current.ID, func() error {
				return s.Memory.writeExisting(&copy, current, false)
			}); err != nil {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("restore memory %q: %w", current.ID, err))
			}
		}
	}
	return errors.Join(rollbackErrors...)
}

func (s *Store) restoreTaskReferences(originals map[string]*models.Task, oldPath, newPath string) error {
	return s.WithTaskLifecycleTransaction(context.Background(), func(tx *TaskLifecycleTransaction) error {
		current, err := tx.ListActiveTasks()
		if err != nil {
			return fmt.Errorf("list tasks: %w", err)
		}
		var rollbackErrors []error
		for _, task := range current {
			if task == nil {
				continue
			}
			original := originals[task.ID]
			if original == nil {
				continue
			}
			restore, divergent := taskReferenceRewriteState(task, original, oldPath, newPath)
			if divergent {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("task %q changed during rename rollback", task.ID))
				continue
			}
			if !restore {
				continue
			}
			copy := cloneTask(original)
			if err := tx.UpdateTask(&copy); err != nil {
				rollbackErrors = append(rollbackErrors, fmt.Errorf("restore task %q: %w", task.ID, err))
			}
		}
		return errors.Join(rollbackErrors...)
	})
}

func cloneTask(task *models.Task) models.Task {
	copy := *task
	if task.Labels != nil {
		copy.Labels = append([]string{}, task.Labels...)
	}
	if task.Fulfills != nil {
		copy.Fulfills = append([]string{}, task.Fulfills...)
	}
	if task.Subtasks != nil {
		copy.Subtasks = append([]string{}, task.Subtasks...)
	}
	if task.AcceptanceCriteria != nil {
		copy.AcceptanceCriteria = append([]models.AcceptanceCriterion{}, task.AcceptanceCriteria...)
	}
	if task.TimeEntries != nil {
		copy.TimeEntries = append([]models.TimeEntry{}, task.TimeEntries...)
	}
	if task.ActiveTimer != nil {
		timer := *task.ActiveTimer
		copy.ActiveTimer = &timer
	}
	return copy
}

func cloneMemory(memory *models.MemoryEntry) models.MemoryEntry {
	copy := *memory
	if memory.Sources != nil {
		copy.Sources = append([]string{}, memory.Sources...)
	}
	if memory.Tags != nil {
		copy.Tags = append([]string{}, memory.Tags...)
	}
	if memory.LifecycleMetadataMissing != nil {
		copy.LifecycleMetadataMissing = append([]string{}, memory.LifecycleMetadataMissing...)
	}
	if memory.Metadata != nil {
		copy.Metadata = make(map[string]string, len(memory.Metadata))
		for key, value := range memory.Metadata {
			copy.Metadata[key] = value
		}
	}
	return copy
}

func cloneMemoryPtr(memory *models.MemoryEntry) *models.MemoryEntry {
	if memory == nil {
		return nil
	}
	copy := cloneMemory(memory)
	return &copy
}

func docReferenceRewriteState(current, original *models.Doc, oldPath, newPath string) (restore, divergent bool) {
	if reflect.DeepEqual(current, original) {
		return false, false
	}
	expected := cloneDocExact(original)
	expected.Content = references.RewriteDocPath(expected.Content, oldPath, newPath)
	if expected.Content == original.Content {
		return false, true
	}
	currentCopy := cloneDocExact(current)
	currentCopy.UpdatedAt = time.Time{}
	expected.UpdatedAt = time.Time{}
	return reflect.DeepEqual(&currentCopy, &expected), !reflect.DeepEqual(&currentCopy, &expected)
}

func cloneDocExact(doc *models.Doc) models.Doc {
	copy := *doc
	copy.CanonicalHash = ""
	if doc.Tags != nil {
		copy.Tags = append([]string{}, doc.Tags...)
	}
	return copy
}

func taskReferenceRewriteState(current, original *models.Task, oldPath, newPath string) (restore, divergent bool) {
	if reflect.DeepEqual(current, original) {
		return false, false
	}
	expected := cloneTask(original)
	if expected.Spec == oldPath {
		expected.Spec = newPath
	}
	expected.Description = references.RewriteDocPath(expected.Description, oldPath, newPath)
	expected.ImplementationPlan = references.RewriteDocPath(expected.ImplementationPlan, oldPath, newPath)
	expected.ImplementationNotes = references.RewriteDocPath(expected.ImplementationNotes, oldPath, newPath)
	if expected.Spec == original.Spec && expected.Description == original.Description && expected.ImplementationPlan == original.ImplementationPlan && expected.ImplementationNotes == original.ImplementationNotes {
		return false, true
	}
	currentCopy := cloneTask(current)
	currentCopy.CanonicalHash = ""
	currentCopy.UpdatedAt = time.Time{}
	expected.UpdatedAt = time.Time{}
	expected.CanonicalHash = ""
	return reflect.DeepEqual(&currentCopy, &expected), !reflect.DeepEqual(&currentCopy, &expected)
}

func memoryReferenceRewriteState(current, original *models.MemoryEntry, oldPath, newPath string) (restore, divergent bool) {
	if reflect.DeepEqual(current, original) {
		return false, false
	}
	expected := cloneMemory(original)
	expected.Content = references.RewriteDocPath(expected.Content, oldPath, newPath)
	if expected.Content == original.Content {
		return false, true
	}
	currentCopy := cloneMemory(current)
	currentCopy.UpdatedAt = time.Time{}
	expected.UpdatedAt = time.Time{}
	return reflect.DeepEqual(&currentCopy, &expected), !reflect.DeepEqual(&currentCopy, &expected)
}

func (s *Store) withDocMutationLocks(ctx context.Context, paths []string, fn func() error) error {
	seen := map[string]bool{}
	ordered := make([]string, 0, len(paths))
	for _, path := range paths {
		path = normalizeDocPath(path)
		if path != "" && !seen[path] {
			seen[path] = true
			ordered = append(ordered, path)
		}
	}
	sort.Strings(ordered)
	var acquire func(int) error
	acquire = func(index int) error {
		if index == len(ordered) {
			return fn()
		}
		return s.Versions.historyStore().withEntityLock(ctx, "doc", "mutation:"+ordered[index], func() error {
			return acquire(index + 1)
		})
	}
	return acquire(0)
}
