package models

import (
	"encoding/json"
	"testing"
	"time"
)

func TestGitTrackingDefaultsTrackDecisions(t *testing.T) {
	defaults := GitTrackingDefaults()
	if defaults.Decisions == nil || !*defaults.Decisions {
		t.Fatalf("GitTrackingDefaults decisions = %v, want true", defaults.Decisions)
	}
	if defaults.Memories == nil || *defaults.Memories {
		t.Fatalf("GitTrackingDefaults memories = %v, want false", defaults.Memories)
	}
}

func TestGitTrackingModeDefaultsGitIgnoredTrackDecisions(t *testing.T) {
	defaults := GitTrackingModeDefaults("git-ignored")
	if defaults.Decisions == nil || !*defaults.Decisions {
		t.Fatalf("GitTrackingModeDefaults(git-ignored) decisions = %v, want true", defaults.Decisions)
	}
	if defaults.Memories == nil || *defaults.Memories {
		t.Fatalf("GitTrackingModeDefaults(git-ignored) memories = %v, want false", defaults.Memories)
	}
}

func TestDefaultTaskLifecycleSettings(t *testing.T) {
	settings := DefaultTaskLifecycleSettings()
	if !settings.ExcludeDoneFromDefaultRetrieval || !settings.AutoArchive {
		t.Fatalf("default lifecycle booleans = %#v, want both enabled", settings)
	}
	if settings.ArchiveAfter != "30d" {
		t.Fatalf("ArchiveAfter = %q, want 30d", settings.ArchiveAfter)
	}
	if settings.PurgeAfter != nil {
		t.Fatalf("PurgeAfter = %v, want disabled (nil)", settings.PurgeAfter)
	}
}

func TestTaskLifecycleSettingsPartialJSONUsesFieldDefaults(t *testing.T) {
	var project Project
	err := json.Unmarshal([]byte(`{
		"name":"legacy",
		"settings":{"taskLifecycle":{"autoArchive":false}}
	}`), &project)
	if err != nil {
		t.Fatalf("Unmarshal partial lifecycle config: %v", err)
	}

	settings := project.Settings.EffectiveTaskLifecycle()
	if settings.AutoArchive {
		t.Fatal("AutoArchive = true, want explicit false")
	}
	if !settings.ExcludeDoneFromDefaultRetrieval {
		t.Fatal("ExcludeDoneFromDefaultRetrieval = false, want omitted-field default true")
	}
	if settings.ArchiveAfter != "30d" {
		t.Fatalf("ArchiveAfter = %q, want omitted-field default 30d", settings.ArchiveAfter)
	}
	if err := project.Settings.Validate(); err != nil {
		t.Fatalf("Validate partial lifecycle config: %v", err)
	}
}

func TestParseTaskLifecycleDuration(t *testing.T) {
	tests := []struct {
		value string
		want  time.Duration
	}{
		{value: "30d", want: 30 * 24 * time.Hour},
		{value: "0s", want: 0},
		{value: "12h", want: 12 * time.Hour},
	}
	for _, tt := range tests {
		t.Run(tt.value, func(t *testing.T) {
			got, err := ParseTaskLifecycleDuration(tt.value)
			if err != nil {
				t.Fatalf("ParseTaskLifecycleDuration(%q): %v", tt.value, err)
			}
			if got != tt.want {
				t.Fatalf("duration = %s, want %s", got, tt.want)
			}
		})
	}

	for _, value := range []string{"", "-1h", "-1d", "later"} {
		t.Run("invalid_"+value, func(t *testing.T) {
			if _, err := ParseTaskLifecycleDuration(value); err == nil {
				t.Fatalf("ParseTaskLifecycleDuration(%q) succeeded, want error", value)
			}
		})
	}
}
