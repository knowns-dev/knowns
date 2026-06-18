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

	accepted := &models.DecisionEntry{
		Title:        "Accepted with source",
		Sources:      []string{"@doc/specs/2026-06-18/memory-decision-review-ui"},
		RelatedTasks: []string{"yken4b"},
	}
	if err := store.Decisions.Create(accepted, DecisionCreateOptions{Now: createdAt.Add(time.Minute)}); err != nil {
		t.Fatalf("Create accepted: %v", err)
	}
	if accepted.Status != models.DecisionStatusAccepted {
		t.Fatalf("accepted status = %q, want accepted", accepted.Status)
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
	if linked.Status != models.DecisionStatusAccepted {
		t.Fatalf("linked status = %q, want accepted", linked.Status)
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
	oldDecision := &models.DecisionEntry{
		Title:   "Use Chroma as default vector DB",
		Sources: []string{"@doc/specs/vector"},
	}
	newDecision := &models.DecisionEntry{
		Title: "Use Qdrant as default vector DB",
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
