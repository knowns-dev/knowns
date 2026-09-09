package doctor

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/storage"
)

// qdrantEnabledSnapshot is the minimum resolution that gets a check past
// qdrantSkip, so these tests exercise the dead-letter logic rather than the
// shared backend gate.
func qdrantEnabledSnapshot() qdrantDiagnosticSnapshot {
	return qdrantDiagnosticSnapshot{Resolution: models.SemanticVectorStoreResolution{
		Enabled: true,
		Backend: models.SemanticVectorBackendQdrant,
		Mode:    models.SemanticVectorStoreModeExternal,
	}}
}

// seedDoctorDeadLetter drives one Qdrant reconcile job to dead-lettered through
// the exported scheduler path, so the fixture is produced the same way a real
// outage produces it rather than by hand-writing a queue file.
func seedDoctorDeadLetter(t *testing.T, root, entityID string) runtimequeue.Job {
	t.Helper()
	job, err := runtimequeue.EnqueueQdrantIntent(root, runtimequeue.QdrantIntent{
		EntityType: "task",
		EntityID:   entityID,
		Revision:   1,
		Operation:  "update",
		Generation: 1,
	})
	if err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}
	for i := 0; i < 20; i++ {
		started, err := runtimequeue.MarkJobStarted(root, job.ID)
		if err != nil {
			t.Fatalf("MarkJobStarted: %v", err)
		}
		if err := runtimequeue.CompleteJob(root, started, errors.New("qdrant unreachable")); err != nil {
			t.Fatalf("CompleteJob: %v", err)
		}
		letters, err := runtimequeue.ListDeadLetters(root)
		if err != nil {
			t.Fatalf("ListDeadLetters: %v", err)
		}
		for _, letter := range letters {
			if letter.ID == job.ID {
				return letter
			}
		}
	}
	t.Fatalf("job %s never dead-lettered", job.ID)
	return runtimequeue.Job{}
}

func runDeadLetterCheck(t *testing.T, store *storage.Store) CheckResult {
	t.Helper()
	deps := localDependencies{qdrant: func(context.Context, *storage.Store) (qdrantDiagnosticSnapshot, error) {
		return qdrantEnabledSnapshot(), nil
	}}
	result, err := Run(context.Background(), RunOptions{
		Project: ProjectFromStore(store),
		Scopes:  []Scope{ScopeSearch},
	}, localCheckersWithDependencies(store, deps))
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	return findCheck(t, result, "search.qdrant-dead-letters")
}

// TestQdrantDeadLetterCheckPassesOnAnEmptyQueue pins the quiet case. A project
// with nothing stranded must not carry a standing warning, or the check becomes
// noise an operator learns to ignore.
func TestQdrantDeadLetterCheckPassesOnAnEmptyQueue(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	store := newDoctorStore(t)

	check := runDeadLetterCheck(t, store)
	if check.Status != StatusPass {
		t.Fatalf("check = %#v, want pass", check)
	}
	if check.Evidence["deadLetters"] != 0 {
		t.Fatalf("evidence = %#v, want deadLetters 0", check.Evidence)
	}
	if check.Remediation != nil {
		t.Fatalf("a passing check must offer no remediation, got %#v", check.Remediation)
	}
}

// TestQdrantDeadLetterCheckReportsStrandedJobsAndNamesTheReleaseCommand is the
// gap this check exists to close: doctor used to report the resulting staleness
// while never naming the queue as its cause, so the remediation it advertised
// (reindex) could not clear it. The warning must name the release command.
func TestQdrantDeadLetterCheckReportsStrandedJobsAndNamesTheReleaseCommand(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	store := newDoctorStore(t)
	seedDoctorDeadLetter(t, store.Root, "KND-STUCK1")
	seedDoctorDeadLetter(t, store.Root, "KND-STUCK2")

	check := runDeadLetterCheck(t, store)
	if check.Status != StatusWarn {
		t.Fatalf("check = %#v, want warn", check)
	}
	if check.Evidence["deadLetters"] != 2 {
		t.Fatalf("evidence = %#v, want deadLetters 2", check.Evidence)
	}
	entities, ok := check.Evidence["entities"].([]string)
	if !ok || len(entities) != 2 {
		t.Fatalf("entities evidence = %#v, want two entity references", check.Evidence["entities"])
	}
	if check.Remediation == nil || check.Remediation.Command != "knowns runtime retry --all" {
		t.Fatalf("remediation = %#v, want the release command", check.Remediation)
	}
}

// TestQdrantDeadLetterRemediationActuallyClearsTheCheck is the property the
// whole doctor surface keeps getting wrong: a warning whose advertised command
// cannot clear it. Releasing the jobs must make a second run pass.
func TestQdrantDeadLetterRemediationActuallyClearsTheCheck(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	store := newDoctorStore(t)
	seedDoctorDeadLetter(t, store.Root, "KND-CLEAR1")

	if check := runDeadLetterCheck(t, store); check.Status != StatusWarn {
		t.Fatalf("check before release = %#v, want warn", check)
	}
	if _, err := runtimequeue.RetryDeadLetters(store.Root); err != nil {
		t.Fatalf("RetryDeadLetters: %v", err)
	}
	if check := runDeadLetterCheck(t, store); check.Status != StatusPass {
		t.Fatalf("check after release = %#v, want pass", check)
	}
}

// TestQdrantDeadLetterEvidenceIsBoundedAndSorted pins the evidence shape. An
// outage strands every pending job at once, so the count must stay honest while
// the sample stays readable and deterministic across runs.
func TestQdrantDeadLetterEvidenceIsBoundedAndSorted(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	store := newDoctorStore(t)
	total := deadLetterSampleLimit + 3
	for i := 0; i < total; i++ {
		seedDoctorDeadLetter(t, store.Root, fmt.Sprintf("KND-BULK%02d", i))
	}

	check := runDeadLetterCheck(t, store)
	if check.Evidence["deadLetters"] != total {
		t.Fatalf("evidence = %#v, want the full count %d", check.Evidence, total)
	}
	if check.Evidence["entitiesTruncated"] != true {
		t.Fatalf("evidence = %#v, want entitiesTruncated true", check.Evidence)
	}
	entities, _ := check.Evidence["entities"].([]string)
	if len(entities) != deadLetterSampleLimit {
		t.Fatalf("entities = %d, want capped at %d", len(entities), deadLetterSampleLimit)
	}
	for i := 1; i < len(entities); i++ {
		if entities[i-1] > entities[i] {
			t.Fatalf("entities are not sorted, so repeated runs report different evidence: %v", entities)
		}
	}
}

// TestQdrantDeadLetterCheckSkipsForANonQdrantBackend keeps the check off
// projects it cannot apply to, using the same gate as its sibling checks.
func TestQdrantDeadLetterCheckSkipsForANonQdrantBackend(t *testing.T) {
	t.Setenv(runtimequeue.EnvRuntimeRoot, t.TempDir())
	store := newDoctorStore(t)
	seedDoctorDeadLetter(t, store.Root, "KND-IGNORED")

	for name, snapshot := range map[string]qdrantDiagnosticSnapshot{
		"disabled":       {Resolution: models.SemanticVectorStoreResolution{OptedOut: true, Backend: models.SemanticVectorBackendNone}},
		"sqlite backend": {Resolution: models.SemanticVectorStoreResolution{Enabled: true, Backend: models.SemanticVectorBackendSQLite}},
	} {
		t.Run(name, func(t *testing.T) {
			deps := localDependencies{qdrant: func(context.Context, *storage.Store) (qdrantDiagnosticSnapshot, error) {
				return snapshot, nil
			}}
			result, err := Run(context.Background(), RunOptions{
				Project: ProjectFromStore(store),
				Scopes:  []Scope{ScopeSearch},
			}, localCheckersWithDependencies(store, deps))
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if check := findCheck(t, result, "search.qdrant-dead-letters"); check.Status != StatusSkip {
				t.Fatalf("check = %#v, want skip", check)
			}
		})
	}
}
