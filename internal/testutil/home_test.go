package testutil

import (
	"os"
	"testing"
)

func TestTempHomeRedirectsUserHomeDir(t *testing.T) {
	home := TempHome(t)
	got, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("UserHomeDir: %v", err)
	}
	if got != home {
		t.Fatalf("UserHomeDir() = %q, want %q", got, home)
	}
	if os.Getenv("HOME") != home || os.Getenv("USERPROFILE") != home {
		t.Fatalf("HOME=%q USERPROFILE=%q, want both %q", os.Getenv("HOME"), os.Getenv("USERPROFILE"), home)
	}
}
