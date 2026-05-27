package codegen

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSyncSkillsForPlatformsWritesAgentPlatformsToAgentsDir(t *testing.T) {
	projectRoot := t.TempDir()

	if err := SyncSkillsForPlatforms(projectRoot, []string{"opencode", "codex", "antigravity"}); err != nil {
		t.Fatalf("SyncSkillsForPlatforms returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, ".agents", "skills")); err != nil {
		t.Fatalf("expected .agents/skills to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".claude", "skills")); !os.IsNotExist(err) {
		t.Fatalf("expected .claude/skills not to be created, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".kiro", "skills")); !os.IsNotExist(err) {
		t.Fatalf("expected .kiro/skills not to be created, got err=%v", err)
	}
}

func TestSyncSkillsForPlatformsGenericAgentsUsesAgentsDir(t *testing.T) {
	projectRoot := t.TempDir()

	if err := SyncSkillsForPlatforms(projectRoot, []string{"agents"}); err != nil {
		t.Fatalf("SyncSkillsForPlatforms returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, ".agents", "skills")); err != nil {
		t.Fatalf("expected .agents/skills to exist: %v", err)
	}
}

func TestSyncSkillsForPlatformsClaudeWritesToClaudeDir(t *testing.T) {
	projectRoot := t.TempDir()

	if err := SyncSkillsForPlatforms(projectRoot, []string{"claude-code"}); err != nil {
		t.Fatalf("SyncSkillsForPlatforms returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, ".claude", "skills")); err != nil {
		t.Fatalf("expected .claude/skills to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".agents", "skills")); !os.IsNotExist(err) {
		t.Fatalf("expected .agents/skills not to be created for claude-code, got err=%v", err)
	}
}

func TestSyncSkillsForPlatformsKiroWritesToKiroDir(t *testing.T) {
	projectRoot := t.TempDir()

	if err := SyncSkillsForPlatforms(projectRoot, []string{"kiro"}); err != nil {
		t.Fatalf("SyncSkillsForPlatforms returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, ".kiro", "skills")); err != nil {
		t.Fatalf("expected .kiro/skills to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".agents", "skills")); !os.IsNotExist(err) {
		t.Fatalf("expected .agents/skills not to be created for kiro, got err=%v", err)
	}
}
