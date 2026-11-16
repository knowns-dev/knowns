package main

import (
	"os"
	"path/filepath"
	"strings"
)

// version is the exact string `knowns --version` prints after "knowns version ". It is injected
// at build time (-ldflags "-X main.version=0.36.0") and must match the daemon's.
var version = "dev"

// globalRoot mirrors cli/src/runtime/queue.ts globalRoot: $HOME first, then the user's home
// directory (USERPROFILE on Windows), then the temp directory.
func globalRoot() string {
	if h := os.Getenv("HOME"); h != "" {
		return filepath.Join(h, ".knowns")
	}
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return filepath.Join(h, ".knowns")
	}
	return filepath.Join(os.TempDir(), ".knowns")
}

// runtimeRoot is $KNOWNS_RUNTIME_ROOT when set, else <global root>/runtime.
func runtimeRoot() string {
	if v := strings.TrimSpace(os.Getenv("KNOWNS_RUNTIME_ROOT")); v != "" {
		return v
	}
	return filepath.Join(globalRoot(), "runtime")
}

// versionToken replaces every character outside A-Za-z0-9._+- with an underscore, as the daemon
// does for the descriptor file name.
func versionToken(v string) string {
	b := []byte(v)
	for i, c := range b {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '.', c == '_', c == '+', c == '-':
		default:
			b[i] = '_'
		}
	}
	return string(b)
}

func mcpDir() string { return filepath.Join(runtimeRoot(), "mcp") }

func descriptorPath() string {
	return filepath.Join(mcpDir(), "endpoint-"+versionToken(version)+".json")
}

func fallbackLogPath() string { return filepath.Join(mcpDir(), "proxy-fallback.jsonl") }
