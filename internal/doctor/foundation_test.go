package doctor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestFoundationCheckersReportAggregateValidationWithoutWriting(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doctor-test"); err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	if err := store.Tasks.Create(&models.Task{
		ID:       "broken1",
		Status:   "todo",
		Priority: "medium",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	before := snapshotTree(t, store.Root)

	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
	}, FoundationCheckers(store))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	validation := findCheck(t, result, "validation.summary")
	if validation.Status != StatusFail {
		t.Fatalf("validation status = %q, want %q", validation.Status, StatusFail)
	}
	if validation.Evidence["errors"].(int) < 1 {
		t.Fatalf("validation evidence = %#v", validation.Evidence)
	}
	if validation.Remediation == nil || validation.Remediation.Command != "knowns validate" {
		t.Fatalf("validation remediation = %#v", validation.Remediation)
	}
	after := snapshotTree(t, store.Root)
	if fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("foundation checks mutated storage\nbefore=%v\nafter=%v", before, after)
	}
}

func TestFoundationCheckersWithoutProjectReturnValidUnhealthyResult(t *testing.T) {
	result, err := Run(context.Background(), RunOptions{
		Project: InactiveProject(),
	}, FoundationCheckers(nil))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Verdict != VerdictUnhealthy {
		t.Fatalf("Verdict = %q, want %q", result.Verdict, VerdictUnhealthy)
	}
	active := findCheck(t, result, "project.active")
	if active.Status != StatusFail || active.Remediation == nil || active.Remediation.Command != "knowns init" {
		t.Fatalf("active project check = %#v", active)
	}
	if result.ExitCode() != 1 {
		t.Fatalf("ExitCode() = %d, want 1", result.ExitCode())
	}
}

// TestFoundationCheckersReportUnmigratedProject is FR-21/AC-30: a project
// whose committed config.json still carries a schema version behind
// storage.CurrentSchemaVersion() must be reported by doctor, naming `knowns
// migrate` as the remediation, so the command is discoverable from `knowns
// doctor` without reading release notes.
func TestFoundationCheckersReportUnmigratedProject(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doctor-migration-test"); err != nil {
		t.Fatalf("Init() error = %v", err)
	}
	cfg, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	// Simulate a project left behind by an older knowns version: below
	// storage.CurrentSchemaVersion(), matching an on-disk provider: local
	// config that predates knowns migrate (spec ollama-only-embedding D10).
	cfg.SchemaVersion = 0
	if err := store.Config.Save(cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	before := snapshotTree(t, store.Root)

	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
	}, FoundationCheckers(store))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	migration := findCheck(t, result, "project.migration")
	if migration.Status != StatusWarn ||
		migration.Evidence["schemaVersion"] != 0 ||
		migration.Remediation == nil || migration.Remediation.Command != "knowns migrate" {
		t.Fatalf("migration check = %#v", migration)
	}
	after := snapshotTree(t, store.Root)
	if fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("migration check mutated storage\nbefore=%v\nafter=%v", before, after)
	}
}

// TestFoundationCheckersPassWhenProjectSchemaIsCurrent proves the migration
// check does not warn on every project — only one that actually needs
// storage.NeedsMigration (FR-20: migration is idempotent, and a project with
// nothing pending must not be flagged).
func TestFoundationCheckersPassWhenProjectSchemaIsCurrent(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("doctor-migration-current-test"); err != nil {
		t.Fatalf("Init() error = %v", err)
	}

	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
	}, FoundationCheckers(store))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	migration := findCheck(t, result, "project.migration")
	if migration.Status != StatusPass || migration.Remediation != nil {
		t.Fatalf("migration check = %#v", migration)
	}
}

func findCheck(t *testing.T, result Result, id string) CheckResult {
	t.Helper()
	for _, check := range result.Checks {
		if check.ID == id {
			return check
		}
	}
	t.Fatalf("check %q not found in %#v", id, result.Checks)
	return CheckResult{}
}

func snapshotTree(t *testing.T, root string) map[string]string {
	t.Helper()
	snapshot := make(map[string]string)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			snapshot[filepath.ToSlash(rel)+"/"] = "dir"
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		snapshot[filepath.ToSlash(rel)] = fmt.Sprintf("%x", sha256.Sum256(data))
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot %s: %v", root, err)
	}
	return snapshot
}
