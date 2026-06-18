package lsp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const minDotnetMajor = 10

func ResolveDotnet10(ctx context.Context, cfg Config, lookPath func(string) (string, error), runCommand func(context.Context, string, ...string) ([]byte, error), logPath string) (string, error) {
	if lookPath == nil {
		lookPath = func(name string) (string, error) { return "", fmt.Errorf("%s not found", name) }
	}
	if runCommand == nil {
		runCommand = defaultRunCommand
	}
	settings := cfg.LanguageSettings(CSharpLanguageID)
	candidates := dotnetCandidates(settings, lookPath)
	if path, err := firstDotnet10(ctx, candidates, runCommand); err == nil {
		return path, nil
	}

	bootstrap := stringSetting(settings, "dotnetBootstrapCommand")
	if bootstrap != "" {
		name, args := splitCommand(bootstrap)
		if name == "" {
			return "", dotnetRuntimeError("dotnet_bootstrap_invalid", "Configured .NET bootstrap command is empty", "Set settings.lsp.languages.csharp.settings.dotnetBootstrapCommand to a valid command.", logPath, nil)
		}
		if output, err := runCommand(ctx, name, args...); err != nil {
			msg := fmt.Sprintf("Configured .NET bootstrap command failed: %s", strings.TrimSpace(string(output)))
			return "", dotnetRuntimeError("dotnet_bootstrap_failed", msg, "Install .NET SDK 10+ manually or fix dotnetBootstrapCommand.", logPath, err)
		}
		candidates = dotnetCandidates(settings, lookPath)
		if path, err := firstDotnet10(ctx, candidates, runCommand); err == nil {
			return path, nil
		}
	}

	return "", dotnetRuntimeError(
		"dotnet_10_missing",
		".NET SDK 10+ is required for Roslyn LS but was not found",
		"Install .NET SDK 10+ or configure settings.lsp.languages.csharp.settings.dotnetPath / dotnetBootstrapCommand.",
		logPath,
		nil,
	)
}

func dotnetRuntimeError(code, message, remediation, logPath string, cause error) *RuntimeError {
	return &RuntimeError{
		Code:        code,
		Language:    CSharpLanguageID,
		Backend:     CSharpBackendRoslyn,
		Message:     message,
		Remediation: remediation,
		LogPath:     logPath,
		Cause:       cause,
	}
}

func dotnetCandidates(settings map[string]any, lookPath func(string) (string, error)) []string {
	var candidates []string
	if path := stringSetting(settings, "dotnetPath"); path != "" {
		candidates = append(candidates, path)
	}
	if dir := stringSetting(settings, "dotnetInstallDir"); dir != "" {
		name := "dotnet"
		if runtime.GOOS == "windows" {
			name = "dotnet.exe"
		}
		candidates = append(candidates, filepath.Join(dir, name))
	}
	if path, err := lookPath("dotnet"); err == nil && path != "" {
		candidates = append(candidates, path)
	}
	return dedupeStrings(candidates)
}

func firstDotnet10(ctx context.Context, candidates []string, runCommand func(context.Context, string, ...string) ([]byte, error)) (string, error) {
	var lastErr error
	for _, path := range candidates {
		if path == "" {
			continue
		}
		output, err := runCommand(ctx, path, "--version")
		if err != nil {
			lastErr = err
			continue
		}
		major, _, ok := parseMajorMinorVersion(string(output))
		if !ok {
			lastErr = fmt.Errorf("could not parse dotnet version from %q", strings.TrimSpace(string(output)))
			continue
		}
		if major >= minDotnetMajor {
			return path, nil
		}
		lastErr = fmt.Errorf(".NET SDK %d+ required, found %s", minDotnetMajor, strings.TrimSpace(string(output)))
	}
	if lastErr == nil {
		lastErr = os.ErrNotExist
	}
	return "", lastErr
}

func parseMajorMinorVersion(output string) (int, int, bool) {
	match := regexp.MustCompile(`([0-9]+)\.([0-9]+)`).FindStringSubmatch(output)
	if len(match) < 3 {
		return 0, 0, false
	}
	var major, minor int
	if _, err := fmt.Sscanf(match[0], "%d.%d", &major, &minor); err != nil {
		return 0, 0, false
	}
	return major, minor, true
}

func stringSetting(settings map[string]any, key string) string {
	if settings == nil {
		return ""
	}
	if value, ok := settings[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func splitCommand(command string) (string, []string) {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return "", nil
	}
	return parts[0], parts[1:]
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
