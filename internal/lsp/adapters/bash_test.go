package adapters

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestBashAdapterContracts(t *testing.T) {
	adapter := NewBashAdapter()
	var _ lsp.LanguageAdapter = adapter
	var _ lsp.PathMatcherAdapter = adapter
	var _ lsp.LazyStartAdapter = adapter
	var _ lsp.CapabilityBaselineProvider = adapter

	if got := adapter.ID(); got != "bash" {
		t.Fatalf("ID() = %q, want bash", got)
	}
	if got := adapter.Name(); got != "Bash" {
		t.Fatalf("Name() = %q, want Bash", got)
	}
	if got, want := adapter.Extensions(), []string{".sh", ".bash"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Extensions() = %#v, want %#v", got, want)
	}
	if !adapter.LazyStart() {
		t.Fatal("LazyStart() = false, want true")
	}
	if got, want := adapter.CapabilityProfile(), lsp.CodeCapabilityProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CapabilityProfile() = %#v, want %#v", got, want)
	}
}

func TestBashAdapterPathMatchers(t *testing.T) {
	adapter := NewBashAdapter()
	want := []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".bash", Priority: 220},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".sh", Priority: 210},
		{Kind: lsp.PathMatcherShebang, Pattern: "bash", Priority: 120},
		{Kind: lsp.PathMatcherShebang, Pattern: "sh", Priority: 110},
	}
	if got := adapter.PathMatchers(); !reflect.DeepEqual(got, want) {
		t.Fatalf("PathMatchers() = %#v, want %#v", got, want)
	}

	registry := lsp.NewEmptyRegistry()
	err := registry.Register(lsp.Language{
		ID:         adapter.ID(),
		Name:       adapter.Name(),
		Extensions: adapter.Extensions(),
		Matchers:   adapter.PathMatchers(),
		LazyStart:  adapter.LazyStart(),
	})
	if err != nil {
		t.Fatalf("register Bash language: %v", err)
	}

	dir := t.TempDir()
	paths := map[string]string{
		"script.sh":   "echo sh\n",
		"script.bash": "echo bash\n",
		"env-bash":    "#!/usr/bin/env bash\necho bash\n",
		"bin-sh":      "#!/bin/sh\necho sh\n",
	}
	for name, content := range paths {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		lang, ok := registry.ForPath(path)
		if !ok || lang.ID != "bash" {
			t.Fatalf("ForPath(%s) = %#v, %v; want bash", name, lang, ok)
		}
	}

	zshPath := filepath.Join(dir, "zsh-script")
	if err := os.WriteFile(zshPath, []byte("#!/usr/bin/env zsh\necho zsh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if lang, ok := registry.ForPath(zshPath); ok {
		t.Fatalf("ForPath(zsh-script) = %#v, true; want no Bash match", lang)
	}
}

func TestBashAdapterCommandPrerequisiteAndManagedMetadata(t *testing.T) {
	adapter := NewBashAdapter()

	binaries := adapter.Binaries()
	wantBinaries := []lsp.BinaryCandidate{{
		Name:      "bash-language-server",
		Args:      []string{"start"},
		CheckArgs: []string{"--version"},
	}}
	if !reflect.DeepEqual(binaries, wantBinaries) {
		t.Fatalf("Binaries() = %#v, want %#v", binaries, wantBinaries)
	}
	if got, want := adapter.DefaultArgs(), []string{"start"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultArgs() = %#v, want %#v", got, want)
	}

	wantPrerequisites := []lsp.Prerequisite{{
		Name:        "Node.js 20+",
		CheckCmd:    "node --version",
		InstallHint: "Install Node.js 20+ from https://nodejs.org/",
	}}
	if got := adapter.Prerequisites(); !reflect.DeepEqual(got, wantPrerequisites) {
		t.Fatalf("Prerequisites() = %#v, want %#v", got, wantPrerequisites)
	}

	deps := adapter.RuntimeDeps()
	if len(deps) != 1 {
		t.Fatalf("RuntimeDeps() returned %d dependencies, want 1", len(deps))
	}
	dep := deps[0]
	if dep.ID != "bash-language-server" || dep.Source != "npm" || dep.ArchiveType != "npm" {
		t.Fatalf("managed dependency identity/source = %#v", dep)
	}
	if dep.PackageName != "bash-language-server" || dep.BinaryName != "bash-language-server" || !reflect.DeepEqual(dep.Packages, []string{"bash-language-server"}) {
		t.Fatalf("managed npm package metadata = %#v", dep)
	}
	if dep.Version != bashLanguageServerVersion || dep.RecommendedVersion != bashLanguageServerVersion {
		t.Fatalf("managed versions = %q/%q, want %q", dep.Version, dep.RecommendedVersion, bashLanguageServerVersion)
	}
	if dep.RecommendedIntegrity != bashLanguageServerIntegrity {
		t.Fatalf("RecommendedIntegrity = %q, want pinned npm integrity", dep.RecommendedIntegrity)
	}
	if dep.RecommendedIntegrity == "" || dep.RecommendedIntegrity[:7] != "sha512-" {
		t.Fatalf("RecommendedIntegrity = %q, want npm sha512 SRI", dep.RecommendedIntegrity)
	}
	if !adapter.CanInstall() {
		t.Fatal("CanInstall() = false, want true")
	}
}
