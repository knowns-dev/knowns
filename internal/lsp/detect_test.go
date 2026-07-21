package lsp

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestDetectFindsFilesAndAvailableBinaries(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}
	d := NewDetector(NewRegistry(nil))
	d.LookPath = func(name string) (string, error) {
		if name == "gopls" {
			return "/bin/gopls", nil
		}
		return "", errors.New("missing")
	}
	d.RunCheck = func(context.Context, string, ...string) error { return nil }
	commands, err := d.Detect(context.Background(), root, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 || commands[0].Language != "go" || commands[0].Name != "gopls" {
		t.Fatalf("commands = %#v, want gopls go", commands)
	}
}

func TestDetectSilentlySkipsMissingBinaries(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}
	d := NewDetector(NewRegistry(nil))
	d.LookPath = func(string) (string, error) { return "", errors.New("missing") }
	d.RunCheck = func(context.Context, string, ...string) error { t.Fatal("unexpected check"); return nil }
	commands, err := d.Detect(context.Background(), root, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("commands = %#v, want none", commands)
	}
}

func TestDetectUsesPATHExistenceWhenBinaryHasNoCheckArgs(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte(`{"enabled":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry([]Language{{
		ID:         "json",
		Name:       "JSON",
		Extensions: []string{".json"},
		Binaries:   []Binary{{Name: "vscode-json-languageserver", Args: []string{"--stdio"}}},
	}})
	d := NewDetector(registry)
	d.LookPath = func(name string) (string, error) {
		if name != "vscode-json-languageserver" {
			t.Fatalf("LookPath(%q), want vscode-json-languageserver", name)
		}
		return "/opt/knowns/bin/vscode-json-languageserver", nil
	}
	d.RunCheck = func(context.Context, string, ...string) error {
		t.Fatal("RunCheck must not execute a stdio-only server without check arguments")
		return nil
	}

	commands, err := d.Detect(context.Background(), root, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 {
		t.Fatalf("commands = %#v, want one JSON command", commands)
	}
	if got := commands[0]; got.Language != "json" || got.Path != "/opt/knowns/bin/vscode-json-languageserver" {
		t.Fatalf("command = %#v, want JSON PATH backend", got)
	}
}

func TestDetectHonorsConfigOverride(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}
	falseValue := false
	d := NewDetector(NewRegistry(nil))
	d.LookPath = func(string) (string, error) { t.Fatal("unexpected lookpath"); return "", nil }
	commands, err := d.Detect(context.Background(), root, Config{Languages: map[string]LanguageConfig{"go": {Enabled: &falseValue}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 0 {
		t.Fatalf("commands = %#v, want none", commands)
	}
}

func TestDetectedLanguagesUsesOrderedRoutingSignals(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"README.md":        "# Project",
		"settings.json":    `{\"enabled\":true}`,
		"workflow.yaml":    "name: ci",
		"network.tf.json":  `{}`,
		"variables.tfvars": `name = \"demo\"`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	registry := NewRegistry([]Language{
		{ID: "markdown", Name: "Markdown", Extensions: []string{".md"}, LazyStart: true},
		{ID: "json", Name: "JSON", Extensions: []string{".json"}, LazyStart: true},
		{ID: "yaml", Name: "YAML", Extensions: []string{".yaml", ".yml"}, LazyStart: true},
		{ID: "terraform", Name: "Terraform", Extensions: []string{".tf", ".tfvars", ".tf.json", ".tfvars.json"}, LazyStart: true},
	})

	languages, err := NewDetector(registry).DetectedLanguages(root, Config{})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"markdown", "json", "yaml", "terraform"}
	if len(languages) != len(want) {
		t.Fatalf("DetectedLanguages() = %#v, want IDs %#v", languages, want)
	}
	for i, id := range want {
		if languages[i].ID != id {
			t.Fatalf("DetectedLanguages()[%d].ID = %q, want %q", i, languages[i].ID, id)
		}
	}
}

func TestDetectedLanguagesIgnoresGeneratedAndFixtureTrees(t *testing.T) {
	root := t.TempDir()
	paths := []string{
		"fixtures/sample.json",
		"fixture/sample.json",
		"testdata/workflow.yaml",
		"generated/network.tf.json",
		"vendor/config.json",
		"build/generated.yaml",
		".knowns/docs/README.md",
	}
	for _, relative := range paths {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	registry := NewRegistry([]Language{
		{ID: "markdown", Name: "Markdown", Extensions: []string{".md"}},
		{ID: "json", Name: "JSON", Extensions: []string{".json"}},
		{ID: "yaml", Name: "YAML", Extensions: []string{".yaml"}},
		{ID: "terraform", Name: "Terraform", Extensions: []string{".tf.json"}},
	})

	languages, err := NewDetector(registry).DetectedLanguages(root, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if len(languages) != 0 {
		t.Fatalf("DetectedLanguages() = %#v, want ignored trees to detect none", languages)
	}

	for _, relative := range paths[:len(paths)-1] {
		path := filepath.Join(root, filepath.FromSlash(relative))
		if _, ok := registry.ForPath(path); !ok {
			t.Fatalf("explicit ForPath(%q) was excluded", relative)
		}
	}
	knownsPath := filepath.Join(root, filepath.FromSlash(paths[len(paths)-1]))
	if got, ok := registry.ForPath(knownsPath); ok {
		t.Fatalf("explicit .knowns route = %#v, true; want hard exclusion", got)
	}
}

func TestAutoDetectionIgnoredDirIsCaseInsensitive(t *testing.T) {
	for _, name := range []string{"Fixtures", "TESTDATA", "Generated", "VENDOR", "Build", "node_modules"} {
		if !isAutoDetectionIgnoredDir(name) {
			t.Fatalf("isAutoDetectionIgnoredDir(%q) = false", name)
		}
	}
	if isAutoDetectionIgnoredDir("src") {
		t.Fatal("src must not be ignored")
	}
}
