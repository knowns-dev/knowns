package storage

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestDecisionStoreCreateDefaultsAndBodyRoundTrip(t *testing.T) {
	store := setupDecisionStore(t)
	loc := time.FixedZone("ICT", 7*60*60)
	createdAt := time.Date(2026, 6, 18, 10, 24, 0, 0, loc)

	draft := &models.DecisionEntry{
		Title:                  "Use Qdrant as default vector DB",
		Context:                "Vector search needs a default backend.",
		Decision:               "Use Qdrant.",
		AlternativesConsidered: "Chroma and SQLite vectors.",
		Consequences:           "Operators must run Qdrant.",
	}
	if err := store.Decisions.Create(draft, DecisionCreateOptions{Now: createdAt}); err != nil {
		t.Fatalf("Create draft: %v", err)
	}
	wantID := "20260618-1024-use-qdrant-as-default-vector-db"
	if draft.ID != wantID {
		t.Fatalf("ID = %q, want %q", draft.ID, wantID)
	}
	if draft.Status != models.DecisionStatusDraft {
		t.Fatalf("Status = %q, want draft", draft.Status)
	}
	raw, err := os.ReadFile(filepath.Join(store.Root, "decisions", models.DecisionFileName(draft.ID)))
	if err != nil {
		t.Fatalf("read decision file: %v", err)
	}
	for _, want := range []string{
		"status: draft",
		"supersedes: []",
		"supersededBy: []",
		"sources: []",
		"relatedDocs: []",
		"relatedTasks: []",
		"## Context",
		"## Decision",
		"## Alternatives Considered",
		"## Consequences",
	} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("decision file missing %q:\n%s", want, string(raw))
		}
	}
	loaded, err := store.Decisions.Get(draft.ID)
	if err != nil {
		t.Fatalf("Get draft: %v", err)
	}
	if loaded.Context != draft.Context || loaded.Decision != draft.Decision || loaded.AlternativesConsidered != draft.AlternativesConsidered || loaded.Consequences != draft.Consequences {
		t.Fatalf("section round trip mismatch: %+v", loaded)
	}

	linkedDraft := &models.DecisionEntry{
		Title:        "Accepted with source",
		Sources:      []string{"@doc/specs/2026-06-18/memory-decision-review-ui"},
		RelatedTasks: []string{"yken4b"},
	}
	if err := store.Decisions.Create(linkedDraft, DecisionCreateOptions{Now: createdAt.Add(time.Minute)}); err != nil {
		t.Fatalf("Create linked draft: %v", err)
	}
	if linkedDraft.Status != models.DecisionStatusDraft {
		t.Fatalf("linked status = %q, want draft", linkedDraft.Status)
	}
}

func TestDecisionStoreCandidateReviewMetadataRoundTrip(t *testing.T) {
	store := setupDecisionStore(t)
	evaluatedAt := fixedDecisionTime().Add(time.Minute)
	candidate := &models.DecisionEntry{
		Title:                    "Persist Decision review state",
		ReviewState:              models.DecisionReviewStateNeedsResolution,
		ReviewBlockers:           []string{"linked task task1 is incomplete"},
		ReviewAllowedResolutions: []string{"link_as_related", "reject_new"},
		ReviewEvaluatedAt:        &evaluatedAt,
		ReviewMatches: []models.DecisionReviewMatch{{
			ID:        "20260618-1024-existing-decision",
			Title:     "Existing decision",
			Status:    models.DecisionStatusAccepted,
			Score:     0.92,
			Kind:      "duplicate",
			MatchedBy: []string{"lexical:title"},
			Snippet:   "Existing guidance",
			Tags:      []string{"decision"},
		}},
	}
	if err := store.Decisions.Create(candidate, DecisionCreateOptions{Now: fixedDecisionTime()}); err != nil {
		t.Fatalf("Create candidate: %v", err)
	}

	reopened := NewStore(store.Root)
	loaded, err := reopened.Decisions.Get(candidate.ID)
	if err != nil {
		t.Fatalf("Get reopened candidate: %v", err)
	}
	if loaded.ReviewState != candidate.ReviewState ||
		!reflect.DeepEqual(loaded.ReviewBlockers, candidate.ReviewBlockers) ||
		!reflect.DeepEqual(loaded.ReviewAllowedResolutions, candidate.ReviewAllowedResolutions) ||
		!reflect.DeepEqual(loaded.ReviewMatches, candidate.ReviewMatches) ||
		loaded.ReviewEvaluatedAt == nil ||
		!loaded.ReviewEvaluatedAt.Equal(evaluatedAt) {
		t.Fatalf("review metadata did not round trip:\n got: %+v\nwant: %+v", loaded, candidate)
	}
	if loaded.CurrentForDefaultRetrieval() {
		t.Fatal("draft candidate entered default current retrieval")
	}
}

func TestDecisionStoreListGetLink(t *testing.T) {
	store := setupDecisionStore(t)
	decision := &models.DecisionEntry{Title: "Link decision"}
	if err := store.Decisions.Create(decision, DecisionCreateOptions{Now: fixedDecisionTime()}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	linked, err := store.Decisions.Link(decision.ID,
		[]string{"specs/a", "specs/a"},
		[]string{"task1", "task2", "task1"},
		[]string{"@memory/source"},
	)
	if err != nil {
		t.Fatalf("Link: %v", err)
	}
	if linked.Status != models.DecisionStatusDraft {
		t.Fatalf("linked status = %q, want draft", linked.Status)
	}
	if !reflect.DeepEqual(linked.RelatedDocs, []string{"specs/a"}) {
		t.Fatalf("RelatedDocs = %#v", linked.RelatedDocs)
	}
	if !reflect.DeepEqual(linked.RelatedTasks, []string{"task1", "task2"}) {
		t.Fatalf("RelatedTasks = %#v", linked.RelatedTasks)
	}
	if !reflect.DeepEqual(linked.Sources, []string{"@memory/source"}) {
		t.Fatalf("Sources = %#v", linked.Sources)
	}

	entries, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(entries) != 1 || entries[0].ID != decision.ID {
		t.Fatalf("List entries = %+v", entries)
	}
	got, err := store.Decisions.Get(decision.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.ID != decision.ID {
		t.Fatalf("Get ID = %q, want %q", got.ID, decision.ID)
	}
}

func TestDecisionStoreCreateRejectsExistingID(t *testing.T) {
	store := setupDecisionStore(t)
	first := &models.DecisionEntry{
		ID:    "20260618-1024-explicit-id",
		Title: "First decision",
	}
	if err := store.Decisions.Create(first, DecisionCreateOptions{Now: fixedDecisionTime()}); err != nil {
		t.Fatalf("Create first: %v", err)
	}
	second := &models.DecisionEntry{
		ID:    first.ID,
		Title: "Second decision",
	}
	if err := store.Decisions.Create(second, DecisionCreateOptions{Now: fixedDecisionTime()}); err == nil {
		t.Fatal("Create with duplicate ID succeeded, want error")
	}
	got, err := store.Decisions.Get(first.ID)
	if err != nil {
		t.Fatalf("Get first: %v", err)
	}
	if got.Title != first.Title {
		t.Fatalf("duplicate create overwrote title = %q, want %q", got.Title, first.Title)
	}
}

func TestDecisionStoreRejectsInvalidID(t *testing.T) {
	store := setupDecisionStore(t)
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:    "../outside",
		Title: "Invalid ID",
	}, DecisionCreateOptions{Now: fixedDecisionTime()}); err == nil {
		t.Fatal("Create with invalid ID succeeded, want error")
	}
	if _, err := store.Decisions.Get("../outside"); err == nil {
		t.Fatal("Get with invalid ID succeeded, want error")
	}
}

func TestDecisionStoreSupersedeUpdatesBothRecords(t *testing.T) {
	store := setupDecisionStore(t)
	verifiedAt := fixedDecisionTime()
	oldDecision := &models.DecisionEntry{
		Title:        "Use Chroma as default vector DB",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"@doc/specs/vector"},
		Verification: []string{"task:@task-old:done"},
		VerifiedAt:   &verifiedAt,
	}
	newDecision := &models.DecisionEntry{
		Title:        "Use Qdrant as default vector DB",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"@doc/specs/vector-v2"},
		Verification: []string{"task:@task-new:done"},
		VerifiedAt:   &verifiedAt,
	}
	if err := store.Decisions.Create(oldDecision, DecisionCreateOptions{Now: fixedDecisionTime()}); err != nil {
		t.Fatalf("Create old: %v", err)
	}
	if err := store.Decisions.Create(newDecision, DecisionCreateOptions{Now: fixedDecisionTime().Add(time.Minute)}); err != nil {
		t.Fatalf("Create new: %v", err)
	}

	updatedOld, updatedNew, err := store.Decisions.Supersede(oldDecision.ID, newDecision.ID)
	if err != nil {
		t.Fatalf("Supersede: %v", err)
	}
	if updatedOld.Status != models.DecisionStatusSuperseded {
		t.Fatalf("old status = %q, want superseded", updatedOld.Status)
	}
	if !reflect.DeepEqual(updatedOld.SupersededBy, []string{newDecision.ID}) {
		t.Fatalf("old SupersededBy = %#v", updatedOld.SupersededBy)
	}
	if updatedNew.Status != models.DecisionStatusAccepted {
		t.Fatalf("new status = %q, want accepted", updatedNew.Status)
	}
	if !reflect.DeepEqual(updatedNew.Supersedes, []string{oldDecision.ID}) {
		t.Fatalf("new Supersedes = %#v", updatedNew.Supersedes)
	}
}

func TestDecisionStoreAcceptIsRollbackSafeAndIdempotent(t *testing.T) {
	store := setupDecisionStore(t)
	verifiedAt := fixedDecisionTime()
	oldDecision := &models.DecisionEntry{
		Title:        "Old current decision",
		Status:       models.DecisionStatusAccepted,
		Sources:      []string{"https://example.com/old"},
		Verification: []string{"task:@task-old:done"},
		VerifiedAt:   &verifiedAt,
	}
	replacement := &models.DecisionEntry{Title: "Replacement decision", Sources: []string{"https://example.com/new"}}
	if err := store.Decisions.Create(oldDecision, DecisionCreateOptions{Now: verifiedAt}); err != nil {
		t.Fatalf("Create old: %v", err)
	}
	if err := store.Decisions.Create(replacement, DecisionCreateOptions{Now: verifiedAt.Add(time.Minute)}); err != nil {
		t.Fatalf("Create replacement: %v", err)
	}

	writes := 0
	store.Decisions.writeFile = func(path string, data []byte) error {
		writes++
		if writes == 2 {
			return os.ErrPermission
		}
		return atomicWrite(path, data)
	}
	if _, _, err := store.Decisions.Accept(replacement.ID, []string{"task:@task-new:done"}, []string{oldDecision.ID}, verifiedAt.Add(2*time.Minute)); err == nil {
		t.Fatal("Accept succeeded despite injected second-write failure")
	}
	store.Decisions.writeFile = nil
	loadedOld, _ := store.Decisions.Get(oldDecision.ID)
	loadedReplacement, _ := store.Decisions.Get(replacement.ID)
	if loadedOld.Status != models.DecisionStatusAccepted || loadedReplacement.Status != models.DecisionStatusDraft {
		t.Fatalf("rollback did not restore both records: old=%s replacement=%s", loadedOld.Status, loadedReplacement.Status)
	}

	accepted, superseded, err := store.Decisions.Accept(replacement.ID, []string{"task:@task-new:done"}, []string{oldDecision.ID}, verifiedAt.Add(3*time.Minute))
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if !accepted.CurrentForDefaultRetrieval() || len(superseded) != 1 || superseded[0].Status != models.DecisionStatusSuperseded {
		t.Fatalf("accept result = accepted:%+v superseded:%+v", accepted, superseded)
	}
	if _, _, err := store.Decisions.Accept(replacement.ID, accepted.Verification, []string{oldDecision.ID}, *accepted.VerifiedAt); err != nil {
		t.Fatalf("idempotent Accept: %v", err)
	}
}

func setupDecisionStore(t *testing.T) *Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), ".knowns")
	store := NewStore(root)
	if err := store.Init("decision-store-test"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return store
}

func fixedDecisionTime() time.Time {
	return time.Date(2026, 6, 18, 10, 24, 0, 0, time.FixedZone("ICT", 7*60*60))
}
