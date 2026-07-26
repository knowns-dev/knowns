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

func TestDecisionWorkflowRulesSyncToRuntimeCopies(t *testing.T) {
	projectRoot := t.TempDir()
	if err := SyncSkillsForPlatforms(projectRoot, []string{"codex"}); err != nil {
		t.Fatalf("SyncSkillsForPlatforms returned error: %v", err)
	}
	for _, name := range []string{"kn-spec", "kn-plan", "kn-flow", "kn-implement", "kn-review", "kn-verify"} {
		path := filepath.Join(projectRoot, ".agents", "skills", name, "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read synced %s: %v", name, err)
		}
		content := string(data)
		if !strings.Contains(content, "Spec Decision") || !strings.Contains(content, "System Decision") {
			t.Fatalf("synced %s is missing two-domain Decision guidance", name)
		}
		if strings.Contains(content, `"category": "<pattern|decision|convention>"`) {
			t.Fatalf("synced %s still recommends legacy Decision Memory creation", name)
		}
	}
	for _, name := range []string{"kn-implement", "kn-flow", "kn-review", "kn-verify"} {
		path := filepath.Join(projectRoot, ".agents", "skills", name, "SKILL.md")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read synced %s: %v", name, err)
		}
		content := string(data)
		for _, marker := range []string{"System Decision Impact: none", "candidate @decision/<id>"} {
			if !strings.Contains(content, marker) {
				t.Fatalf("synced %s is missing completion marker %q", name, marker)
			}
		}
		if !strings.Contains(content, "Memory category `decision`") {
			t.Fatalf("synced %s does not redirect legacy Decision Memory capture", name)
		}
	}
	extractPath := filepath.Join(projectRoot, ".agents", "skills", "kn-extract", "SKILL.md")
	extractData, err := os.ReadFile(extractPath)
	if err != nil {
		t.Fatalf("read synced kn-extract: %v", err)
	}
	extract := string(extractData)
	if strings.Contains(extract, `"category": "<pattern|decision|convention|failure>"`) ||
		!strings.Contains(extract, "Never create Memory category `decision`") ||
		!strings.Contains(extract, "first-class draft Decision candidate") {
		t.Fatalf("synced kn-extract still recommends legacy Decision Memory creation")
	}
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
