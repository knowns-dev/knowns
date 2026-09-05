package doctor

import (
	"context"
	"fmt"
	"github.com/howznguyen/knowns/internal/models"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/howznguyen/knowns/internal/runtimeinstall"
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
	checkers := []Checker{
		aiInstructionsChecker(state),
		aiPlatformConfigChecker(state),
		aiSkillsChecker(state),
	}
	return append(checkers, aiRuntimeHookCheckers(state)...)
}

func aiRuntimeHookCheckers(state *localState) []Checker {
	runtimes := runtimeinstall.RuntimeNames()
	checkers := make([]Checker, 0, len(runtimes))
	for _, name := range runtimes {
		runtimeName := name
		checkers = append(checkers, Checker{
			ID:    "ai.runtime-hook." + runtimeName,
			Scope: ScopeAI,
			Check: func(context.Context) (CheckResult, error) {
				if state.store == nil {
					return skippedForMissingProject(), nil
				}
				project, err := state.projectConfig()
				if err != nil {
					return CheckResult{}, err
				}
				statuses, err := state.runtimeHookSnapshot()
				if err != nil {
					return CheckResult{}, err
				}
				status, found := runtimeHookStatus(statuses, runtimeName)
				if !found {
					return subsystemDisabled(
						fmt.Sprintf("%s runtime hook status is unavailable", runtimeName),
						"status_unavailable",
					), nil
				}

				configured := runtimeConfigured(project.Settings.Platforms, runtimeName)
				evidence := Evidence{
					"runtime":     status.Runtime,
					"displayName": status.DisplayName,
					"hookKind":    status.HookKind,
					"configured":  configured,
					"available":   status.Available,
					"state":       status.State,
				}
				if !configured && !status.Available {
					return CheckResult{
						Status:     StatusSkip,
						Summary:    fmt.Sprintf("%s runtime hook is not configured or available", status.DisplayName),
						Evidence:   evidence,
						SkipReason: "runtime_not_configured_or_available",
					}, nil
				}
				if status.Installed {
					return CheckResult{
						Status:   StatusPass,
						Summary:  fmt.Sprintf("%s Knowns runtime-memory hook is installed", status.DisplayName),
						Evidence: evidence,
					}, nil
				}

				evidence["statusSummary"] = status.Summary
				description := fmt.Sprintf(
					"Install or refresh the Knowns runtime-memory hook for %s.",
					status.DisplayName,
				)
				if !status.Available {
					description = fmt.Sprintf(
						"Install %s, then install or refresh its Knowns runtime-memory hook.",
						status.DisplayName,
					)
				}
				return CheckResult{
					Status:   StatusWarn,
					Summary:  fmt.Sprintf("%s Knowns runtime-memory hook is missing or out of sync", status.DisplayName),
					Evidence: evidence,
					Remediation: &Remediation{
						Description: description,
						Command:     "knowns runtime install " + status.Runtime,
					},
				}, nil
			},
		})
	}
	return checkers
}

func runtimeHookStatus(statuses []runtimeinstall.Status, runtimeName string) (runtimeinstall.Status, bool) {
	for _, status := range statuses {
		if status.Runtime == runtimeName {
			return status, true
		}
	}
	return runtimeinstall.Status{}, false
}

func runtimeConfigured(platforms []string, runtimeName string) bool {
	for _, platform := range platforms {
		platform = strings.TrimSpace(strings.ToLower(platform))
		if platform == "claude" {
			platform = "claude-code"
		}
		if platform == runtimeName {
			return true
		}
	}
	return false
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
			expected := make([]string, 0, len(platforms))
			for _, platform := range platforms {
				if file := platformInstructionFiles[platform]; file != "" {
					expected = append(expected, file)
				}
			}
			expected = normalizedStrings(expected)
			if len(expected) == 0 {
				expected = existingPaths(projectRoot, allInstructionFiles, state.deps.exists)
			}
			if len(expected) == 0 {
				return subsystemDisabled("No local AI instruction integration is configured", "not_configured"), nil
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
				if !strings.Contains(string(data), knownsGuidelinesStart) ||
					!strings.Contains(string(data), knownsGuidelinesEnd) {
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
						Command:     "knowns sync --instructions",
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
			scope := models.ResolveSkillsScope(project.Settings.SkillsScope, state.deps.globalScope())

			// A project whose scope is not "project" is not supposed to hold
			// skill directories, so their absence is the configured state and
			// never a fault. Reporting it as missing would produce a warning
			// that `knowns sync --skills` can never clear.
			var expected []string
			if scope == models.SkillsScopeProject {
				expected = skillDirsForPlatforms(platforms)
				if len(platforms) == 0 {
					expected = existingPaths(projectRoot, []string{
						filepath.Join(".claude", "skills"),
						filepath.Join(".agents", "skills"),
						filepath.Join(".kiro", "skills"),
					}, state.deps.exists)
				}
			}

			// The state that motivated this check: skills live globally, yet a
			// project copy is also present. The project copy wins at runtime,
			// so the global install the user configured is silently overridden
			// and neither directory looks wrong on its own.
			shadowing := make([]string, 0)
			if scope != models.SkillsScopeProject {
				shadowing = existingPaths(projectRoot, []string{
					filepath.Join(".claude", "skills"),
					filepath.Join(".agents", "skills"),
					filepath.Join(".kiro", "skills"),
				}, state.deps.exists)
			}

			// User-level skills are installed by `setup --global` and are never
			// touched by a project sync, so they drift silently after an upgrade.
			// They are checked even when this project syncs no skills of its own.
			globalStale := homeRelativePaths(state.deps.globalSkills())

			if len(expected) == 0 && len(globalStale) == 0 && len(shadowing) == 0 {
				return subsystemDisabled("No configured AI platform requires synchronized skills", "not_applicable"), nil
			}

			missing := make([]string, 0)
			for _, relativePath := range expected {
				if !state.deps.exists(filepath.Join(projectRoot, relativePath)) {
					missing = append(missing, filepath.ToSlash(relativePath))
				}
			}
			sort.Strings(missing)
			outOfSync := len(expected) > 0 && len(missing) == 0 && state.deps.skillsOutOfSync(projectRoot)
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
			if len(globalStale) > 0 {
				evidence["globalStalePaths"] = globalStale
			}
			evidence["skillsScope"] = scope
			if len(shadowing) > 0 {
				evidence["shadowingPaths"] = slashPaths(shadowing)
				return CheckResult{
					Status:  StatusWarn,
					Summary: fmt.Sprintf("Project skill directories shadow the %s install", scope),
					Remediation: &Remediation{
						Description: fmt.Sprintf("settings.skillsScope is %q, but this project still holds skill directories. A project copy takes precedence over the global one, so the configured install is overridden.", scope),
						Command:     "rm -rf " + strings.Join(slashPaths(shadowing), " "),
					},
					Evidence: evidence,
				}, nil
			}

			projectNeedsSync := len(missing) > 0 || outOfSync
			if projectNeedsSync || len(globalStale) > 0 {
				summary := "AI skills are missing or out of sync"
				// `knowns sync` with no flag also downloads the embedding model
				// and rebuilds the whole search index, which is far more than a
				// stale SKILL.md warrants. `--skills` does only what is broken.
				description := "Synchronize built-in skills for the configured AI platforms."
				if len(globalStale) > 0 {
					// `knowns sync` leaves the user-level copies untouched, so
					// naming only that command sends the user around the loop
					// twice when both scopes have drifted.
					description += " Then run `knowns setup " + globalSetupTarget(globalStale) + " --global` for the user-level copies."
				}
				remediation := &Remediation{
					Description: description,
					Command:     "knowns sync --skills",
				}
				// A project sync never rewrites the user-level copies, so a
				// global-only drift needs the global setup command instead.
				if !projectNeedsSync {
					summary = "User-level AI skills are out of sync"
					remediation = &Remediation{
						Description: "Re-run global setup so user-level skills match this binary.",
						Command:     "knowns setup " + globalSetupTarget(globalStale) + " --global",
					}
				}
				return CheckResult{
					Status:      StatusWarn,
					Summary:     summary,
					Evidence:    evidence,
					Remediation: remediation,
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

// homeRelativePaths rewrites absolute home paths to a ~ prefix so evidence stays
// readable and does not leak the account name into shared diagnostics output.
func homeRelativePaths(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	home, err := os.UserHomeDir()
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if err == nil && home != "" && strings.HasPrefix(path, home+string(filepath.Separator)) {
			path = "~" + path[len(home):]
		}
		out = append(out, filepath.ToSlash(path))
	}
	sort.Strings(out)
	return out
}

// globalSetupTarget picks the setup target to name in the remediation command
// from the stale user-level directories.
func globalSetupTarget(stalePaths []string) string {
	for _, path := range stalePaths {
		switch {
		case strings.Contains(path, "/.claude/"):
			return "claude"
		case strings.Contains(path, "/.kiro/"):
			return "kiro"
		}
	}
	return "agents"
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
