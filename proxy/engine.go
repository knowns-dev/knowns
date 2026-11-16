package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// The knowns command is this launcher (spec mcp-thin-proxy D10). Everything but `mcp --stdio` is
// handed to the TypeScript engine, a separate binary named knowns-engine[.exe] that is installed
// beside the launcher.

func engineName() string {
	if isWindows {
		return "knowns-engine.exe"
	}
	return "knowns-engine"
}

// launcherPath is this executable with symlinks resolved, so a link in /usr/local/bin still finds
// the engine in the directory the launcher really lives in. The Windows kn.exe is a copy and is
// found the same way.
func launcherPath() string {
	self, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(self); err == nil {
		self = r
	}
	if abs, err := filepath.Abs(self); err == nil {
		self = abs
	}
	return self
}

var errNoEngine = errors.New("the knowns engine was not found")

// findEngine returns the engine to run. KNOWNS_ENGINE_BIN names one explicitly (tests, development;
// KNOWNS_PROXY_KNOWNS_BIN is the older spelling), else knowns-engine beside the launcher, else in
// the npm platform package next to it. It never searches PATH: `knowns` there is this launcher.
func findEngine() (string, error) {
	for _, k := range []string{"KNOWNS_ENGINE_BIN", "KNOWNS_PROXY_KNOWNS_BIN"} {
		if v := os.Getenv(k); v != "" {
			return v, nil
		}
	}
	self := launcherPath()
	if self == "" {
		return "", errNoEngine
	}
	dir := filepath.Dir(self)
	pkg := "@knowns/" + npmPlatform()
	for _, d := range []string{
		dir,
		filepath.Join(dir, "..", "node_modules", filepath.FromSlash(pkg)),
		filepath.Join(dir, "node_modules", filepath.FromSlash(pkg)),
	} {
		p := filepath.Join(d, engineName())
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", errNoEngine
}

func npmPlatform() string {
	os := runtime.GOOS
	if os == "windows" {
		os = "win"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return os + "-" + arch
}

// reinstallHint is the command that puts a working install back, guessed from where the launcher
// lives; it says the generic thing when the channel cannot be told.
func reinstallHint(launcher string) string {
	l := strings.ToLower(filepath.ToSlash(launcher))
	switch {
	case strings.Contains(l, "/node_modules/"):
		return "npm i -g knowns"
	case strings.Contains(l, "/cellar/") || strings.Contains(l, "/homebrew/"):
		return "brew reinstall knowns-dev/tap/knowns"
	case isWindows:
		return "irm https://knowns.sh/script/install.ps1 | iex"
	default:
		return "curl -fsSL https://knowns.sh/script/install | sh"
	}
}

// launcherEnv returns env with KNOWNS_LAUNCHER set to this launcher's path, so the engine reports,
// updates and detects its install method by the launcher.
func launcherEnv(env []string) []string {
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !hasKey(e, "KNOWNS_LAUNCHER") {
			out = append(out, e)
		}
	}
	if l := launcherPath(); l != "" {
		out = append(out, "KNOWNS_LAUNCHER="+l)
	}
	return out
}

func engineEnv() []string { return launcherEnv(os.Environ()) }

func hasKey(entry, key string) bool {
	if len(entry) <= len(key) || entry[len(key)] != '=' {
		return false
	}
	if isWindows {
		return strings.EqualFold(entry[:len(key)], key)
	}
	return entry[:len(key)] == key
}

// missingEngine reports the engine problem on stderr and returns the exit code.
func missingEngine(detail string, code int) int {
	launcher := launcherPath()
	msg := "knowns: " + detail + "\nknowns: reinstall to repair it: " + reinstallHint(launcher) + "\n"
	os.Stderr.WriteString(msg)
	return code
}
