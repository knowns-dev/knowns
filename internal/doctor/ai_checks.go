package doctor

import (
	"context"
	"path/filepath"
	"sort"
	"strings"
)

const (
	knownsGuidelinesStart = "<!-- KNOWNS GUIDELINES START -->"
	knownsGuidelinesEnd   = "<!-- KNOWNS GUIDELINES END -->"
)

var platformInstructionFiles = map[string]string{
	"claude-code": "CLAUDE.md",
	"opencode":    "OPENCODE.md",
	"codex":       "AGENTS.md",
	"hermes":      "AGENTS.md",
	"gemini":      "GEMINI.md",
	"copilot":     filepath.Join(".github", "copilot-instructions.md"),
	"agents":      "AGENTS.md",
}

var allInstructionFiles = []string{
	"KNOWNS.md",
	"CLAUDE.md",
	"OPENCODE.md",
	"GEMINI.md",
	"AGENTS.md",
	filepath.Join(".github", "copilot-instructions.md"),
}

var platformConfigFiles = map[string]string{
	"claude-code": filepath.Join(".mcp.json"),
	"opencode":    "opencode.json",
	"codex":       filepath.Join(".codex", "config.toml"),
	"kiro":        filepath.Join(".kiro", "settings", "mcp.json"),
	"cursor":      filepath.Join(".cursor", "mcp.json"),
}

var platformSetupAliases = map[string]string{
	"claude-code": "claude",
	"opencode":    "opencode",
	"codex":       "codex",
	"kiro":        "kiro",
	"cursor":      "cursor",
}

func aiCheckers(state *localState) []Checker {
	return []Checker{
		aiInstructionsChecker(state),
		aiPlatformConfigChecker(state),
		aiSkillsChecker(state),
	}
}

func aiPlatformConfigChecker(state *localState) Checker {
	return Checker{
		ID:    "ai.platform-config",
		Scope: ScopeAI,
		Check: func(context.Context) (CheckResult, error) {
			project, err := state.projectConfig()
			if err != nil {
				return CheckResult{}, err
			}
			projectRoot := filepath.Dir(state.store.Root)
			platforms := normalizedStrings(project.Settings.Platforms)
			expectedByPlatform := make(map[string]string)
			if len(platforms) > 0 {
				for _, platform := range platforms {
					if path := platformConfigFiles[platform]; path != "" {
						expectedByPlatform[platform] = path
					}
				}
			} else {
				for platform, path := range platformConfigFiles {
					if state.deps.exists(filepath.Join(projectRoot, path)) {
						expectedByPlatform[platform] = path
					}
				}
			}
			if len(expectedByPlatform) == 0 {
				return subsystemDisabled("No configured AI platform requires a project config artifact", "not_applicable"), nil
			}

			configuredPlatforms := make([]string, 0, len(expectedByPlatform))
			files := make([]string, 0, len(expectedByPlatform))
			missing := make([]string, 0)
			missingPlatform := ""
			for platform, relativePath := range expectedByPlatform {
				configuredPlatforms = append(configuredPlatforms, platform)
				files = append(files, filepath.ToSlash(relativePath))
				if !state.deps.exists(filepath.Join(projectRoot, relativePath)) {
					missing = append(missing, filepath.ToSlash(relativePath))
					if missingPlatform == "" || platform < missingPlatform {
						missingPlatform = platform
					}
				}
			}
			sort.Strings(configuredPlatforms)
			sort.Strings(files)
			sort.Strings(missing)
			evidence := Evidence{
				"platforms":   configuredPlatforms,
				"configFiles": files,
			}
			if len(missing) > 0 {
				evidence["missingFiles"] = missing
				alias := platformSetupAliases[missingPlatform]
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "Configured AI platform artifacts are missing",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Regenerate the missing project integration artifact.",
						Command:     "knowns setup " + alias,
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "Configured AI platform artifacts are present",
				Evidence: evidence,
			}, nil
		},
	}
}

func aiInstructionsChecker(state *localState) Checker {
	return Checker{
		ID:    "ai.instructions",
		Scope: ScopeAI,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			project, err := state.projectConfig()
			if err != nil {
				return CheckResult{}, err
			}
			projectRoot := filepath.Dir(state.store.Root)
			platforms := normalizedStrings(project.Settings.Platforms)
			expected := []string{"KNOWNS.md"}
			if len(platforms) > 0 {
				for _, platform := range platforms {
					if file := platformInstructionFiles[platform]; file != "" {
						expected = append(expected, file)
					}
				}
				expected = normalizedStrings(expected)
			} else {
				expected = existingPaths(projectRoot, allInstructionFiles, state.deps.exists)
				if len(expected) == 0 {
					return subsystemDisabled("No local AI instruction integration is configured", "not_configured"), nil
				}
			}

			missing := make([]string, 0)
			outOfSync := make([]string, 0)
			for _, relativePath := range expected {
				fullPath := filepath.Join(projectRoot, relativePath)
				if !state.deps.exists(fullPath) {
					missing = append(missing, filepath.ToSlash(relativePath))
					continue
				}
				if state.virtualExists {
					continue
				}
				data, readErr := state.deps.readFile(fullPath)
				if readErr != nil {
					missing = append(missing, filepath.ToSlash(relativePath))
					continue
				}
				if relativePath != "KNOWNS.md" &&
					(!strings.Contains(string(data), knownsGuidelinesStart) ||
						!strings.Contains(string(data), knownsGuidelinesEnd)) {
					outOfSync = append(outOfSync, filepath.ToSlash(relativePath))
				}
			}
			sort.Strings(missing)
			sort.Strings(outOfSync)
			evidence := Evidence{
				"platforms": platforms,
				"files":     slashPaths(expected),
			}
			if len(missing) > 0 || len(outOfSync) > 0 {
				if len(missing) > 0 {
					evidence["missingFiles"] = missing
				}
				if len(outOfSync) > 0 {
					evidence["outOfSyncFiles"] = outOfSync
				}
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "AI instruction artifacts are missing or out of sync",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Synchronize the configured AI platform artifacts.",
						Command:     "knowns sync",
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "AI instruction artifacts are present and synchronized",
				Evidence: evidence,
			}, nil
		},
	}
}

func aiSkillsChecker(state *localState) Checker {
	return Checker{
		ID:    "ai.skills",
		Scope: ScopeAI,
		Check: func(context.Context) (CheckResult, error) {
			if state.store == nil {
				return skippedForMissingProject(), nil
			}
			project, err := state.projectConfig()
			if err != nil {
				return CheckResult{}, err
			}
			projectRoot := filepath.Dir(state.store.Root)
			platforms := normalizedStrings(project.Settings.Platforms)
			expected := skillDirsForPlatforms(platforms)
			if len(platforms) == 0 {
				expected = existingPaths(projectRoot, []string{
					filepath.Join(".claude", "skills"),
					filepath.Join(".agents", "skills"),
					filepath.Join(".kiro", "skills"),
				}, state.deps.exists)
			}
			if len(expected) == 0 {
				return subsystemDisabled("No configured AI platform requires synchronized skills", "not_applicable"), nil
			}

			missing := make([]string, 0)
			for _, relativePath := range expected {
				if !state.deps.exists(filepath.Join(projectRoot, relativePath)) {
					missing = append(missing, filepath.ToSlash(relativePath))
				}
			}
			sort.Strings(missing)
			outOfSync := len(missing) == 0 && state.deps.skillsOutOfSync(projectRoot)
			evidence := Evidence{
				"platforms": platforms,
				"skillDirs": slashPaths(expected),
			}
			if len(missing) > 0 {
				evidence["missingPaths"] = missing
			}
			if outOfSync {
				evidence["outOfSync"] = true
			}
			if len(missing) > 0 || outOfSync {
				return CheckResult{
					Status:   StatusWarn,
					Summary:  "AI skills are missing or out of sync",
					Evidence: evidence,
					Remediation: &Remediation{
						Description: "Synchronize built-in skills for the configured AI platforms.",
						Command:     "knowns sync",
					},
				}, nil
			}
			return CheckResult{
				Status:   StatusPass,
				Summary:  "AI skills are synchronized",
				Evidence: evidence,
			}, nil
		},
	}
}

func skillDirsForPlatforms(platforms []string) []string {
	var dirs []string
	for _, platform := range platforms {
		switch platform {
		case "claude-code":
			dirs = append(dirs, filepath.Join(".claude", "skills"))
		case "kiro":
			dirs = append(dirs, filepath.Join(".kiro", "skills"))
		case "agents", "opencode", "antigravity", "codex", "cursor", "gemini", "hermes":
			dirs = append(dirs, filepath.Join(".agents", "skills"))
		}
	}
	return normalizedStrings(dirs)
}

func existingPaths(root string, candidates []string, exists func(string) bool) []string {
	existing := make([]string, 0)
	for _, candidate := range candidates {
		if exists(filepath.Join(root, candidate)) {
			existing = append(existing, candidate)
		}
	}
	return normalizedStrings(existing)
}

func normalizedStrings(values []string) []string {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			set[value] = true
		}
	}
	normalized := make([]string, 0, len(set))
	for value := range set {
		normalized = append(normalized, value)
	}
	sort.Strings(normalized)
	return normalized
}

func slashPaths(paths []string) []string {
	normalized := make([]string, len(paths))
	for i, path := range paths {
		normalized[i] = filepath.ToSlash(path)
	}
	sort.Strings(normalized)
	return normalized
}
