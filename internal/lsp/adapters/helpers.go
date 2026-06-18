package adapters

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	return lsp.NewInstaller(homeLSPDir()).IsInstalled(staticAdapter{id: adapterID, deps: deps})
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

// preferredCmd returns the first available command from candidates.
// Each candidate is checked via exec.LookPath in order of preference.
func preferredCmd(candidates ...string) string {
	for _, c := range candidates {
		if _, err := exec.LookPath(c); err == nil {
			return c
		}
	}
	return candidates[len(candidates)-1]
}

type staticAdapter struct {
	lsp.BaseAdapter
	id   string
	deps []lsp.RuntimeDependency
}

func (a staticAdapter) ID() string                                             { return a.id }
func (a staticAdapter) Name() string                                           { return a.id }
func (a staticAdapter) Extensions() []string                                   { return nil }
func (a staticAdapter) Binaries() []lsp.BinaryCandidate                        { return nil }
func (a staticAdapter) Prerequisites() []lsp.Prerequisite                      { return nil }
func (a staticAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a staticAdapter) InstallGuide() lsp.InstallGuide                         { return lsp.InstallGuide{} }
func (a staticAdapter) CanInstall() bool                                       { return len(a.deps) > 0 }
func (a staticAdapter) RuntimeDeps() []lsp.RuntimeDependency                   { return a.deps }
func (a staticAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a staticAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a staticAdapter) DefaultArgs() []string                                  { return nil }
func (a staticAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a staticAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
