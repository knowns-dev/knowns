package storage

import (
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func reviewedDecision() *models.DecisionEntry {
	at := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	entry := &models.DecisionEntry{
		ID:          "d-1",
		Title:       "Store vectors in SQLite",
		Status:      "accepted",
		Decision:    "The derived index lives in .knowns/.search/index.db.",
		ReviewState: models.DecisionReviewStateReadyForReview,
	}
	entry.ReviewEvaluatedAt = &at
	entry.ReviewEvaluatedHash = CanonicalDecisionHash(entry)
	return entry
}

// TestReviewWatermarkIgnoresReviewFields is the property the whole watermark
// depends on: recording a review must not change the hash the review was taken
// against, or every review would be stale the instant it was written.
func TestReviewWatermarkIgnoresReviewFields(t *testing.T) {
	entry := reviewedDecision()
	before := CanonicalDecisionHash(entry)

	entry.ReviewState = models.DecisionReviewStateNeedsResolution
	entry.ReviewBlockers = []string{"missing evidence"}
	entry.ReviewMatches = []models.DecisionReviewMatch{{ID: "d-2", Score: 0.91}}
	entry.ReviewAllowedResolutions = []string{"supersede"}
	later := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	entry.ReviewEvaluatedAt = &later

	if got := CanonicalDecisionHash(entry); got != before {
		t.Error("review fields must not feed the hash; a review would invalidate itself")
	}
	if DecisionReviewIsStale(entry) {
		t.Error("recording a review must not make that review stale")
	}
}

func TestReviewWatermarkDetectsContentChange(t *testing.T) {
	entry := reviewedDecision()
	if DecisionReviewIsStale(entry) {
		t.Fatal("a freshly reviewed decision is not stale")
	}

	entry.Decision = "The derived index moved to Qdrant."
	if !DecisionReviewIsStale(entry) {
		t.Error("changing the decision's substance must strand the review")
	}
}

// TestReviewWatermarkCatchesWhatATimestampCannot is the case that motivated the
// field. Two edits landing inside the same clock reading leave ReviewEvaluatedAt
// unable to say whether the review saw the current text; the hash still can.
func TestReviewWatermarkCatchesWhatATimestampCannot(t *testing.T) {
	entry := reviewedDecision()
	sameInstant := *entry.ReviewEvaluatedAt

	entry.Decision = "Edited without advancing any clock."
	entry.UpdatedAt = sameInstant

	if entry.ReviewEvaluatedAt.Before(entry.UpdatedAt) {
		t.Fatal("this test is only meaningful when the timestamps cannot be ordered")
	}
	if !DecisionReviewIsStale(entry) {
		t.Error("the hash must detect an edit that the timestamps cannot distinguish")
	}
}

// TestReviewWatermarkAbsentIsNotStale keeps decisions written before the field
// existed from being reported as stale, which would be a false accusation
// rather than a finding.
func TestReviewWatermarkAbsentIsNotStale(t *testing.T) {
	entry := reviewedDecision()
	entry.ReviewEvaluatedHash = ""
	if DecisionReviewIsStale(entry) {
		t.Error("a decision predating the watermark is unverifiable, not stale")
	}
	if DecisionReviewIsStale(nil) {
		t.Error("nil must not be reported as stale")
	}
}

// TestReviewWatermarkSurvivesPersistReload is the test whose absence let two
// bugs through. Both were round-trip failures invisible to an in-memory check:
// the hash mixed the section fields with Content (empty on write, populated on
// read), and empty slices hashed differently from the nil slices the YAML
// reader produces. Either one made every freshly created decision report its
// own review as stale.
func TestReviewWatermarkSurvivesPersistReload(t *testing.T) {
	store := setupDecisionStore(t)
	createdAt := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)

	draft := &models.DecisionEntry{
		Title:    "Keep markdown as the record",
		Context:  "Three audiences read the store and share no client.",
		Decision: "Markdown stays the source of truth.",
	}
	if err := store.Decisions.Create(draft, DecisionCreateOptions{Now: createdAt}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Stamp the watermark the way the review service does, then persist.
	draft.ReviewState = models.DecisionReviewStateReadyForReview
	draft.ReviewEvaluatedAt = &createdAt
	draft.ReviewEvaluatedHash = CanonicalDecisionHash(draft)
	if err := store.Decisions.Update(draft); err != nil {
		t.Fatalf("Update: %v", err)
	}

	loaded, err := store.Decisions.Get(draft.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if loaded.ReviewEvaluatedHash != draft.ReviewEvaluatedHash {
		t.Fatalf("watermark did not persist: got %q, want %q", loaded.ReviewEvaluatedHash, draft.ReviewEvaluatedHash)
	}
	if got := CanonicalDecisionHash(loaded); got != draft.ReviewEvaluatedHash {
		t.Errorf("hash is not stable across persist/reload:\n  wrote %s\n  read  %s", draft.ReviewEvaluatedHash, got)
	}
	if DecisionReviewIsStale(loaded) {
		t.Error("a decision reported its own review as stale immediately after reload")
	}

	// After a load, Content holds the authoritative body and the section
	// fields are derived views of it, so an edit is a change to Content. This
	// mirrors the real case the watermark exists for: something rewrote the
	// markdown outside the review.
	edited := *loaded
	edited.Content = strings.Replace(loaded.Content, "source of truth", "cache", 1)
	if edited.Content == loaded.Content {
		t.Fatal("test setup failed to change the body")
	}
	if !DecisionReviewIsStale(&edited) {
		t.Error("a rewritten body must strand the review")
	}

	// A frontmatter change counts too, and does not depend on body semantics.
	tagged := *loaded
	tagged.Tags = []string{"storage"}
	if !DecisionReviewIsStale(&tagged) {
		t.Error("a frontmatter change must strand the review")
	}
}
