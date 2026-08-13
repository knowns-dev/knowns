package util

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	cacheTTL       = 1 * time.Hour
	fetchTimeout   = 2 * time.Second
	npmRegistryURL = "https://registry.npmjs.org/knowns/latest"
)

type updateCache struct {
	LastChecked   int64  `json:"lastChecked"`
	LatestVersion string `json:"latestVersion"`
}

// CheckForUpdate checks npm registry for a newer version and returns
// a notification string if one is available (empty string if up to date).
// It caches the result for 1 hour at ~/.knowns/cli-cache.json.
//
// This is silent on any error — it should never interfere with normal CLI operation.
func CheckForUpdate() string {
	if shouldSkipUpdateCheck() {
		return ""
	}

	cachePath := getCachePath()
	cached := readUpdateCache(cachePath)

	var latest string
	if cached != nil && time.Since(time.UnixMilli(cached.LastChecked)) < cacheTTL {
		latest = cached.LatestVersion
	} else {
		fetched := FetchLatestVersion()
		if fetched == "" {
			return ""
		}
		latest = fetched
		writeUpdateCache(cachePath, &updateCache{
			LastChecked:   time.Now().UnixMilli(),
			LatestVersion: fetched,
		})
	}

	if latest == "" || CompareVersions(latest, Version) <= 0 {
		return ""
	}

	return formatUpdateNotification(latest, Version)
}

func shouldSkipUpdateCheck() bool {
	return !ShouldCheckForUpdate(os.Args[1:])
}

// ShouldCheckForUpdate reports whether a CLI invocation may run the background
// update check. Machine-readable output and non-interactive environments must
// remain free of asynchronous notices.
func ShouldCheckForUpdate(args []string) bool {
	if os.Getenv("NO_UPDATE_CHECK") == "1" {
		return false
	}
	if os.Getenv("CI") != "" {
		return false
	}
	for _, arg := range args {
		switch arg {
		case "--plain", "--json", "update":
			return false
		}
	}
	return true
}

func formatUpdateNotification(latest, current string) string {
	return fmt.Sprintf("\n UPDATE  %s available (current %s) → knowns update\n",
		NormalizeVersionTag(latest),
		NormalizeVersionTag(current),
	)
}

func getCachePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".knowns", "cli-cache.json")
}

func readUpdateCache(path string) *updateCache {
	if path == "" {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var c updateCache
	if err := json.Unmarshal(data, &c); err != nil {
		return nil
	}
	return &c
}

func writeUpdateCache(path string, c *updateCache) {
	if path == "" {
		return
	}
	dir := filepath.Dir(path)
	os.MkdirAll(dir, 0755)
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	os.WriteFile(path, data, 0644)
}

// FetchLatestVersion fetches the latest version string from the npm registry.
// Returns empty string on any error.
func FetchLatestVersion() string {
	client := &http.Client{Timeout: fetchTimeout}
	resp, err := client.Get(npmRegistryURL)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var result struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return ""
	}
	return result.Version
}

// CompareVersions compares two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal.
func CompareVersions(a, b string) int {
	a = strings.TrimPrefix(a, "v")
	b = strings.TrimPrefix(b, "v")

	partsA := strings.Split(a, ".")
	partsB := strings.Split(b, ".")

	maxLen := len(partsA)
	if len(partsB) > maxLen {
		maxLen = len(partsB)
	}

	for i := 0; i < maxLen; i++ {
		var va, vb int
		if i < len(partsA) {
			va, _ = strconv.Atoi(partsA[i])
		}
		if i < len(partsB) {
			vb, _ = strconv.Atoi(partsB[i])
		}
		if va > vb {
			return 1
		}
		if va < vb {
			return -1
		}
	}
	return 0
}

// InstallMethod describes how knowns was installed.
type InstallMethod string

const (
	InstallMethodScript  InstallMethod = "script"
	InstallMethodBrew    InstallMethod = "brew"
	InstallMethodNPM     InstallMethod = "npm"
	InstallMethodBun     InstallMethod = "bun"
	InstallMethodYarn    InstallMethod = "yarn"
	InstallMethodPNPM    InstallMethod = "pnpm"
	InstallMethodUnknown InstallMethod = "unknown"
)

// DetectInstallMethod returns the detected install method and the corresponding
// upgrade command. It prioritizes runtime detection (binary path, environment)
// over persisted metadata, so switching install methods (e.g. script → brew)
// is detected correctly without stale install.json data.
func DetectInstallMethod() (InstallMethod, string) {
	// 1. Collect candidate paths: current executable + resolved symlink.
	candidates := []string{}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, exe)
		if real, err := filepath.EvalSymlinks(exe); err == nil && real != exe {
			candidates = append(candidates, real)
		}
	}
	// Also check persisted binary path from install.json.
	meta, _ := LoadInstallMetadata()
	if meta != nil && meta.BinaryPath != "" {
		candidates = append(candidates, meta.BinaryPath)
	}

	home, _ := os.UserHomeDir()

	// 2. Detect from binary path (most reliable).
	// Normalize to forward slashes for consistent matching across platforms.
	for _, path := range candidates {
		pathLower := strings.ToLower(filepath.ToSlash(path))

		// Homebrew (macOS/Linux only)
		if strings.Contains(pathLower, "/homebrew/") || strings.Contains(pathLower, "/cellar/") || strings.Contains(pathLower, "/linuxbrew/") {
			return InstallMethodBrew, "brew upgrade knowns-dev/tap/knowns"
		}

		// Package managers from path
		switch {
		case strings.Contains(pathLower, "/pnpm/") || strings.Contains(pathLower, "/pnpm-global/") || strings.Contains(pathLower, "\\pnpm\\"):
			return InstallMethodPNPM, "pnpm add -g knowns"
		case strings.Contains(pathLower, "/.yarn/") || strings.Contains(pathLower, "/yarn/"):
			return InstallMethodYarn, "yarn global add knowns"
		case strings.Contains(pathLower, "/.bun/") || strings.Contains(pathLower, "/bun/"):
			return InstallMethodBun, "bun add -g knowns"
		case strings.Contains(pathLower, "/npm/") || strings.Contains(pathLower, "/node_modules/"):
			return InstallMethodNPM, "npm i -g knowns"
		}

		// Script install: binary in ~/.knowns/bin/
		if home != "" {
			defaultDir := filepath.ToSlash(filepath.Join(home, ".knowns", "bin"))
			if strings.HasPrefix(pathLower, strings.ToLower(defaultDir)+"/") ||
				pathLower == strings.ToLower(defaultDir+"/knowns") ||
				pathLower == strings.ToLower(defaultDir+"/knowns.exe") {
				return InstallMethodScript, "knowns update"
			}
		}
	}

	// 3. Check npm_config_user_agent (set when running via npx/npm scripts).
	ua := os.Getenv("npm_config_user_agent")
	switch {
	case strings.HasPrefix(ua, "pnpm/"):
		return InstallMethodPNPM, "pnpm add -g knowns"
	case strings.HasPrefix(ua, "yarn/"):
		return InstallMethodYarn, "yarn global add knowns"
	case strings.HasPrefix(ua, "bun/"):
		return InstallMethodBun, "bun add -g knowns"
	case strings.HasPrefix(ua, "npm/"):
		return InstallMethodNPM, "npm i -g knowns"
	}

	// 4. Fallback to persisted metadata (only if runtime detection found nothing).
	if meta != nil {
		if meta.ManagedBy != "" {
			switch {
			case meta.IsScriptManaged():
				return InstallMethodScript, "knowns update"
			case strings.Contains(meta.ManagedBy, "brew"):
				return InstallMethodBrew, "brew upgrade knowns-dev/tap/knowns"
			case strings.Contains(meta.ManagedBy, "bun"):
				return InstallMethodBun, "bun add -g knowns"
			case strings.Contains(meta.ManagedBy, "pnpm"):
				return InstallMethodPNPM, "pnpm add -g knowns"
			case strings.Contains(meta.ManagedBy, "yarn"):
				return InstallMethodYarn, "yarn global add knowns"
			case strings.Contains(meta.ManagedBy, "npm"):
				return InstallMethodNPM, "npm i -g knowns"
			}
		}
		if meta.Method == "script" {
			return InstallMethodScript, "knowns update"
		}
	}

	// 5. Last resort: check if install.json exists at all.
	if home != "" {
		installJSON := filepath.Join(home, ".knowns", "install.json")
		if _, err := os.Stat(installJSON); err == nil {
			return InstallMethodScript, "knowns update"
		}
	}

	return InstallMethodUnknown, ""
}

// DetectInstallCmd returns the appropriate upgrade command based on how knowns was installed.
func DetectInstallCmd() string {
	_, cmd := DetectInstallMethod()
	if cmd == "" {
		return "npm i -g knowns"
	}
	return cmd
}
