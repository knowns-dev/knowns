package runtimequeue

import (
	"bytes"
	"fmt"
	"os"
	"testing"
)

// TestNewIntentRevivesDeadLetteredJob pins the defect that stranded eight
// entities in a real project. A Qdrant outage exhausted the retry budget, every
// pending job dead-lettered together, and nothing could ever run them again:
// nextReadyJob skips a dead letter unconditionally and RetryJob, the only other
// way to clear the flag, is wired to no command. Editing the entity afterwards
// refreshed the job so it looked healthy while remaining unschedulable.
func TestNewIntentRevivesDeadLetteredJob(t *testing.T) {
	root := t.TempDir()
	intent := QdrantIntent{EntityType: "task", EntityID: "abc123", Revision: 1, Operation: "update", Generation: 1}
	if _, err := EnqueueQdrantIntent(root, intent); err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}

	// Simulate the outage outcome: the job burned its budget and dead-lettered.
	if err := updateQueue(root, func(state *QueueState) error {
		for _, job := range state.Jobs {
			job.DeadLetter = true
			job.Attempts = qdrantRetryLimit
			job.LastError = "qdrant unreachable"
		}
		return nil
	}); err != nil {
		t.Fatalf("seed dead letter: %v", err)
	}

	// The entity is edited again, which is genuinely new work.
	next := intent
	next.Revision = 2
	next.Generation = 2
	revived, err := EnqueueQdrantIntent(root, next)
	if err != nil {
		t.Fatalf("re-enqueue: %v", err)
	}
	if revived.DeadLetter {
		t.Fatal("a newer intent left the job dead-lettered, so it can never be scheduled again")
	}
	if revived.Attempts != 0 || revived.LastError != "" {
		t.Fatalf("revived job kept prior failure state: attempts=%d lastError=%q", revived.Attempts, revived.LastError)
	}
}

// TestStaleIntentDoesNotReviveDeadLetter is the other half. Only new work earns
// a fresh attempt; a re-enqueue carrying the same or an older intent must not
// resurrect a job that already failed, or a permanently broken backend would be
// retried without end.
func TestStaleIntentDoesNotReviveDeadLetter(t *testing.T) {
	root := t.TempDir()
	intent := QdrantIntent{EntityType: "task", EntityID: "abc123", Revision: 5, Operation: "update", Generation: 5}
	if _, err := EnqueueQdrantIntent(root, intent); err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}
	if err := updateQueue(root, func(state *QueueState) error {
		for _, job := range state.Jobs {
			job.DeadLetter = true
		}
		return nil
	}); err != nil {
		t.Fatalf("seed dead letter: %v", err)
	}

	older := intent
	older.Revision = 3
	older.Generation = 3
	got, err := EnqueueQdrantIntent(root, older)
	if err != nil {
		t.Fatalf("re-enqueue: %v", err)
	}
	if !got.DeadLetter {
		t.Fatal("an older intent revived a dead letter; only newer work should")
	}
}

// TestRetryDeadLettersReleasesAllInOnePass pins the bulk recovery path this
// task adds. A real outage dead-lettered 153 jobs across 8 projects at once;
// releasing them one RetryJob call at a time would mean 153 separate
// lock/read/write cycles on the same queue file. RetryDeadLetters must
// release every retained Qdrant dead letter in a single updateQueue pass,
// and must never touch a job that is not one.
func TestRetryDeadLettersReleasesAllInOnePass(t *testing.T) {
	root := t.TempDir()
	const count = 5
	for i := 0; i < count; i++ {
		if _, err := EnqueueQdrantIntent(root, QdrantIntent{
			EntityType: "task", EntityID: fmt.Sprintf("stranded-%d", i), Revision: 1, Operation: "update",
		}); err != nil {
			t.Fatalf("EnqueueQdrantIntent: %v", err)
		}
	}
	// A generic background job sits alongside the stranded Qdrant jobs. The
	// bulk sweep must leave it exactly as it is, dead-lettered or not.
	genericJob, err := Enqueue(root, JobIndexDoc, "docs/example.md")
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	// Simulate the outage outcome: every Qdrant job burned its retry budget
	// together and dead-lettered.
	if err := updateQueue(root, func(state *QueueState) error {
		for _, job := range state.Jobs {
			if job.Kind == JobQdrantReconcile {
				job.DeadLetter = true
				job.Attempts = qdrantRetryLimit
				job.LastError = "qdrant unreachable"
			}
		}
		return nil
	}); err != nil {
		t.Fatalf("seed dead letters: %v", err)
	}

	released, err := RetryDeadLetters(root)
	if err != nil {
		t.Fatalf("RetryDeadLetters: %v", err)
	}
	if len(released) != count {
		t.Fatalf("released %d jobs, want %d", len(released), count)
	}
	for _, job := range released {
		if job.DeadLetter || job.Attempts != 0 || job.LastError != "" {
			t.Fatalf("released job kept prior failure state: %#v", job)
		}
	}

	state, err := LoadQueue(root)
	if err != nil {
		t.Fatalf("LoadQueue: %v", err)
	}
	for _, job := range state.Jobs {
		if job.Kind == JobQdrantReconcile && job.DeadLetter {
			t.Fatalf("job %s is still dead-lettered after a bulk release", job.ID)
		}
		if job.ID == genericJob.ID && job.DeadLetter {
			t.Fatal("bulk release touched a non-Qdrant job")
		}
	}
}

// TestListDeadLettersPreviewLeavesQueueByteIdentical pins --dry-run's
// contract. ListDeadLetters goes through LoadQueue directly and never
// acquires the queue lock, so a preview must leave the queue file
// byte-identical — unlike every mutating path, which also runs
// pruneDeadLetters as a side effect and could otherwise shrink the queue
// just by being asked what it contains.
func TestListDeadLettersPreviewLeavesQueueByteIdentical(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 3; i++ {
		if _, err := EnqueueQdrantIntent(root, QdrantIntent{
			EntityType: "task", EntityID: fmt.Sprintf("preview-%d", i), Revision: 1, Operation: "update",
		}); err != nil {
			t.Fatalf("EnqueueQdrantIntent: %v", err)
		}
	}
	if err := updateQueue(root, func(state *QueueState) error {
		for _, job := range state.Jobs {
			job.DeadLetter = true
			job.Attempts = qdrantRetryLimit
			job.LastError = "qdrant unreachable"
		}
		return nil
	}); err != nil {
		t.Fatalf("seed dead letters: %v", err)
	}

	before, err := os.ReadFile(queuePath(root))
	if err != nil {
		t.Fatalf("read queue before preview: %v", err)
	}

	listed, err := ListDeadLetters(root)
	if err != nil {
		t.Fatalf("ListDeadLetters: %v", err)
	}
	if len(listed) != 3 {
		t.Fatalf("listed %d dead letters, want 3", len(listed))
	}

	after, err := os.ReadFile(queuePath(root))
	if err != nil {
		t.Fatalf("read queue after preview: %v", err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("ListDeadLetters preview mutated the queue file")
	}
}

// TestRetryJobRefusesNonDeadLetter preserves the terminal behavior generic
// background failures have always had: only a retained Qdrant dead letter
// may be replayed. A job that is not Qdrant work, or a Qdrant job that has
// not yet exhausted its retry budget, must be refused rather than silently
// revived.
func TestRetryJobRefusesNonDeadLetter(t *testing.T) {
	root := t.TempDir()

	genericJob, err := Enqueue(root, JobIndexDoc, "docs/example.md")
	if err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if _, err := RetryJob(root, genericJob.ID); err == nil {
		t.Fatal("RetryJob released a non-Qdrant job, want refusal")
	}

	qdrantJob, err := EnqueueQdrantIntent(root, QdrantIntent{
		EntityType: "task", EntityID: "still-live", Revision: 1, Operation: "update",
	})
	if err != nil {
		t.Fatalf("EnqueueQdrantIntent: %v", err)
	}
	if _, err := RetryJob(root, qdrantJob.ID); err == nil {
		t.Fatal("RetryJob released a live (non-dead-lettered) Qdrant job, want refusal")
	}
}
