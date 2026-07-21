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

func TestTerraformLSAdapterContracts(t *testing.T) {
	adapter := NewTerraformLSAdapter()
	var _ lsp.LanguageAdapter = adapter
	var _ lsp.PathMatcherAdapter = adapter
	var _ lsp.LazyStartAdapter = adapter
	var _ lsp.CapabilityBaselineProvider = adapter
	var _ lsp.PathDocumentSyncAdapter = adapter
	var _ lsp.PathCapabilityAdapter = adapter
	var _ lsp.RuntimeDependencyResolverProvider = adapter

	if adapter.ID() != "terraform" || adapter.Name() != "Terraform" {
		t.Fatalf("identity = %q/%q, want terraform/Terraform", adapter.ID(), adapter.Name())
	}
	wantExtensions := []string{".tf", ".tfvars", ".tf.json", ".tfvars.json"}
	if got := adapter.Extensions(); !reflect.DeepEqual(got, wantExtensions) {
		t.Fatalf("Extensions() = %#v, want %#v", got, wantExtensions)
	}
	if !adapter.LazyStart() {
		t.Fatal("LazyStart() = false, want true")
	}
	if got, want := adapter.CapabilityProfile(), lsp.CodeCapabilityProfile(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CapabilityProfile() = %#v, want %#v", got, want)
	}
	if adapter.SupportsImplementation() {
		t.Fatal("SupportsImplementation() = true, want false")
	}
	binaries := adapter.Binaries()
	if len(binaries) != 1 || binaries[0].Name != "terraform-ls" {
		t.Fatalf("Binaries() = %#v, want terraform-ls", binaries)
	}
	if !reflect.DeepEqual(binaries[0].Args, []string{"serve"}) || !reflect.DeepEqual(binaries[0].CheckArgs, []string{"version"}) {
		t.Fatalf("terraform-ls args/check args = %#v/%#v", binaries[0].Args, binaries[0].CheckArgs)
	}
	if got := adapter.DefaultArgs(); !reflect.DeepEqual(got, []string{"serve"}) {
		t.Fatalf("DefaultArgs() = %#v, want serve", got)
	}
	prerequisites := adapter.Prerequisites()
	if len(prerequisites) != 1 || prerequisites[0].CheckCmd != "terraform version" {
		t.Fatalf("Prerequisites() = %#v, want Terraform CLI", prerequisites)
	}
}

func TestTerraformLSAdapterDocumentSync(t *testing.T) {
	adapter := NewTerraformLSAdapter()
	tests := []struct {
		path string
		want lsp.DocumentSyncOptions
	}{
		{path: "main.tf", want: lsp.DocumentSyncOptions{LanguageID: "terraform"}},
		{path: "production.tfvars", want: lsp.DocumentSyncOptions{LanguageID: "terraform-vars"}},
		{path: "network.tf.json", want: lsp.DocumentSyncOptions{LanguageID: "terraform", Suppress: true}},
		{path: `C:\repo\PRODUCTION.TFVARS.JSON`, want: lsp.DocumentSyncOptions{LanguageID: "terraform-vars", Suppress: true}},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := adapter.DocumentSyncForPath(tt.path); got != tt.want {
				t.Fatalf("DocumentSyncForPath(%q) = %#v, want %#v", tt.path, got, tt.want)
			}
		})
	}
}

func TestTerraformLSAdapterPathCapabilities(t *testing.T) {
	adapter := NewTerraformLSAdapter()
	for _, path := range []string{"network.tf.json", `C:\repo\PRODUCTION.TFVARS.JSON`} {
		decision, handled := adapter.PathCapabilityForAction(path, "definition", lsp.CapabilityDefinition)
		if !handled || decision.Supported {
			t.Fatalf("PathCapabilityForAction(%q) = %#v, %v; want unsupported decision", path, decision, handled)
		}
		if len(decision.Capabilities) != 0 || len(decision.AdvertisedCapabilities) != 0 {
			t.Fatalf("JSON variant capabilities = %#v/%#v, want none advertised", decision.Capabilities, decision.AdvertisedCapabilities)
		}
		if !strings.Contains(decision.Explanation, "does not support Terraform JSON") {
			t.Fatalf("JSON variant explanation = %q", decision.Explanation)
		}
	}
	for _, path := range []string{"main.tf", "production.tfvars"} {
		if decision, handled := adapter.PathCapabilityForAction(path, "definition", lsp.CapabilityDefinition); handled {
			t.Fatalf("PathCapabilityForAction(%q) = %#v, true; want server baseline", path, decision)
		}
	}
}

func TestTerraformLSAdapterRoutingPrecedesJSON(t *testing.T) {
	terra := NewTerraformLSAdapter()
	jsonAdapter := NewJSONAdapter()
	registry := lsp.NewEmptyRegistry()
	for _, language := range []lsp.Language{
		{
			ID:         jsonAdapter.ID(),
			Name:       jsonAdapter.Name(),
			Extensions: jsonAdapter.Extensions(),
			Matchers:   jsonAdapter.PathMatchers(),
			LazyStart:  jsonAdapter.LazyStart(),
		},
		{
			ID:         terra.ID(),
			Name:       terra.Name(),
			Extensions: terra.Extensions(),
			Matchers:   terra.PathMatchers(),
			LazyStart:  terra.LazyStart(),
		},
	} {
		if err := registry.Register(language); err != nil {
			t.Fatalf("register %s: %v", language.ID, err)
		}
	}

	for _, path := range []string{"main.tf", "production.tfvars", "network.tf.json", "production.tfvars.json"} {
		for _, resolve := range []struct {
			name string
			fn   func(string) (lsp.Language, bool)
		}{{name: "explicit", fn: registry.ForPath}, {name: "detection", fn: registry.ForDetection}} {
			language, ok := resolve.fn(path)
			if !ok || language.ID != "terraform" {
				t.Errorf("%s route for %q = %q, %v; want terraform", resolve.name, path, language.ID, ok)
			}
		}
	}
	for _, path := range []string{"settings.json", "settings.jsonc"} {
		language, ok := registry.ForPath(path)
		if !ok || language.ID != "json" {
			t.Errorf("ForPath(%q) = %q, %v; want json", path, language.ID, ok)
		}
	}
	for _, path := range []string{"module.hcl", "main.tf.json.backup", ".knowns/main.tf", `C:\repo\.knowns\main.tfvars.json`} {
		if language, ok := registry.ForPath(path); ok {
			t.Errorf("ForPath(%q) = %q, true; want no route", path, language.ID)
		}
	}
}

func TestTerraformLSAdapterRecommendedReleaseMetadata(t *testing.T) {
	wantSHA256 := map[string]string{
		"darwin-amd64":  "34cfe6cbbb61da5b8fd21721e14be0f134417f249350872da1669454dc8762a4",
		"darwin-arm64":  "510a506f7bf1550294202347261961e52daa4664a795e2deffbf7df7296b1f6c",
		"linux-amd64":   "d16077d9c83f13ac33501af49ea75f43218d3fa2437c6c1374550b2625edc3ef",
		"linux-arm64":   "762db754428dd188b949533ca05437955e26f4b3fc699d4b93392668a24e7a10",
		"windows-amd64": "5152e76e45103ea2a31b8a8dadc43833ae559a4aba4cb12f57c1c006c11dda8c",
		"windows-arm64": "5cee26a3645487125bf65daee8cfc85c84d8c7e03bbb00662fb12225afe9d6cd",
	}
	deps := NewTerraformLSAdapter().RuntimeDeps()
	if len(deps) != len(wantSHA256) {
		t.Fatalf("RuntimeDeps() returned %d dependencies, want %d", len(deps), len(wantSHA256))
	}
	seen := make(map[string]bool, len(deps))
	for _, dep := range deps {
		checksum, ok := wantSHA256[dep.PlatformID]
		if !ok {
			t.Errorf("unexpected platform %q", dep.PlatformID)
			continue
		}
		seen[dep.PlatformID] = true
		if dep.Version != terraformLSRecommendedVersion || dep.RecommendedVersion != terraformLSRecommendedVersion {
			t.Errorf("%s versions = %q/%q, want %s", dep.PlatformID, dep.Version, dep.RecommendedVersion, terraformLSRecommendedVersion)
		}
		if dep.SHA256 != checksum || dep.RecommendedIntegrity != "sha256:"+checksum {
			t.Errorf("%s integrity = %q/%q, want %s", dep.PlatformID, dep.SHA256, dep.RecommendedIntegrity, checksum)
		}
		if dep.Source != "release" || dep.ArchiveType != "zip" || dep.BinaryName != "terraform-ls" {
			t.Errorf("%s dependency metadata = %#v", dep.PlatformID, dep)
		}
		if !strings.HasPrefix(dep.URL, terraformLSReleasesBase+"/"+terraformLSRecommendedVersion+"/") {
			t.Errorf("%s URL = %q, want official pinned release", dep.PlatformID, dep.URL)
		}
		if strings.HasPrefix(dep.PlatformID, "windows-") && dep.ExtractPath != "terraform-ls.exe" {
			t.Errorf("%s ExtractPath = %q, want terraform-ls.exe", dep.PlatformID, dep.ExtractPath)
		}
	}
	for platform := range wantSHA256 {
		if !seen[platform] {
			t.Errorf("RuntimeDeps() missing %s", platform)
		}
	}
}

func TestResolveTerraformLSRuntimeDependencyRecommendedIsPinnedAndOffline(t *testing.T) {
	dep := terraformDependencyForPlatform(t, "linux-amd64")
	resolution, err := resolveTerraformLSRuntimeDependency(context.Background(), nil, "", "", dep, lsp.InstallSelector{})
	if err != nil {
		t.Fatalf("resolve recommended dependency: %v", err)
	}
	if resolution.ResolvedVersion != terraformLSRecommendedVersion || resolution.Dependency.URL != dep.URL {
		t.Fatalf("recommended resolution = %#v, want pinned dependency", resolution)
	}
	if resolution.Integrity != dep.RecommendedIntegrity {
		t.Fatalf("recommended integrity = %q, want %q", resolution.Integrity, dep.RecommendedIntegrity)
	}
}

func TestResolveTerraformLSRuntimeDependencyLatestAndTag(t *testing.T) {
	const (
		resolvedVersion = "0.39.0"
		resolvedSHA     = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		archiveName     = "terraform-ls_0.39.0_linux_amd64.zip"
	)
	tests := []struct {
		name       string
		selector   lsp.InstallSelector
		wantLatest bool
	}{
		{name: "latest", selector: lsp.InstallSelector{Latest: true}, wantLatest: true},
		{name: "tag", selector: lsp.InstallSelector{Version: "v" + resolvedVersion}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			latestCalled := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/github/latest":
					latestCalled = true
					_ = json.NewEncoder(w).Encode(map[string]string{"tag_name": "v" + resolvedVersion})
				case "/releases/" + resolvedVersion + "/terraform-ls_" + resolvedVersion + "_SHA256SUMS":
					_, _ = w.Write([]byte(resolvedSHA + "  " + archiveName + "\n"))
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			resolution, err := resolveTerraformLSRuntimeDependency(
				context.Background(),
				server.Client(),
				server.URL+"/github",
				server.URL+"/releases",
				terraformDependencyForPlatform(t, "linux-amd64"),
				tt.selector,
			)
			if err != nil {
				t.Fatalf("resolve dependency: %v", err)
			}
			if latestCalled != tt.wantLatest {
				t.Fatalf("latest endpoint called = %v, want %v", latestCalled, tt.wantLatest)
			}
			if resolution.ResolvedVersion != resolvedVersion || resolution.Dependency.Version != resolvedVersion {
				t.Fatalf("resolved version = %q/%q, want %s", resolution.ResolvedVersion, resolution.Dependency.Version, resolvedVersion)
			}
			if resolution.Dependency.SHA256 != resolvedSHA || resolution.Integrity != "sha256:"+resolvedSHA {
				t.Fatalf("resolved integrity = %q/%q, want SHA-256", resolution.Dependency.SHA256, resolution.Integrity)
			}
			if !strings.HasSuffix(resolution.Dependency.URL, "/"+archiveName) {
				t.Fatalf("resolved URL = %q, want %s", resolution.Dependency.URL, archiveName)
			}
		})
	}
}

func TestResolveTerraformLSRuntimeDependencyFailsClosed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not-a-checksum  terraform-ls_0.39.0_linux_amd64.zip\n"))
	}))
	defer server.Close()

	_, err := resolveTerraformLSRuntimeDependency(
		context.Background(),
		server.Client(),
		server.URL,
		server.URL,
		terraformDependencyForPlatform(t, "linux-amd64"),
		lsp.InstallSelector{Version: "0.39.0"},
	)
	if err == nil || !strings.Contains(err.Error(), "invalid SHA-256") {
		t.Fatalf("invalid checksum error = %v, want fail-closed SHA-256 error", err)
	}

	_, err = resolveTerraformLSRuntimeDependency(
		context.Background(),
		server.Client(),
		server.URL,
		server.URL,
		terraformDependencyForPlatform(t, "linux-amd64"),
		lsp.InstallSelector{Version: "../../0.39.0"},
	)
	if err == nil || !strings.Contains(err.Error(), "invalid terraform-ls release version") {
		t.Fatalf("unsafe version error = %v, want validation error", err)
	}
}

func terraformDependencyForPlatform(t *testing.T, platformID string) lsp.RuntimeDependency {
	t.Helper()
	for _, dep := range NewTerraformLSAdapter().RuntimeDeps() {
		if dep.PlatformID == platformID {
			return dep
		}
	}
	t.Fatalf("missing test dependency for %s", platformID)
	return lsp.RuntimeDependency{}
}
