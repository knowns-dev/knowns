package models

import (
	"regexp"
	"testing"
)

func TestNormalizeTaskIDPrefix(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: ""},
		{input: " kn ", want: "KN"},
		{input: "is2", want: "IS2"},
		{input: "Feature8", want: "FEATURE8"},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got, err := NormalizeTaskIDPrefix(tt.input)
			if err != nil {
				t.Fatalf("NormalizeTaskIDPrefix(%q): %v", tt.input, err)
			}
			if got != tt.want {
				t.Fatalf("NormalizeTaskIDPrefix(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}

	for _, input := range []string{"A", "1A", "TOO-LONG", "ABCDEFGHI", "A_", "A B"} {
		t.Run("invalid_"+input, func(t *testing.T) {
			if _, err := NormalizeTaskIDPrefix(input); err == nil {
				t.Fatalf("NormalizeTaskIDPrefix(%q) succeeded, want error", input)
			}
		})
	}
}

func TestNewPrefixedTaskIDUsesCrockfordBase32(t *testing.T) {
	pattern := regexp.MustCompile(`^KN-[0-9A-HJKMNP-TV-Z]{6}$`)
	for range 100 {
		id, err := NewPrefixedTaskID("kn")
		if err != nil {
			t.Fatalf("NewPrefixedTaskID: %v", err)
		}
		if !pattern.MatchString(id) {
			t.Fatalf("NewPrefixedTaskID() = %q, want PREFIX plus six Crockford Base32 characters", id)
		}
	}
}

func TestNewPrefixedTaskIDRequiresPrefix(t *testing.T) {
	if _, err := NewPrefixedTaskID(""); err == nil {
		t.Fatal("NewPrefixedTaskID(\"\") succeeded, want error")
	}
	if _, err := NewPrefixedTaskID("1bad"); err == nil {
		t.Fatal("NewPrefixedTaskID(\"1bad\") succeeded, want error")
	}
}

func TestNewTaskIDKeepsLegacyBase36Format(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-z]{6}$`)
	for range 100 {
		if id := NewTaskID(); !pattern.MatchString(id) {
			t.Fatalf("NewTaskID() = %q, want six lowercase base36 characters", id)
		}
	}
}

func TestTaskFileNameSupportsPrefixedIDs(t *testing.T) {
	for _, tc := range []struct{ id, want string }{
		{"KN-7F3K9M", "KN-7F3K9M.md"},
		{"abc123", "abc123.md"},
	} {
		if got := TaskFileName(tc.id); got != tc.want {
			t.Errorf("TaskFileName(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}

func TestDeriveTaskIDPrefix(t *testing.T) {
	cases := map[string]string{
		"Knowns":          "KN",   // one word: first two letters
		"knowns":          "KN",   // case is normalized
		"My Cool Project": "MCP",  // several words: initials
		"a b c d e f":     "ABCD", // initials are capped at four
		"my-cool-project": "MCP",  // punctuation separates words
		"42":              "TSK",  // cannot start with a digit
		"":                "TSK",
		"!!!":             "TSK",
		"X":               "TSK", // a single letter is too short to be legal
		// A word that does not start with an ASCII character contributes
		// nothing, so only "Cool" is left, and one letter cannot be a prefix.
		"Über Cool": "TSK",
	}
	for name, want := range cases {
		got := DeriveTaskIDPrefix(name)
		if got != want {
			t.Errorf("DeriveTaskIDPrefix(%q) = %q, want %q", name, got, want)
		}
	}
}

// TestDeriveTaskIDPrefixAlwaysReturnsALegalPrefix is the property that matters:
// whatever a project is called, the result can be used to mint an ID.
func TestDeriveTaskIDPrefixAlwaysReturnsALegalPrefix(t *testing.T) {
	for _, name := range []string{
		"Knowns", "", "42", "!!!", "x", "a very long project name indeed",
		"日本語", "9lives", "A", "AB", "under_score", "  spaced  out  ",
	} {
		prefix := DeriveTaskIDPrefix(name)
		if _, err := NormalizeTaskIDPrefix(prefix); err != nil {
			t.Errorf("DeriveTaskIDPrefix(%q) = %q, which is not a legal prefix: %v", name, prefix, err)
		}
		if _, err := NewPrefixedTaskID(prefix); err != nil {
			t.Errorf("DeriveTaskIDPrefix(%q) = %q, which cannot mint an ID: %v", name, prefix, err)
		}
	}
}
