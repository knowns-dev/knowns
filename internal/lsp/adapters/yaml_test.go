package adapters

import (
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestYAMLAdapterContracts(t *testing.T) {
	adapter := NewYAMLAdapter()
	var _ lsp.LanguageAdapter = adapter
	var _ lsp.PathMatcherAdapter = adapter
	var _ lsp.LazyStartAdapter = adapter
	var _ lsp.CapabilityBaselineProvider = adapter

	if adapter.ID() != "yaml" || adapter.Name() != "YAML" {
		t.Fatalf("identity = %q/%q, want yaml/YAML", adapter.ID(), adapter.Name())
	}
	if got, want := adapter.Extensions(), []string{".yaml", ".yml"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Extensions() = %#v, want %#v", got, want)
	}
	if !adapter.LazyStart() {
		t.Fatal("LazyStart() = false, want true")
	}
	if adapter.SupportsImplementation() || adapter.SupportsReferences() {
		t.Fatal("YAML adapter must not statically claim implementation or references")
	}
	if got, want := adapter.CapabilityProfile(), lsp.DocumentConfigCapabilityProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CapabilityProfile() = %#v, want %#v", got, want)
	}
}

func TestYAMLAdapterRouting(t *testing.T) {
	adapter := NewYAMLAdapter()
	wantMatchers := []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".yaml", Priority: yamlPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".yml", Priority: yamlPathPriority},
	}
	if got := adapter.PathMatchers(); !reflect.DeepEqual(got, wantMatchers) {
		t.Fatalf("PathMatchers() = %#v, want %#v", got, wantMatchers)
	}

	registry := lsp.NewEmptyRegistry()
	if err := registry.Register(lsp.Language{
		ID:         adapter.ID(),
		Name:       adapter.Name(),
		Extensions: adapter.Extensions(),
		Matchers:   adapter.PathMatchers(),
		LazyStart:  adapter.LazyStart(),
	}); err != nil {
		t.Fatalf("register YAML language: %v", err)
	}

	for _, path := range []string{"service.yaml", "compose.yml", "nested/CONFIG.YAML"} {
		t.Run(path, func(t *testing.T) {
			lang, ok := registry.ForPath(path)
			if !ok || lang.ID != "yaml" {
				t.Fatalf("ForPath(%q) = %q, %v; want yaml", path, lang.ID, ok)
			}
			lang, ok = registry.ForDetection(path)
			if !ok || lang.ID != "yaml" {
				t.Fatalf("ForDetection(%q) = %q, %v; want yaml", path, lang.ID, ok)
			}
		})
	}

	for _, path := range []string{".knowns/config.yaml", `C:\repo\.knowns\config.yml`} {
		t.Run(path+" hard excluded", func(t *testing.T) {
			if lang, ok := registry.ForPath(path); ok {
				t.Fatalf("ForPath(%q) = %q, want no route", path, lang.ID)
			}
			if lang, ok := registry.ForDetection(path); ok {
				t.Fatalf("ForDetection(%q) = %q, want no route", path, lang.ID)
			}
		})
	}

	if lang, ok := registry.ForPath("config.json"); ok {
		t.Fatalf("ForPath(config.json) = %q, want no YAML route", lang.ID)
	}
}

func TestYAMLAdapterRuntimeMetadata(t *testing.T) {
	adapter := NewYAMLAdapter()
	binaries := adapter.Binaries()
	wantBinaries := []lsp.BinaryCandidate{{
		Name: "yaml-language-server",
		Args: []string{"--stdio"},
	}}
	if !reflect.DeepEqual(binaries, wantBinaries) {
		t.Fatalf("Binaries() = %#v, want %#v", binaries, wantBinaries)
	}
	if got, want := adapter.DefaultArgs(), []string{"--stdio"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultArgs() = %#v, want %#v", got, want)
	}

	wantPrerequisites := []lsp.Prerequisite{{
		Name:        "Node.js 12+",
		CheckCmd:    "node --version",
		InstallHint: "Install Node.js 12+ from https://nodejs.org/",
	}}
	if got := adapter.Prerequisites(); !reflect.DeepEqual(got, wantPrerequisites) {
		t.Fatalf("Prerequisites() = %#v, want %#v", got, wantPrerequisites)
	}

	deps := adapter.RuntimeDeps()
	if len(deps) != 1 {
		t.Fatalf("RuntimeDeps() returned %d dependencies, want 1", len(deps))
	}
	dep := deps[0]
	if dep.ID != "yaml-language-server" || dep.Source != "npm" || dep.ArchiveType != "npm" {
		t.Fatalf("managed dependency identity/source = %#v", dep)
	}
	if dep.PackageName != "yaml-language-server" || dep.BinaryName != "yaml-language-server" || !reflect.DeepEqual(dep.Packages, []string{"yaml-language-server"}) {
		t.Fatalf("managed npm package metadata = %#v", dep)
	}
	if dep.Version != yamlLanguageServerVersion || dep.RecommendedVersion != yamlLanguageServerVersion {
		t.Fatalf("managed versions = %q/%q, want %q", dep.Version, dep.RecommendedVersion, yamlLanguageServerVersion)
	}
	if dep.RecommendedIntegrity != yamlLanguageServerIntegrity {
		t.Fatalf("RecommendedIntegrity = %q, want pinned npm integrity", dep.RecommendedIntegrity)
	}
	if !adapter.CanInstall() {
		t.Fatal("CanInstall() = false, want true")
	}

	guide := adapter.InstallGuide()
	if guide.KnownsCmd != "knowns lsp install yaml" || guide.Command != "npm install -g yaml-language-server@"+yamlLanguageServerVersion || guide.URL == "" {
		t.Fatalf("InstallGuide() = %#v", guide)
	}
}
