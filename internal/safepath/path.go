// Package safepath resolves untrusted filesystem paths inside an explicit root.
package safepath

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

var windowsVolumePath = regexp.MustCompile(`^[A-Za-z]:`)

// Resolve resolves an untrusted relative path inside root. Absolute paths,
// parent traversal, Windows volume paths, and symlink escapes are rejected.
func Resolve(root, untrusted string) (string, error) {
	return resolve(root, untrusted, false)
}

// ResolveProject resolves a project path inside root. Native absolute paths
// are accepted only when they still resolve inside root.
func ResolveProject(root, untrusted string) (string, error) {
	return resolve(root, untrusted, true)
}

// ResolveProjectReal is ResolveProject plus canonical symlink resolution. It
// is useful when callers must enforce policy against the final target path.
func ResolveProjectReal(root, untrusted string) (string, error) {
	path, err := resolve(root, untrusted, true)
	if err != nil {
		return "", err
	}
	return resolveProspectivePath(path)
}

func resolve(root, untrusted string, allowContainedAbsolute bool) (string, error) {
	if strings.TrimSpace(untrusted) == "" {
		return "", fmt.Errorf("path is required")
	}
	if strings.IndexByte(untrusted, 0) >= 0 {
		return "", fmt.Errorf("path contains a NUL byte")
	}

	normalized := strings.ReplaceAll(untrusted, `\`, "/")
	if strings.HasPrefix(normalized, "//?/") || strings.HasPrefix(normalized, "//./") {
		return "", fmt.Errorf("path must not use a Windows device prefix")
	}
	windowsAbsolute := windowsVolumePath.MatchString(normalized) || strings.HasPrefix(normalized, "//")
	if windowsAbsolute && !(allowContainedAbsolute && runtime.GOOS == "windows") {
		return "", fmt.Errorf("path must not use a volume or UNC prefix")
	}
	nativePath := filepath.FromSlash(normalized)
	if windowsAbsolute && allowContainedAbsolute && runtime.GOOS == "windows" && !filepath.IsAbs(nativePath) {
		return "", fmt.Errorf("path must not use a drive-relative prefix")
	}
	for i, segment := range strings.Split(normalized, "/") {
		if segment == ".." {
			return "", fmt.Errorf("path must not contain parent traversal")
		}
		// A colon outside the leading drive volume is an NTFS alternate data
		// stream delimiter. Reject it on Windows so the resolved filename is
		// always the file the caller intended to authorize.
		leadingDrive := i == 0 && windowsAbsolute && windowsVolumePath.MatchString(segment)
		if runtime.GOOS == "windows" && strings.Contains(segment, ":") && !leadingDrive {
			return "", fmt.Errorf("path must not use an alternate data stream")
		}
	}

	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve root: %w", err)
	}
	rootAbs = filepath.Clean(rootAbs)

	var candidate string
	if filepath.IsAbs(nativePath) {
		if !allowContainedAbsolute {
			return "", fmt.Errorf("path must be relative")
		}
		candidate = filepath.Clean(nativePath)
	} else {
		candidate = filepath.Join(rootAbs, nativePath)
	}
	if err := requireWithin(rootAbs, candidate); err != nil {
		return "", err
	}
	if _, err := resolveWithin(rootAbs, candidate); err != nil {
		return "", err
	}
	return candidate, nil
}

func resolveWithin(root, candidate string) (string, error) {
	rootResolved, err := resolveProspectivePath(root)
	if err != nil {
		return "", fmt.Errorf("resolve root symlinks: %w", err)
	}
	candidateResolved, err := resolveProspectivePath(candidate)
	if err != nil {
		return "", fmt.Errorf("resolve path symlinks: %w", err)
	}
	if err := requireWithin(rootResolved, candidateResolved); err != nil {
		return "", fmt.Errorf("path escapes root through a symlink: %w", err)
	}
	return candidateResolved, nil
}

func resolveProspectivePath(path string) (string, error) {
	existing := filepath.Clean(path)
	for {
		_, err := os.Lstat(existing)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("inspect path: %w", err)
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return "", fmt.Errorf("path has no existing ancestor")
		}
		existing = parent
	}
	existingResolved, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(existing, path)
	if err != nil {
		return "", err
	}
	return filepath.Join(existingResolved, rel), nil
}

func requireWithin(root, candidate string) error {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return fmt.Errorf("compare path to root: %w", err)
	}
	if rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("path escapes allowed root")
	}
	return nil
}
