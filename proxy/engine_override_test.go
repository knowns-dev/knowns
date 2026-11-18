package main

import (
	"os"
	"testing"
)

// The test binary may point the launcher at a fake engine. Release builds do not contain this.
func init() {
	engineOverride = func() string { return os.Getenv("KNOWNS_ENGINE_BIN") }
}

// A release launcher ignores KNOWNS_ENGINE_BIN and KNOWNS_PROXY_KNOWNS_BIN.
func TestReleaseEngineOverrideIsEmpty(t *testing.T) {
	saved := engineOverride
	defer func() { engineOverride = saved }()
	engineOverride = func() string { return "" } // what a release build has
	t.Setenv("KNOWNS_ENGINE_BIN", "/tmp/evil")
	t.Setenv("KNOWNS_PROXY_KNOWNS_BIN", "/tmp/evil")
	if p, _ := findEngine(); p == "/tmp/evil" {
		t.Fatalf("findEngine honoured the environment: %s", p)
	}
}
