package adapters

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestMarksmanAdapterContracts(t *testing.T) {
	adapter := NewMarksmanAdapter()
	var _ lsp.LanguageAdapter = adapter
	var _ lsp.PathMatcherAdapter = adapter
	var _ lsp.LazyStartAdapter = adapter
	var _ lsp.CapabilityBaselineProvider = adapter
	var _ lsp.RuntimeDependencyResolverProvider = adapter

	if got := adapter.ID(); got != "markdown" {
		t.Fatalf("ID() = %q, want markdown", got)
	}
	if got := adapter.Name(); got != "Markdown" {
		t.Fatalf("Name() = %q, want Markdown", got)
	}
	if got := adapter.Extensions(); !reflect.DeepEqual(got, []string{".md", ".markdown"}) {
		t.Fatalf("Extensions() = %#v, want .md and .markdown", got)
	}
	if !adapter.LazyStart() {
		t.Fatal("LazyStart() = false, want true")
	}
	if got, want := adapter.CapabilityProfile(), lsp.DocumentConfigCapabilityProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CapabilityProfile() = %#v, want %#v", got, want)
	}
	if got := adapter.DefaultArgs(); !reflect.DeepEqual(got, []string{"server"}) {
		t.Fatalf("DefaultArgs() = %#v, want marksman server", got)
	}
	binaries := adapter.Binaries()
	if len(binaries) != 1 || binaries[0].Name != "marksman" || !reflect.DeepEqual(binaries[0].Args, []string{"server"}) {
		t.Fatalf("Binaries() = %#v, want marksman server", binaries)
	}
	if !reflect.DeepEqual(binaries[0].CheckArgs, []string{"--version"}) {
		t.Fatalf("marksman CheckArgs = %#v, want --version", binaries[0].CheckArgs)
	}
	if adapter.SupportsImplementation() {
		t.Fatal("SupportsImplementation() = true, want false")
	}
}

func TestMarksmanAdapterMarkdownRouting(t *testing.T) {
	adapter := NewMarksmanAdapter()
	registry := lsp.NewRegistry([]lsp.Language{{
		ID:         adapter.ID(),
		Name:       adapter.Name(),
		Extensions: adapter.Extensions(),
		Matchers:   adapter.PathMatchers(),
		LazyStart:  adapter.LazyStart(),
	}})

	for _, path := range []string{"README.md", "docs/guide.MD", "docs/reference.markdown"} {
		language, ok := registry.ForPath(path)
		if !ok || language.ID != "markdown" {
			t.Errorf("ForPath(%q) = %#v, %v; want markdown", path, language, ok)
		}
	}
	for _, path := range []string{"component.mdx", "docs/readme.txt", ".knowns/docs/readme.md", `project\.knowns\docs\readme.md`} {
		if language, ok := registry.ForPath(path); ok {
			t.Errorf("ForPath(%q) = %#v, true; want no route", path, language)
		}
	}
	language, ok := registry.Language("markdown")
	if !ok || !language.LazyStart {
		t.Fatalf("registered Markdown language = %#v, %v; want lazy start", language, ok)
	}
}

func TestMarksmanAdapterRecommendedReleaseMetadata(t *testing.T) {
	deps := NewMarksmanAdapter().RuntimeDeps()
	if len(deps) != 5 {
		t.Fatalf("RuntimeDeps() returned %d dependencies, want 5", len(deps))
	}
	wantPlatforms := map[string]string{
		"darwin-arm64":  "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
		"darwin-amd64":  "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b",
		"linux-arm64":   "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb",
		"linux-amd64":   "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087",
		"windows-amd64": "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705",
	}
	seen := make(map[string]bool, len(wantPlatforms))
	for _, dep := range deps {
		wantSHA256, ok := wantPlatforms[dep.PlatformID]
		if !ok {
			t.Errorf("unexpected platform %q", dep.PlatformID)
			continue
		}
		seen[dep.PlatformID] = true
		if dep.Version != marksmanRecommendedVersion || dep.RecommendedVersion != marksmanRecommendedVersion {
			t.Errorf("%s versions = %q/%q, want %q", dep.PlatformID, dep.Version, dep.RecommendedVersion, marksmanRecommendedVersion)
		}
		if dep.Source != "release" || dep.ArchiveType != "binary" || dep.BinaryName != "marksman" {
			t.Errorf("%s dependency metadata = %#v", dep.PlatformID, dep)
		}
		if !strings.HasPrefix(dep.URL, marksmanRepositoryURL+"/releases/download/"+marksmanRecommendedVersion+"/") {
			t.Errorf("%s URL = %q, want pinned GitHub release URL", dep.PlatformID, dep.URL)
		}
		if dep.SHA256 != wantSHA256 || dep.RecommendedIntegrity != "sha256:"+wantSHA256 {
			t.Errorf("%s integrity = %q/%q, want %q", dep.PlatformID, dep.SHA256, dep.RecommendedIntegrity, wantSHA256)
		}
	}
	for platform := range wantPlatforms {
		if !seen[platform] {
			t.Errorf("RuntimeDeps() missing %s", platform)
		}
	}
}

func TestResolveMarksmanRuntimeDependencyRecommendedIsPinnedAndOffline(t *testing.T) {
	dep := dependencyForPlatform(t, "linux-amd64")
	resolution, err := resolveMarksmanRuntimeDependency(context.Background(), nil, "", dep, lsp.InstallSelector{})
	if err != nil {
		t.Fatalf("resolve recommended dependency: %v", err)
	}
	if resolution.ResolvedVersion != marksmanRecommendedVersion || resolution.Dependency.URL != dep.URL {
		t.Fatalf("recommended resolution = %#v, want pinned dependency", resolution)
	}
	if resolution.Integrity != dep.RecommendedIntegrity {
		t.Fatalf("recommended integrity = %q, want %q", resolution.Integrity, dep.RecommendedIntegrity)
	}
}

func TestResolveMarksmanRuntimeDependencyLatestAndTag(t *testing.T) {
	const (
		resolvedVersion = "2026-07-20"
		resolvedSHA     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	)

	tests := []struct {
		name     string
		selector lsp.InstallSelector
		wantPath string
	}{
		{name: "latest", selector: lsp.InstallSelector{Latest: true}, wantPath: "/latest"},
		{name: "tag", selector: lsp.InstallSelector{Version: resolvedVersion}, wantPath: "/tags/" + resolvedVersion},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.wantPath {
					t.Errorf("release request path = %q, want %q", r.URL.Path, tt.wantPath)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{
					"tag_name": resolvedVersion,
					"assets": []map[string]string{{
						"name":                 "marksman-linux-x64",
						"browser_download_url": serverAssetURL(r, "marksman-linux-x64"),
						"digest":               "sha256:" + resolvedSHA,
					}},
				})
			}))
			defer server.Close()

			dep := dependencyForPlatform(t, "linux-amd64")
			resolution, err := resolveMarksmanRuntimeDependency(context.Background(), server.Client(), server.URL, dep, tt.selector)
			if err != nil {
				t.Fatalf("resolve dependency: %v", err)
			}
			if resolution.ResolvedVersion != resolvedVersion || resolution.Dependency.Version != resolvedVersion {
				t.Fatalf("resolved version = %q/%q, want %q", resolution.ResolvedVersion, resolution.Dependency.Version, resolvedVersion)
			}
			if resolution.Dependency.SHA256 != resolvedSHA || resolution.Integrity != "sha256:"+resolvedSHA {
				t.Fatalf("resolved integrity = %q/%q, want SHA-256", resolution.Dependency.SHA256, resolution.Integrity)
			}
			if !strings.HasSuffix(resolution.Dependency.URL, "/assets/marksman-linux-x64") {
				t.Fatalf("resolved URL = %q, want matching asset", resolution.Dependency.URL)
			}
		})
	}
}

func TestResolveMarksmanRuntimeDependencyRejectsMissingDigest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "2026-07-20",
			"assets": []map[string]string{{
				"name":                 "marksman-linux-x64",
				"browser_download_url": serverAssetURL(r, "marksman-linux-x64"),
			}},
		})
	}))
	defer server.Close()

	_, err := resolveMarksmanRuntimeDependency(
		context.Background(),
		server.Client(),
		server.URL,
		dependencyForPlatform(t, "linux-amd64"),
		lsp.InstallSelector{Latest: true},
	)
	if err == nil || !strings.Contains(err.Error(), "missing published SHA-256 digest") {
		t.Fatalf("resolve without digest error = %v, want published SHA-256 error", err)
	}
}

func dependencyForPlatform(t *testing.T, platformID string) lsp.RuntimeDependency {
	t.Helper()
	for _, dep := range NewMarksmanAdapter().RuntimeDeps() {
		if dep.PlatformID == platformID {
			return dep
		}
	}
	t.Fatalf("missing test dependency for %s", platformID)
	return lsp.RuntimeDependency{}
}

func serverAssetURL(r *http.Request, assetName string) string {
	return "http://" + r.Host + "/assets/" + assetName
}
