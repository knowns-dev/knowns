package codegen

import (
	"os"
	"path/filepath"
	"strings"
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
	assertKnFlowSkillSynced(t, filepath.Join(projectRoot, ".agents", "skills"))
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
	assertKnFlowSkillSynced(t, filepath.Join(projectRoot, ".claude", "skills"))
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
	assertKnFlowSkillSynced(t, filepath.Join(projectRoot, ".kiro", "skills"))
}

func TestSyncSkillsToTargetsIncludesKnFlowSkill(t *testing.T) {
	projectRoot := t.TempDir()
	target := filepath.Join(projectRoot, "global", ".agents", "skills")

	if err := SyncSkillsToTargets(map[string]string{"codex": target}); err != nil {
		t.Fatalf("SyncSkillsToTargets returned error: %v", err)
	}

	assertKnFlowSkillSynced(t, target)
}

func assertKnFlowSkillSynced(t *testing.T, skillsDir string) {
	t.Helper()

	data, err := os.ReadFile(filepath.Join(skillsDir, "kn-flow", "SKILL.md"))
	if err != nil {
		t.Fatalf("expected kn-flow skill to sync into %s: %v", skillsDir, err)
	}
	if !strings.Contains(string(data), "name: kn-flow") {
		t.Fatalf("expected kn-flow skill frontmatter in %s", skillsDir)
	}
}
