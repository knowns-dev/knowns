package storage

import "testing"

// TestTaskFileMatchesEveryWrittenForm is the compatibility contract. Projects
// in the field hold files written under all three names, and a store that
// stopped resolving any of them would lose those tasks silently rather than
// loudly.
func TestTaskFileMatchesEveryWrittenForm(t *testing.T) {
	cases := []struct {
		name, id string
		want     bool
	}{
		{"abc123.md", "abc123", true},                       // canonical
		{"task-abc123.md", "abc123", true},                  // legacy, untitled
		{"task-abc123 - Fix login bug.md", "abc123", true},  // legacy, titled
		{"KN-7F3K9M.md", "KN-7F3K9M", true},                 // prefixed, canonical
		{"task-KN-7F3K9M - Add auth.md", "KN-7F3K9M", true}, // prefixed, legacy

		{"abc124.md", "abc123", false},
		{"task-abc1234.md", "abc123", false},
		{"abc123.txt", "abc123", false},
		{"notes-abc123.md", "abc123", false},
	}

	for _, tc := range cases {
		if got := TaskFileMatches(tc.name, tc.id); got != tc.want {
			t.Errorf("TaskFileMatches(%q, %q) = %v, want %v", tc.name, tc.id, got, tc.want)
		}
	}
}

// TestTaskFileMatchesPrefersCanonicalOverLegacyShape guards the one collision
// the two naming schemes can produce: a project whose configured prefix is
// "TASK" writes "TASK-ABC123.md", which on a case-insensitive filesystem also
// reads as the legacy "task-<id>.md" shape for some other id.
func TestTaskFileMatchesPrefersCanonicalOverLegacyShape(t *testing.T) {
	if !TaskFileMatches("TASK-ABC123.md", "TASK-ABC123") {
		t.Error("a task whose ID begins with a TASK prefix must match its own canonical file")
	}
	if TaskFileMatches("TASK-ABC123.md", "ABC123") {
		t.Error("the canonical file of one task must not be claimed by another id")
	}
}

// TestIDFromFilenameReadsEveryForm covers the bug the old regexp carried: for
// "task-abc123.md" it captured "abc123.md", extension included. It had no
// callers, so nothing failed; changing the written format would have woken it.
func TestIDFromFilenameReadsEveryForm(t *testing.T) {
	cases := map[string]string{
		"abc123.md":                      "abc123",
		"task-abc123.md":                 "abc123",
		"task-abc123 - Fix login bug.md": "abc123",
		"KN-7F3K9M.md":                   "KN-7F3K9M",
		"task-KN-7F3K9M - Add auth.md":   "KN-7F3K9M",
		"":                               "",
	}
	for name, want := range cases {
		if got := IDFromFilename(name); got != want {
			t.Errorf("IDFromFilename(%q) = %q, want %q", name, got, want)
		}
	}
}
