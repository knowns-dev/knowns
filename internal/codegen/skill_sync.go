package codegen

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	instructionskills "github.com/howznguyen/knowns/internal/instructions/skills"
)

// skillRootsUnder returns the three platform skill directories under root.
func skillRootsUnder(root string) []string {
	return []string{
		filepath.Join(root, ".claude", "skills"),
		filepath.Join(root, ".agents", "skills"),
		filepath.Join(root, ".kiro", "skills"),
	}
}

// StaleSkillDirs reports which of the given directories hold skill copies that
// differ from the embedded set. Directories that do not exist are skipped: a
// platform that was never synced is not stale, it is simply absent.
//
// Every existing directory is inspected. Checking only the first one would hide
// a stale .agents/skills behind an up-to-date .claude/skills, which is exactly
// the drift a user cannot see for themselves.
func StaleSkillDirs(dirs []string) []string {
	skillDirs, err := listSkillDirs()
	if err != nil || len(skillDirs) == 0 {
		return nil
	}

	stale := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		if dirIsStale(dir, skillDirs) {
			stale = append(stale, dir)
		}
	}
	if len(stale) == 0 {
		return nil
	}
	return stale
}

// dirIsStale compares every embedded SKILL.md against its on-disk copy in dir.
// A skill added to the binary but absent on disk counts as stale, which is how
// a newly introduced skill gets reported instead of silently missing.
func dirIsStale(dir string, skillDirs []string) bool {
	for _, skillDir := range skillDirs {
		embeddedPath := filepath.ToSlash(filepath.Join(skillDir, "SKILL.md"))
		embeddedData, err := fs.ReadFile(instructionskills.Files, embeddedPath)
		if err != nil {
			continue
		}

		diskData, err := os.ReadFile(filepath.Join(dir, skillDir, "SKILL.md"))
		if err != nil {
			return true // file missing on disk → out of sync
		}

		if !bytes.Equal(embeddedData, diskData) {
			return true
		}
	}
	return false
}

// SkillsOutOfSync returns true if any embedded skill SKILL.md differs from the
// on-disk version in a project-level platform directory. This is a fast
// content-based check — no version files needed.
func SkillsOutOfSync(projectRoot string) bool {
	return len(StaleSkillDirs(skillRootsUnder(projectRoot))) > 0
}

// GlobalStaleSkillDirs reports user-level skill directories that have drifted
// from the embedded set. `knowns setup <target> --global` installs skills under
// the home directory, and those copies are never refreshed by a project sync,
// so they go stale after an upgrade with nothing to signal it.
//
// This cannot detect a binary that predates a skill added in source. The
// embedded set is the binary, so from inside it the two are the same thing.
func GlobalStaleSkillDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	return StaleSkillDirs(skillRootsUnder(home))
}

// BuiltInSkillCount returns the number of embedded built-in skills.
func BuiltInSkillCount() (int, error) {
	skillDirs, err := listSkillDirs()
	if err != nil {
		return 0, err
	}
	return len(skillDirs), nil
}

// platformNeedsClaudeSkills returns true if the platform writes to .claude/skills/.
func platformNeedsClaudeSkills(p string) bool {
	return p == "claude-code"
}

// platformNeedsAgentSkills returns true if the platform writes to .agents/skills/.
func platformNeedsAgentSkills(p string) bool {
	return p == "agents" || p == "opencode" || p == "antigravity" || p == "codex" || p == "cursor" || p == "gemini" || p == "hermes"
}

// platformNeedsKiroSkills returns true if the platform writes to .kiro/skills/.
func platformNeedsKiroSkills(p string) bool {
	return p == "kiro"
}

// SyncSkillsForPlatforms copies embedded built-in skills only to the directories
// required by the given platforms. If platforms is empty, all directories are synced
// (backwards-compatible behaviour matching SyncSkills).
func SyncSkillsForPlatforms(projectRoot string, platforms []string) error {
	wantClaude := len(platforms) == 0
	wantAgent := len(platforms) == 0
	wantKiro := len(platforms) == 0
	for _, p := range platforms {
		if platformNeedsClaudeSkills(p) {
			wantClaude = true
		}
		if platformNeedsAgentSkills(p) {
			wantAgent = true
		}
		if platformNeedsKiroSkills(p) {
			wantKiro = true
		}
	}

	var targets []string
	if wantClaude {
		targets = append(targets, filepath.Join(projectRoot, ".claude", "skills"))
	}
	if wantAgent {
		targets = append(targets, filepath.Join(projectRoot, ".agents", "skills"))
	}
	if wantKiro {
		targets = append(targets, filepath.Join(projectRoot, ".kiro", "skills"))
	}
	if len(targets) == 0 {
		return nil
	}

	skillDirs, err := listSkillDirs()
	if err != nil {
		return fmt.Errorf("list embedded skills: %w", err)
	}

	for _, targetDir := range targets {
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			return fmt.Errorf("create target dir %s: %w", targetDir, err)
		}
		for _, skillDir := range skillDirs {
			dst := filepath.Join(targetDir, skillDir)
			if err := os.RemoveAll(dst); err != nil {
				return fmt.Errorf("reset target skill %s: %w", dst, err)
			}
			if err := copyEmbeddedDir(skillDir, dst); err != nil {
				return fmt.Errorf("copy skill %s to %s: %w", skillDir, targetDir, err)
			}
		}
	}
	return nil
}

// SyncSkillsToTargets syncs embedded skills to arbitrary target directories.
// The targets map is keyed by platform name (e.g., "claude-code") with values being absolute paths.
func SyncSkillsToTargets(targets map[string]string) error {
	if len(targets) == 0 {
		return nil
	}

	skillDirs, err := listSkillDirs()
	if err != nil {
		return fmt.Errorf("list embedded skills: %w", err)
	}

	for platform, targetDir := range targets {
		if !platformNeedsClaudeSkills(platform) && !platformNeedsAgentSkills(platform) && !platformNeedsKiroSkills(platform) {
			continue
		}
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			return fmt.Errorf("create target dir %s: %w", targetDir, err)
		}
		for _, skillDir := range skillDirs {
			dst := filepath.Join(targetDir, skillDir)
			if err := os.RemoveAll(dst); err != nil {
				return fmt.Errorf("reset target skill %s: %w", dst, err)
			}
			if err := copyEmbeddedDir(skillDir, dst); err != nil {
				return fmt.Errorf("copy skill %s to %s: %w", skillDir, targetDir, err)
			}
		}
	}
	return nil
}

// SyncSkills copies embedded built-in skills into the project-local AI platform folders.
func SyncSkills(projectRoot string) error {
	skillDirs, err := listSkillDirs()
	if err != nil {
		return fmt.Errorf("list embedded skills: %w", err)
	}

	targets := []string{
		filepath.Join(projectRoot, ".claude", "skills"),
		filepath.Join(projectRoot, ".agents", "skills"),
		filepath.Join(projectRoot, ".kiro", "skills"),
	}

	for _, targetDir := range targets {
		if err := os.MkdirAll(targetDir, 0755); err != nil {
			return fmt.Errorf("create target dir %s: %w", targetDir, err)
		}

		for _, skillDir := range skillDirs {
			dst := filepath.Join(targetDir, skillDir)
			if err := os.RemoveAll(dst); err != nil {
				return fmt.Errorf("reset target skill %s: %w", dst, err)
			}
			if err := copyEmbeddedDir(skillDir, dst); err != nil {
				return fmt.Errorf("copy skill %s to %s: %w", skillDir, targetDir, err)
			}
		}

	}

	return nil
}

func listSkillDirs() ([]string, error) {
	entries, err := fs.ReadDir(instructionskills.Files, ".")
	if err != nil {
		return nil, err
	}

	var skillDirs []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := fs.Stat(instructionskills.Files, filepath.ToSlash(filepath.Join(entry.Name(), "SKILL.md"))); err == nil {
			skillDirs = append(skillDirs, entry.Name())
		}
	}

	return skillDirs, nil
}

func copyEmbeddedDir(src, dst string) error {
	entries, err := fs.ReadDir(instructionskills.Files, src)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0755); err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.ToSlash(filepath.Join(src, entry.Name()))
		dstPath := filepath.Join(dst, entry.Name())

		if entry.IsDir() {
			if err := copyEmbeddedDir(srcPath, dstPath); err != nil {
				return err
			}
			continue
		}

		if err := copyEmbeddedFile(srcPath, dstPath); err != nil {
			return err
		}
	}

	return nil
}

// copyEmbeddedFile copies an embedded file to dst, creating parent directories as needed.
func copyEmbeddedFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	in, err := instructionskills.Files.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
	}()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Sync()
}
