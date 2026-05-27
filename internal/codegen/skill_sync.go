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

// SkillsOutOfSync returns true if any embedded skill SKILL.md differs from the
// on-disk version in the first platform directory that exists. This is a fast
// content-based check — no version files needed.
func SkillsOutOfSync(projectRoot string) bool {
	candidates := []string{
		filepath.Join(projectRoot, ".claude", "skills"),
		filepath.Join(projectRoot, ".agents", "skills"),
		filepath.Join(projectRoot, ".kiro", "skills"),
	}

	// Find first existing platform dir
	var targetDir string
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			targetDir = c
			break
		}
	}
	if targetDir == "" {
		return false // no skills synced yet — not "out of sync"
	}

	skillDirs, err := listSkillDirs()
	if err != nil || len(skillDirs) == 0 {
		return false
	}

	for _, skillDir := range skillDirs {
		embeddedPath := filepath.ToSlash(filepath.Join(skillDir, "SKILL.md"))
		embeddedData, err := fs.ReadFile(instructionskills.Files, embeddedPath)
		if err != nil {
			continue
		}

		diskPath := filepath.Join(targetDir, skillDir, "SKILL.md")
		diskData, err := os.ReadFile(diskPath)
		if err != nil {
			return true // file missing on disk → out of sync
		}

		if !bytes.Equal(embeddedData, diskData) {
			return true
		}
	}

	return false
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
	return p == "agents" || p == "opencode" || p == "antigravity" || p == "codex"
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
