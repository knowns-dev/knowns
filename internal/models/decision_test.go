package models

import (
	"testing"
	"time"
)

func TestNewDecisionIDUsesLocalMinuteSlugAndCollisionSuffix(t *testing.T) {
	loc := time.FixedZone("ICT", 7*60*60)
	createdAt := time.Date(2026, 6, 18, 10, 24, 0, 0, loc)

	got := NewDecisionID("Use Qdrant as default vector DB", createdAt, nil)
	want := "20260618-1024-use-qdrant-as-default-vector-db"
	if got != want {
		t.Fatalf("NewDecisionID = %q, want %q", got, want)
	}

	seen := map[string]bool{
		want:        true,
		want + "-2": true,
	}
	got = NewDecisionID("Use Qdrant as default vector DB", createdAt, func(id string) bool {
		return seen[id]
	})
	if got != want+"-3" {
		t.Fatalf("collision NewDecisionID = %q, want %q", got, want+"-3")
	}
}

func TestDecisionApplyDefaults(t *testing.T) {
	draft := &DecisionEntry{}
	draft.ApplyDecisionDefaults()
	if draft.Status != DecisionStatusDraft {
		t.Fatalf("draft status = %q, want %q", draft.Status, DecisionStatusDraft)
	}

	accepted := &DecisionEntry{Sources: []string{"@doc/specs/example"}}
	accepted.ApplyDecisionDefaults()
	if accepted.Status != DecisionStatusAccepted {
		t.Fatalf("accepted status = %q, want %q", accepted.Status, DecisionStatusAccepted)
	}
}

func TestValidDecisionID(t *testing.T) {
	valid := "20260618-1024-use-qdrant-as-default-vector-db"
	if !ValidDecisionID(valid) {
		t.Fatalf("ValidDecisionID(%q) = false, want true", valid)
	}
	for _, id := range []string{
		"../outside",
		"20260618-use-qdrant",
		"20260618-1024-Use-Qdrant",
		"20260618-1024-",
	} {
		if ValidDecisionID(id) {
			t.Fatalf("ValidDecisionID(%q) = true, want false", id)
		}
	}
}
