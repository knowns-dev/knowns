package adapters

import (
	"reflect"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestJSONAdapterContracts(t *testing.T) {
	adapter := NewJSONAdapter()
	var _ lsp.LanguageAdapter = adapter
	var _ lsp.PathMatcherAdapter = adapter
	var _ lsp.LazyStartAdapter = adapter
	var _ lsp.CapabilityBaselineProvider = adapter

	if adapter.ID() != "json" || adapter.Name() != "JSON/JSONC" {
		t.Fatalf("identity = %q/%q, want json/JSON/JSONC", adapter.ID(), adapter.Name())
	}
	if got, want := adapter.Extensions(), []string{".json", ".jsonc"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Extensions() = %#v, want %#v", got, want)
	}
	if !adapter.LazyStart() {
		t.Fatal("LazyStart() = false, want true")
	}
	if adapter.SupportsImplementation() || adapter.SupportsReferences() {
		t.Fatal("JSON adapter must not statically claim implementation or references")
	}

	profile := adapter.CapabilityProfile()
	if got, want := profile.Required, []string{lsp.CapabilityDocumentSymbols, lsp.CapabilityDiagnostics}; !reflect.DeepEqual(got, want) {
		t.Fatalf("CapabilityProfile().Required = %#v, want %#v", got, want)
	}
	if !profile.LegacyPushDiagnostics || !profile.EnforceAdvertised {
		t.Fatalf("CapabilityProfile() = %#v, want enforced legacy diagnostics profile", profile)
	}
}

func TestJSONAdapterRuntimeMetadata(t *testing.T) {
	adapter := NewJSONAdapter()
	binaries := adapter.Binaries()
	if len(binaries) != 1 {
		t.Fatalf("Binaries() returned %d candidates, want 1", len(binaries))
	}
	if got, want := binaries[0].Name, "vscode-json-languageserver"; got != want {
		t.Fatalf("binary name = %q, want %q", got, want)
	}
	if got, want := binaries[0].Args, []string{"--stdio"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("binary args = %#v, want %#v", got, want)
	}
	if len(binaries[0].CheckArgs) != 0 {
		t.Fatalf("binary check args = %#v, want none because the server has no side-effect-free version command", binaries[0].CheckArgs)
	}
	if got, want := adapter.DefaultArgs(), []string{"--stdio"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("DefaultArgs() = %#v, want %#v", got, want)
	}

	deps := adapter.RuntimeDeps()
	if len(deps) != 1 {
		t.Fatalf("RuntimeDeps() returned %d dependencies, want 1", len(deps))
	}
	dep := deps[0]
	if dep.Source != "npm" || dep.ArchiveType != "npm" {
		t.Fatalf("dependency source = %q/%q, want npm/npm", dep.Source, dep.ArchiveType)
	}
	if dep.PackageName != "vscode-json-languageserver" || dep.BinaryName != "vscode-json-languageserver" {
		t.Fatalf("dependency package/binary = %q/%q", dep.PackageName, dep.BinaryName)
	}
	if dep.Version != jsonLanguageServerVersion || dep.RecommendedVersion != jsonLanguageServerVersion {
		t.Fatalf("dependency versions = %q/%q, want %q", dep.Version, dep.RecommendedVersion, jsonLanguageServerVersion)
	}
	if dep.RecommendedIntegrity != jsonLanguageServerIntegrity {
		t.Fatalf("recommended integrity = %q, want %q", dep.RecommendedIntegrity, jsonLanguageServerIntegrity)
	}
	if got, want := dep.Packages, []string{"vscode-json-languageserver"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dependency packages = %#v, want %#v", got, want)
	}

	guide := adapter.InstallGuide()
	if guide.KnownsCmd != "knowns lsp install json" || guide.URL == "" {
		t.Fatalf("InstallGuide() = %#v", guide)
	}
	prerequisites := adapter.Prerequisites()
	if len(prerequisites) != 1 || prerequisites[0].CheckCmd != "node --version" {
		t.Fatalf("Prerequisites() = %#v, want Node.js", prerequisites)
	}
}

func TestJSONAdapterRouting(t *testing.T) {
	registry := newJSONTestRegistry(t)

	for _, path := range []string{"config.json", "settings.jsonc", "nested/service.JSON"} {
		t.Run(path, func(t *testing.T) {
			lang, ok := registry.ForPath(path)
			assertJSONRoute(t, lang, ok)
			lang, ok = registry.ForDetection(path)
			assertJSONRoute(t, lang, ok)
		})
	}

	for _, path := range []string{"package-lock.json", "npm-shrinkwrap.json", "api.generated.json"} {
		t.Run(path+" explicit only", func(t *testing.T) {
			lang, ok := registry.ForPath(path)
			assertJSONRoute(t, lang, ok)
			if lang, ok := registry.ForDetection(path); ok {
				t.Fatalf("ForDetection(%q) = %q, want no route", path, lang.ID)
			}
		})
	}

	for _, path := range []string{".knowns/config.json", `C:\repo\.knowns\config.json`} {
		t.Run(path+" hard excluded", func(t *testing.T) {
			if lang, ok := registry.ForPath(path); ok {
				t.Fatalf("ForPath(%q) = %q, want no route", path, lang.ID)
			}
			if lang, ok := registry.ForDetection(path); ok {
				t.Fatalf("ForDetection(%q) = %q, want no route", path, lang.ID)
			}
		})
	}
}

func TestJSONAdapterYieldsTerraformCompoundSuffixes(t *testing.T) {
	registry := newJSONTestRegistry(t)
	err := registry.Register(lsp.Language{
		ID:         "terraform",
		Name:       "Terraform",
		Extensions: []string{".tf", ".tfvars", ".tf.json", ".tfvars.json"},
		Matchers: []lsp.PathMatcher{
			{Kind: lsp.PathMatcherSuffix, Pattern: ".tf.json", Priority: jsonPathPriority + 100},
			{Kind: lsp.PathMatcherSuffix, Pattern: ".tfvars.json", Priority: jsonPathPriority + 100},
		},
	})
	if err != nil {
		t.Fatalf("register Terraform language: %v", err)
	}

	for _, path := range []string{"network.tf.json", "production.tfvars.json"} {
		lang, ok := registry.ForPath(path)
		if !ok || lang.ID != "terraform" {
			t.Fatalf("ForPath(%q) = %q, %v; want terraform", path, lang.ID, ok)
		}
	}
	lang, ok := registry.ForPath("settings.json")
	assertJSONRoute(t, lang, ok)
}

func newJSONTestRegistry(t *testing.T) *lsp.Registry {
	t.Helper()
	adapter := NewJSONAdapter()
	registry := lsp.NewEmptyRegistry()
	if err := registry.Register(lsp.Language{
		ID:         adapter.ID(),
		Name:       adapter.Name(),
		Extensions: adapter.Extensions(),
		Matchers:   adapter.PathMatchers(),
		LazyStart:  adapter.LazyStart(),
	}); err != nil {
		t.Fatalf("register JSON language: %v", err)
	}
	return registry
}

func assertJSONRoute(t *testing.T, lang lsp.Language, ok bool) {
	t.Helper()
	if !ok || lang.ID != "json" {
		t.Fatalf("route = %q, %v; want json", lang.ID, ok)
	}
}
