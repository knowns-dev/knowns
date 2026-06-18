package models

import (
	"reflect"
	"testing"
)

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
