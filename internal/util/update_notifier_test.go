package util

import (
	"strings"
	"testing"
)

func TestShouldCheckForUpdate(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("NO_UPDATE_CHECK", "")

	tests := []struct {
		name string
		args []string
		want bool
	}{
		{name: "human readable command", args: []string{"task", "list"}, want: true},
		{name: "plain output", args: []string{"task", "list", "--plain"}, want: false},
		{name: "json output", args: []string{"--json", "task", "list"}, want: false},
		{name: "update command", args: []string{"update", "--check"}, want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ShouldCheckForUpdate(tt.args); got != tt.want {
				t.Fatalf("ShouldCheckForUpdate(%v) = %v, want %v", tt.args, got, tt.want)
			}
		})
	}
}

func TestShouldCheckForUpdateEnvironment(t *testing.T) {
	t.Run("CI", func(t *testing.T) {
		t.Setenv("CI", "true")
		t.Setenv("NO_UPDATE_CHECK", "")
		if ShouldCheckForUpdate([]string{"task", "list"}) {
			t.Fatal("expected CI to suppress update checks")
		}
	})

	t.Run("NO_UPDATE_CHECK", func(t *testing.T) {
		t.Setenv("CI", "")
		t.Setenv("NO_UPDATE_CHECK", "1")
		if ShouldCheckForUpdate([]string{"task", "list"}) {
			t.Fatal("expected NO_UPDATE_CHECK=1 to suppress update checks")
		}
	})
}

func TestFormatUpdateNotificationNormalizesVersionPrefixes(t *testing.T) {
	tests := []struct {
		name    string
		latest  string
		current string
	}{
		{name: "versions without prefixes", latest: "0.29.1", current: "0.28.0"},
		{name: "versions with prefixes", latest: "v0.29.1", current: "v0.28.0-19-ga7bbda7"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatUpdateNotification(tt.latest, tt.current)
			if !strings.Contains(got, "UPDATE  v0.29.1 available (current v0.28.0") {
				t.Fatalf("unexpected update notification: %q", got)
			}
			if strings.Contains(got, "vv0.") {
				t.Fatalf("notification contains duplicate version prefix: %q", got)
			}
		})
	}
}
