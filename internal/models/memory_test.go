package models

import (
	"errors"
	"reflect"
	"strings"
	"testing"
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
	// Anchored to the rule's effective date, not to wall-clock time, so the
	// grace window for the pre-existing backlog does not silently neutralise
	// what this test is checking.
	now := memoryProposalTTLEffectiveFrom.AddDate(0, 0, 400)
	old := now.AddDate(0, 0, -390)

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
	now := memoryProposalTTLEffectiveFrom.AddDate(0, 0, 400)
	old := now.AddDate(0, 0, -390)

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

func TestProposalGracePeriodProtectsThePreExistingBacklog(t *testing.T) {
	// The backlog that existed when the TTL shipped accumulated under a system
	// that never surfaced the queue. Measuring its age from when each entry was
	// written would retire it for missing a deadline that did not exist, and
	// would take real knowledge with it: this store held six well-sourced
	// failures and a root-cause writeup in exactly that state.
	old := memoryProposalTTLEffectiveFrom.AddDate(0, 0, -400)
	entry := &MemoryEntry{ID: "backlog", Status: MemoryStatusProposed, UpdatedAt: old}

	justInside := memoryProposalTTLEffectiveFrom.AddDate(0, 0, MemoryProposalTTLDays-1)
	if ProposalIsExpired(entry, MemoryProposalTTLDays, justInside) {
		t.Error("an entry from before the rule must get the full window, measured from the rule")
	}

	justPast := memoryProposalTTLEffectiveFrom.AddDate(0, 0, MemoryProposalTTLDays+1)
	if !ProposalIsExpired(entry, MemoryProposalTTLDays, justPast) {
		t.Error("once the grace window passes, the ordinary rule applies")
	}

	// Anything written after the rule took effect is measured normally.
	fresh := &MemoryEntry{
		ID:     "after",
		Status: MemoryStatusProposed,
		// Written the day the rule shipped, then left alone.
		UpdatedAt: memoryProposalTTLEffectiveFrom.AddDate(0, 0, 1),
	}
	if ProposalIsExpired(fresh, MemoryProposalTTLDays, justInside) {
		t.Error("a recent proposal is not abandoned yet")
	}
}

func TestDeriveMemoryKeyFoldsDiacriticsInsteadOfShreddingThem(t *testing.T) {
	// Replacing every non-ASCII rune with a separator destroys any language that
	// writes with diacritics. The user of this repository writes Vietnamese
	// titles, so the shipped behaviour produced keys naming nothing and colliding
	// with each other on shared consonants.
	cases := []struct{ title, want string }{
		{"Không dùng em dash trong nội dung", "khong-dung-em-dash-trong-noi-dung"},
		{"Cần sử dụng Knowns để quản lý tasks", "can-su-dung-knowns-de-quan-ly-tasks"},
		{"Dùng tavily CLI cho web research", "dung-tavily-cli-cho-web-research"},
		// English is unaffected by the fold.
		{"Two hash functions over one record always drift", "two-hash-functions-over-one-record-always-drift"},
		// Letters carrying a stroke rather than a combining mark need the explicit
		// map: NFD leaves them whole.
		{"Đường dẫn", "duong-dan"},
	}
	for _, tc := range cases {
		if got := DeriveMemoryKey(tc.title); got != tc.want {
			t.Errorf("DeriveMemoryKey(%q)\n  got  %q\n  want %q", tc.title, got, tc.want)
		}
	}

	// Folding does NOT preserve tone, so titles differing only by tone share a
	// key. That is inherent to slugging and is why a derived key never upserts on
	// its own: only a key the caller states explicitly replaces an entry.
	if DeriveMemoryKey("Không dùng em dash") != DeriveMemoryKey("Khống dụng em dash") {
		t.Error("tone-only differences are expected to fold together; if they no longer do, the upsert rule can be revisited")
	}

	// What folding does buy is word shape. Titles that differ in base letters
	// stay distinct, where the old rule collapsed them onto their consonants.
	if DeriveMemoryKey("Nội dung") == DeriveMemoryKey("Ngôn ngữ") {
		t.Error("different words must not share a key")
	}
}

func TestMemoryClaimSplitsAtMarker(t *testing.T) {
	content := "Never mutate os.Args[0] in tests.\n" + MemoryDetailMarker + "\n**Why:** the runtime queue resolves its binary from it, so a mutated value races every parallel test."
	claim, hasDetail := MemoryClaim(content)
	if claim != "Never mutate os.Args[0] in tests." {
		t.Fatalf("claim = %q", claim)
	}
	if !hasDetail {
		t.Fatalf("hasDetail = false, want true when material sits below the marker")
	}
}

func TestMemoryClaimFallsBackToFirstParagraph(t *testing.T) {
	// The twelve entries already in the store carry no marker. They must keep
	// working untouched, which is the whole reason the fallback exists.
	content := "Two hash functions over one record always drift.\n\nOn 2026-08-30 the writer hashed the rendered body and the verifier hashed the parsed struct."
	claim, hasDetail := MemoryClaim(content)
	if claim != "Two hash functions over one record always drift." {
		t.Fatalf("claim = %q", claim)
	}
	if !hasDetail {
		t.Fatalf("hasDetail = false, want true when a second paragraph exists")
	}
}

func TestMemoryClaimReportsNoDetailWhenClaimIsEverything(t *testing.T) {
	// A short memory must not advertise a fuller version that does not exist.
	claim, hasDetail := MemoryClaim("Do not use the rtk wrapper; run commands directly.")
	if claim != "Do not use the rtk wrapper; run commands directly." {
		t.Fatalf("claim = %q", claim)
	}
	if hasDetail {
		t.Fatalf("hasDetail = true, want false when nothing was held back")
	}
}

func TestMemoryClaimHandlesMarkerAtStart(t *testing.T) {
	// A leading marker would otherwise make the claim empty and promote the
	// detail into the claim slot on the paragraph fallback.
	claim, hasDetail := MemoryClaim(MemoryDetailMarker + "\nonly detail here")
	if claim == "" || hasDetail {
		t.Fatalf("claim = %q hasDetail = %v, want the whole body claimed and no detail", claim, hasDetail)
	}
}

func TestMemoryClaimOnEmptyContent(t *testing.T) {
	claim, hasDetail := MemoryClaim("   \n\n  ")
	if claim != "" || hasDetail {
		t.Fatalf("claim = %q hasDetail = %v, want empty and false", claim, hasDetail)
	}
}

func TestInspectMemoryClaimNamesWhoChoseTheBoundary(t *testing.T) {
	cases := []struct {
		name       string
		content    string
		wantSource string
		wantClaim  string
	}{
		{"marker", "The point.\n" + MemoryDetailMarker + "\nThe evidence.", MemoryClaimSourceMarker, "The point."},
		{"guessed", "The point.\n\nThe evidence.", MemoryClaimSourceFirstParagraph, "The point."},
		{"nothing to split", "The point and nothing else.", MemoryClaimSourceWhole, "The point and nothing else."},
		{"empty", "  ", MemoryClaimSourceWhole, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := InspectMemoryClaim(tc.content)
			if got.Source != tc.wantSource || got.Claim != tc.wantClaim {
				t.Fatalf("source = %q claim = %q, want %q / %q", got.Source, got.Claim, tc.wantSource, tc.wantClaim)
			}
		})
	}
}

func TestInsertMemoryDetailMarkerPreservesTheClaim(t *testing.T) {
	// The whole point of the migration: freeze the boundary WITHOUT changing
	// what gets injected. If the claim moves, the migration is a behaviour
	// change wearing the clothes of a cleanup.
	content := "The point.\n\nThe evidence.\n\nMore evidence."
	before, _ := MemoryClaim(content)
	migrated, changed := InsertMemoryDetailMarker(content)
	if !changed {
		t.Fatal("expected a guessed boundary to be migrated")
	}
	after, hasDetail := MemoryClaim(migrated)
	if after != before {
		t.Fatalf("claim moved: %q -> %q", before, after)
	}
	if !hasDetail {
		t.Fatal("migrated entry lost its detail")
	}
	if InspectMemoryClaim(migrated).Source != MemoryClaimSourceMarker {
		t.Fatal("migrated entry should report the author as the source")
	}
	// Running it twice must not stack markers.
	again, changedAgain := InsertMemoryDetailMarker(migrated)
	if changedAgain || again != migrated {
		t.Fatal("migration is not idempotent")
	}
}

func TestInsertMemoryDetailMarkerSkipsSingleParagraphBodies(t *testing.T) {
	content := "Nothing to split here."
	got, changed := InsertMemoryDetailMarker(content)
	if changed || got != content {
		t.Fatalf("single-paragraph body should be left alone, got %q changed=%v", got, changed)
	}
}

func TestEditingTheOpeningParagraphCannotMoveAMarkedBoundary(t *testing.T) {
	// Without a marker, rewriting the opening paragraph silently changes what
	// is injected. With one, the boundary belongs to the author.
	marked := "Original point.\n\n" + MemoryDetailMarker + "\n\nEvidence one.\n\nEvidence two."
	edited := strings.Replace(marked, "Original point.", "Rewritten point spanning\nmore than one line.", 1)
	info := InspectMemoryClaim(edited)
	if info.Source != MemoryClaimSourceMarker {
		t.Fatalf("source = %q, want the marker to still own the boundary", info.Source)
	}
	if info.Claim != "Rewritten point spanning\nmore than one line." {
		t.Fatalf("claim = %q", info.Claim)
	}
	if strings.Contains(info.Claim, "Evidence") {
		t.Fatal("the boundary moved into the evidence")
	}
}

func TestStripMemoryDetailMarkerRestoresTheOriginalBody(t *testing.T) {
	// Retrieval must score a memory identically before and after migration, so
	// stripping has to give back exactly what was there.
	original := "The point.\n\nThe evidence."
	migrated, _ := InsertMemoryDetailMarker(original)
	if got := StripMemoryDetailMarker(migrated); got != original {
		t.Fatalf("strip = %q, want %q", got, original)
	}
	if got := StripMemoryDetailMarker(original); got != original {
		t.Fatalf("strip changed an unmarked body: %q", got)
	}
}
