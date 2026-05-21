package adapters

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
)

func checkBinary(ctx context.Context, name string, args ...string) error {
	path, err := exec.LookPath(name)
	if err != nil {
		return fmt.Errorf("%s not found in PATH: %w", name, err)
	}
	if len(args) == 0 {
		return nil
	}
	cmd := exec.CommandContext(ctx, path, args...)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func installedPath(adapterID string, deps []lsp.RuntimeDependency) (string, bool) {
	platformID := lsp.CurrentPlatformID()
	for _, dep := range deps {
		if dep.PlatformID != platformID {
			continue
		}
		path := filepath.Join(homeLSPDir(), adapterID, dep.BinaryName+"-"+dep.ID, dep.BinaryName)
		if runtime.GOOS == "windows" {
			if _, err := os.Stat(path + ".exe"); err == nil {
				return path + ".exe", true
			}
		}
		if _, err := os.Stat(path); err == nil {
			return path, true
		}
	}
	return "", false
}

func homeLSPDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".knowns", "lsp-servers")
	}
	return filepath.Join(home, ".knowns", "lsp-servers")
}

func initializationOptions(settings map[string]any) map[string]any {
	if settings == nil {
		return map[string]any{}
	}
	if options, ok := settings["initializationOptions"].(map[string]any); ok {
		return options
	}
	return settings
}

func initializeParams(root string, settings map[string]any) map[string]any {
	return map[string]any{
		"rootUri":               lsp.FileURI(root),
		"initializationOptions": initializationOptions(settings),
	}
}

func isIgnoredDir(name string, ignored map[string]struct{}) bool {
	_, ok := ignored[name]
	return ok
}

func commandOutput(ctx context.Context, name string, args ...string) (string, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return "", fmt.Errorf("%s not found in PATH: %w", name, err)
	}
	cmd := exec.CommandContext(ctx, path, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s failed: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func parseMajorMinor(output string) (int, int, bool) {
	match := regexp.MustCompile(`(?:go|v|Python )?([0-9]+)\.([0-9]+)`).FindStringSubmatch(output)
	if len(match) < 3 {
		return 0, 0, false
	}
	major, errMajor := strconv.Atoi(match[1])
	minor, errMinor := strconv.Atoi(match[2])
	if errMajor != nil || errMinor != nil {
		return 0, 0, false
	}
	return major, minor, true
}

func requireMinVersion(output, name string, minMajor, minMinor int) error {
	major, minor, ok := parseMajorMinor(output)
	if !ok {
		return fmt.Errorf("could not parse %s version from %q", name, output)
	}
	if major < minMajor || (major == minMajor && minor < minMinor) {
		return fmt.Errorf("%s %d.%d+ required, found %d.%d", name, minMajor, minMinor, major, minor)
	}
	return nil
}
