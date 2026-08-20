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
	got := TaskFileName("KN-7F3K9M", "Add authentication")
	want := "task-KN-7F3K9M - Add-authentication.md"
	if got != want {
		t.Fatalf("TaskFileName() = %q, want %q", got, want)
	}
}
