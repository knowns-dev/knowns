package models

import "testing"

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
