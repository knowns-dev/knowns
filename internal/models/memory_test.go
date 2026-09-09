package models

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestLegacyDecisionMemoryCategoryPolicyNormalizesInput(t *testing.T) {
	for _, category := range []string{"decision", " Decision ", "DECISION"} {
		if !IsLegacyDecisionMemoryCategory(category) {
			t.Fatalf("category %q was not recognized as legacy", category)
		}
		if err := ValidateNewMemoryCategory(category); !errors.Is(err, ErrLegacyDecisionMemoryWrite) {
			t.Fatalf("ValidateNewMemoryCategory(%q) = %v", category, err)
		}
	}
	if err := ValidateNewMemoryCategory("pattern"); err != nil {
		t.Fatalf("pattern rejected: %v", err)
	}
}

func TestLegacyDecisionMemoryUpdatePolicy(t *testing.T) {
	existing := &MemoryEntry{Category: "decision", Status: MemoryStatusActive}
	for _, updated := range []*MemoryEntry{
		{Category: "decision", Status: MemoryStatusArchived},
		{Category: " Decision ", Status: MemoryStatusRejected},
		{Category: "pattern", Status: MemoryStatusActive},
	} {
		if err := ValidateLegacyDecisionMemoryUpdate(existing, updated); err != nil {
			t.Fatalf("allowed legacy transition rejected: %+v: %v", updated, err)
		}
	}
	if err := ValidateLegacyDecisionMemoryUpdate(existing, &MemoryEntry{Category: "decision", Status: MemoryStatusActive}); !errors.Is(err, ErrLegacyDecisionMemoryWrite) {
		t.Fatalf("active legacy mutation error = %v", err)
	}
}

func TestValidMemoryStatus(t *testing.T) {
	for _, status := range []string{
		MemoryStatusProposed,
		MemoryStatusActive,
		MemoryStatusStale,
		MemoryStatusDeprecated,
		MemoryStatusArchived,
		MemoryStatusRejected,
		MemoryStatusMerged,
	} {
		if !ValidMemoryStatus(status) {
			t.Fatalf("ValidMemoryStatus(%q) = false", status)
		}
	}
	if ValidMemoryStatus("unknown") {
		t.Fatal("ValidMemoryStatus accepted unknown status")
	}
}

func TestValidMemoryConfidence(t *testing.T) {
	for _, confidence := range []string{
		MemoryConfidenceLow,
		MemoryConfidenceMedium,
		MemoryConfidenceHigh,
	} {
		if !ValidMemoryConfidence(confidence) {
			t.Fatalf("ValidMemoryConfidence(%q) = false", confidence)
		}
	}
	if ValidMemoryConfidence("certain") {
		t.Fatal("ValidMemoryConfidence accepted unknown confidence")
	}
}

func TestMemoryEntryApplyLifecycleDefaults(t *testing.T) {
	entry := &MemoryEntry{}
	entry.ApplyLifecycleDefaults()
	if entry.Status != MemoryStatusActive {
		t.Fatalf("Status = %q, want %q", entry.Status, MemoryStatusActive)
	}
}

func TestMemoryEntryCurrentForDefaultRetrieval(t *testing.T) {
	cases := []struct {
		status string
		want   bool
	}{
		{"", true},
		{MemoryStatusActive, true},
		{MemoryStatusProposed, false},
		{MemoryStatusMerged, false},
		{MemoryStatusArchived, false},
	}
	for _, tc := range cases {
		entry := &MemoryEntry{Status: tc.status}
		if got := entry.CurrentForDefaultRetrieval(); got != tc.want {
			t.Fatalf("CurrentForDefaultRetrieval(%q) = %v, want %v", tc.status, got, tc.want)
		}
	}
}

func TestMemoryEntryMissingTrustMetadata(t *testing.T) {
	entry := &MemoryEntry{
		Status:                   MemoryStatusActive,
		LifecycleMetadataMissing: []string{"status", "confidence"},
	}
	got := entry.MissingTrustMetadata()
	want := []string{"status", "confidence", "lastVerified", "ttlDays", "sources"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("MissingTrustMetadata() = %#v, want %#v", got, want)
	}
}

func TestSelectMemoryCleanupCandidatesSeparatesAbandonedFromOld(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := now.AddDate(0, 0, -400)

	entries := []*MemoryEntry{
		// Verified and in use. It is old, but nothing about it needs cleaning,
		// and offering it beside abandoned proposals is what made the old report
		// something nobody acted on.
		{ID: "live", Title: "Still true", Layer: MemoryLayerProject, Status: MemoryStatusActive, UpdatedAt: old},
		{ID: "queued", Title: "Nobody looked", Layer: MemoryLayerProject, Status: MemoryStatusProposed, UpdatedAt: old},
		{ID: "fresh", Title: "Just written", Layer: MemoryLayerProject, Status: MemoryStatusProposed, UpdatedAt: now},
	}

	got := SelectMemoryCleanupCandidates(entries, 0, 0, now)

	byID := map[string]MemoryCleanupCandidate{}
	for _, c := range got {
		byID[c.ID] = c
	}
	if _, ok := byID["fresh"]; ok {
		t.Error("a proposal inside its window is not a cleanup candidate")
	}
	if byID["queued"].Kind != MemoryCleanupAbandonedProposal {
		t.Errorf("queued kind = %q, want %q", byID["queued"].Kind, MemoryCleanupAbandonedProposal)
	}
	if byID["live"].Kind != MemoryCleanupStaleEntry {
		t.Errorf("live kind = %q, want %q", byID["live"].Kind, MemoryCleanupStaleEntry)
	}
	// Abandoned proposals sort first: they are the ones that can be cleared
	// without judgement.
	if len(got) > 0 && got[0].ID != "queued" {
		t.Errorf("expected the abandoned proposal first, got %q", got[0].ID)
	}
}

func TestProposalIsExpiredOnlyAppliesToProposed(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := now.AddDate(0, 0, -400)

	for _, status := range []string{MemoryStatusActive, MemoryStatusArchived, MemoryStatusRejected, MemoryStatusStale} {
		entry := &MemoryEntry{ID: "x", Status: status, UpdatedAt: old}
		if ProposalIsExpired(entry, MemoryProposalTTLDays, now) {
			t.Errorf("status %q must never expire; only an unresolved proposal does", status)
		}
	}
	if !ProposalIsExpired(&MemoryEntry{ID: "x", Status: MemoryStatusProposed, UpdatedAt: old}, MemoryProposalTTLDays, now) {
		t.Error("an unresolved proposal past its window should expire")
	}
}
