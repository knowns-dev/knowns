package lsp

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRegistryForPath(t *testing.T) {
	registry := NewRegistry(nil)
	tests := map[string]string{
		"main.go":   "go",
		"app.ts":    "typescript",
		"view.tsx":  "typescriptreact",
		"script.js": "javascript",
		"view.jsx":  "javascriptreact",
		"test.py":   "python",
		"lib.rs":    "rust",
		"README.md": "",
	}
	for path, want := range tests {
		got, ok := registry.ForPath(path)
		if want == "" {
			if ok {
				t.Fatalf("ForPath(%q) = %q, want none", path, got.ID)
			}
			continue
		}
		if !ok || got.ID != want {
			t.Fatalf("ForPath(%q) = %q %v, want %q", path, got.ID, ok, want)
		}
	}
}

func TestRegistryRegisterOverridesByExactIDRefreshesExtensions(t *testing.T) {
	registry := NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}})

	if err := registry.Register(Language{ID: "go", Name: "Custom Go", Extensions: []string{".gox"}}); err != nil {
		t.Fatalf("Register override returned error: %v", err)
	}

	if _, ok := registry.ForPath("main.go"); ok {
		t.Fatalf("old .go extension still mapped after exact-ID override")
	}
	got, ok := registry.ForPath("main.gox")
	if !ok || got.ID != "go" || got.Name != "Custom Go" {
		t.Fatalf("ForPath(main.gox) = %#v %v, want Custom Go override", got, ok)
	}
	languages := registry.Languages()
	if len(languages) != 1 || languages[0].ID != "go" || len(languages[0].Extensions) != 1 || languages[0].Extensions[0] != ".gox" {
		t.Fatalf("Languages() = %#v, want refreshed go entry", languages)
	}
}

func TestRegistryRegisterRejectsExtensionCollision(t *testing.T) {
	registry := NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}})

	err := registry.Register(Language{ID: "other", Name: "Other", Extensions: []string{".go"}})
	if !errors.Is(err, ErrExtensionAlreadyRegistered) {
		t.Fatalf("Register collision error = %v, want ErrExtensionAlreadyRegistered", err)
	}

	got, ok := registry.ForPath("main.go")
	if !ok || got.ID != "go" {
		t.Fatalf("collision changed owner: %#v %v", got, ok)
	}
}

func TestRegistryOrderedMatchersAreRegistrationOrderIndependent(t *testing.T) {
	languages := []Language{
		{ID: "json", Name: "JSON", Extensions: []string{".json"}},
		{ID: "terraform", Name: "Terraform", Extensions: []string{".tf.json", ".tfvars.json"}},
	}

	forward := NewRegistry(languages)
	reverse := NewRegistry([]Language{languages[1], languages[0]})
	for _, registry := range []*Registry{forward, reverse} {
		for path, want := range map[string]string{
			"settings.json":        "json",
			"network.tf.json":      "terraform",
			"prod.tfvars.json":     "terraform",
			"NETWORK.TF.JSON":      "terraform",
			`C:\repo\vars.tf.json`: "terraform",
		} {
			got, ok := registry.ForPath(path)
			if !ok || got.ID != want {
				t.Fatalf("ForPath(%q) = %#v, %v; want %q", path, got, ok, want)
			}
		}
	}
}

func TestRegistryMatchesBashShebang(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "script")
	if err := os.WriteFile(path, []byte("#!/usr/bin/env -S bash -eu\necho ok\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry([]Language{{
		ID:   "bash",
		Name: "Bash",
		Matchers: []PathMatcher{{
			Kind:     PathMatcherShebang,
			Pattern:  "bash",
			Priority: 100,
		}},
	}})

	got, ok := registry.ForPath(path)
	if !ok || got.ID != "bash" {
		t.Fatalf("ForPath(%q) = %#v, %v; want bash", path, got, ok)
	}

	withExtension := filepath.Join(root, "script.txt")
	if err := os.WriteFile(withExtension, []byte("#!/usr/bin/env bash\necho ignored\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := registry.ForPath(withExtension); ok {
		t.Fatalf("ForPath(%q) = %#v, true; shebang routing is extensionless-only", withExtension, got)
	}
}

func TestRegistryShebangRejectsNonRegularAndSymlinkFiles(t *testing.T) {
	root := t.TempDir()
	registry := NewRegistry([]Language{{
		ID:   "bash",
		Name: "Bash",
		Matchers: []PathMatcher{{
			Kind:     PathMatcherShebang,
			Pattern:  "bash",
			Priority: 100,
		}},
	}})

	directory := filepath.Join(root, "directory")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := registry.ForPath(directory); ok {
		t.Fatalf("directory routed through shebang matcher: %#v", got)
	}
	if got, ok := registry.ForPath(os.DevNull); ok {
		t.Fatalf("device routed through shebang matcher: %#v", got)
	}

	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("#!/bin/bash\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	symlink := filepath.Join(root, "linked-script")
	if err := os.Symlink(target, symlink); err != nil {
		t.Logf("symlink unavailable on this platform: %v", err)
		return
	}
	if got, ok := registry.ForPath(symlink); ok {
		t.Fatalf("symlink routed through target shebang: %#v", got)
	}
}

func TestRegistryDetectionSpecificMatcherPreservesExplicitRouting(t *testing.T) {
	registry := NewRegistry([]Language{{
		ID:         "json",
		Name:       "JSON",
		Extensions: []string{".json"},
		Matchers: []PathMatcher{{
			Kind:         PathMatcherExact,
			Pattern:      "package-lock.json",
			Priority:     100,
			ExplicitOnly: true,
		}},
	}})

	if got, ok := registry.ForPath("vendor/package-lock.json"); !ok || got.ID != "json" {
		t.Fatalf("explicit ForPath() = %#v, %v; want json", got, ok)
	}
	if got, ok := registry.ForDetection("vendor/package-lock.json"); ok {
		t.Fatalf("ForDetection() = %#v, true; want excluded", got)
	}
	if got, ok := registry.ForDetection("config.json"); !ok || got.ID != "json" {
		t.Fatalf("ForDetection(config.json) = %#v, %v; want json", got, ok)
	}
}

func TestRegistryKnownsPathIsAlwaysExcluded(t *testing.T) {
	registry := NewRegistry([]Language{{ID: "markdown", Name: "Markdown", Extensions: []string{".md"}}})
	for _, path := range []string{
		".knowns/docs/readme.md",
		"/repo/.knowns/docs/readme.md",
		`C:\repo\.knowns\docs\readme.md`,
		`C:\repo\.KNOWNS\docs\readme.md`,
	} {
		if got, ok := registry.ForPath(path); ok {
			t.Fatalf("ForPath(%q) = %#v, true; .knowns must be excluded", path, got)
		}
		if got, ok := registry.ForDetection(path); ok {
			t.Fatalf("ForDetection(%q) = %#v, true; .knowns must be excluded", path, got)
		}
	}
}
