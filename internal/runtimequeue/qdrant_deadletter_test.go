package runtimequeue

import (
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
