package lsp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestCSharpBackendRegistryIDs(t *testing.T) {
	want := []string{CSharpBackendRoslyn, CSharpBackendCSharp, CSharpBackendOmni}
	if got := CSharpBackendIDs(); !reflect.DeepEqual(got, want) {
		t.Fatalf("CSharpBackendIDs() = %#v, want %#v", got, want)
	}
	for _, id := range want {
		if !IsCSharpBackendID(id) {
			t.Fatalf("IsCSharpBackendID(%q) = false, want true", id)
		}
	}
}

func TestCSharpRoslynRuntimeDependencyUsesPlatformPackage(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {
			Version: "5.0.0-test",
			Settings: map[string]any{
				"roslynPackageSource": "https://mirror.example/nuget",
				"roslynSHA512":        "checksum",
			},
		},
	}}
	dep := CSharpRoslynRuntimeDependency(cfg)
	rid := CSharpRoslynRID(runtime.GOOS, runtime.GOARCH)
	if dep.Source != "nuget" || dep.ArchiveType != "nupkg" {
		t.Fatalf("dependency source = %q/%q, want nuget/nupkg", dep.Source, dep.ArchiveType)
	}
	if dep.PackageName != RoslynNuGetPackagePrefix+"."+rid {
		t.Fatalf("PackageName = %q, want platform package for %s", dep.PackageName, rid)
	}
	if dep.Version != "5.0.0-test" {
		t.Fatalf("Version = %q, want override", dep.Version)
	}
	if dep.PackageSource != "https://mirror.example/nuget" || dep.SHA512 != "checksum" {
		t.Fatalf("settings not applied: %#v", dep)
	}
	if !strings.Contains(dep.ExtractPath, rid) || !strings.HasSuffix(dep.ExtractPath, "Microsoft.CodeAnalysis.LanguageServer.dll") {
		t.Fatalf("ExtractPath = %q, want RID-specific language server DLL", dep.ExtractPath)
	}
}

func TestResolveCSharpBackendUsesManagedRoslynThroughDotnet(t *testing.T) {
	root := t.TempDir()
	rid := CSharpRoslynRID(runtime.GOOS, runtime.GOARCH)
	serverPath := filepath.ToSlash(filepath.Join("content", "LanguageServer", rid, "Microsoft.CodeAnalysis.LanguageServer.dll"))
	content, err := createTestZip(map[string][]byte{serverPath: []byte("dll")})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer server.Close()

	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {
			Version: "5.0.0-test",
			Settings: map[string]any{
				"roslynPackageURL": server.URL + "/roslyn.nupkg",
			},
		},
	}}
	installer := NewInstaller(t.TempDir())
	dep := CSharpRoslynRuntimeDependency(cfg)
	if _, err := installer.Install(context.Background(), dependencyAdapter{id: CSharpLanguageID, deps: []RuntimeDependency{dep}}); err != nil {
		t.Fatalf("install managed Roslyn: %v", err)
	}

	cmd, ok := ResolveCSharpBackendWithOptions(context.Background(), root, cfg, CSharpResolveOptions{
		LookPath: func(name string) (string, error) {
			if name == "dotnet" {
				return "/usr/bin/dotnet", nil
			}
			return "", errors.New("missing")
		},
		RunCommand: func(_ context.Context, name string, args ...string) ([]byte, error) {
			if name != "/usr/bin/dotnet" || !reflect.DeepEqual(args, []string{"--version"}) {
				t.Fatalf("dotnet check = %s %#v", name, args)
			}
			return []byte("10.0.100"), nil
		},
		Installer: installer,
	})
	if !ok {
		t.Fatalf("ResolveCSharpBackendWithOptions failed: %#v", cmd.Attempts)
	}
	if cmd.Backend != CSharpBackendRoslyn || cmd.Path != "/usr/bin/dotnet" || cmd.Name != "dotnet" {
		t.Fatalf("command = %#v, want dotnet Roslyn backend", cmd)
	}
	if len(cmd.Args) != 2 || !strings.HasSuffix(filepath.ToSlash(cmd.Args[0]), serverPath) || cmd.Args[1] != "--stdio" {
		t.Fatalf("Roslyn args = %#v, want server DLL and --stdio", cmd.Args)
	}
	if cmd.LogPath == "" || !strings.Contains(cmd.LogPath, "csharp-roslyn-ls.log") {
		t.Fatalf("LogPath = %q, want C# Roslyn log path", cmd.LogPath)
	}
}

func TestResolveCSharpBackendAutoFallbackRecordsAttempts(t *testing.T) {
	var lookedUp []string
	lookPath := func(name string) (string, error) {
		lookedUp = append(lookedUp, name)
		if name == "csharp-ls" {
			return "/bin/csharp-ls", nil
		}
		return "", errors.New("missing")
	}

	cmd, ok := ResolveCSharpBackend(context.Background(), t.TempDir(), Config{}, lookPath, func(context.Context, string, ...string) error { return nil })
	if !ok {
		t.Fatal("ResolveCSharpBackend() failed, want csharp-ls fallback")
	}
	if cmd.Backend != CSharpBackendCSharp || cmd.Name != "csharp-ls" || cmd.Path != "/bin/csharp-ls" {
		t.Fatalf("command = %#v, want selected csharp-ls", cmd)
	}
	if !reflect.DeepEqual(lookedUp, []string{"roslyn-ls", "csharp-ls"}) {
		t.Fatalf("lookedUp = %#v, want roslyn-ls then csharp-ls", lookedUp)
	}
	if len(cmd.Attempts) != 3 {
		t.Fatalf("attempts = %#v, want 3 entries", cmd.Attempts)
	}
	if cmd.Attempts[0].Backend != CSharpBackendRoslyn || cmd.Attempts[0].Status != BackendAttemptFailed {
		t.Fatalf("first attempt = %#v, want failed roslyn-ls", cmd.Attempts[0])
	}
	if cmd.Attempts[1].Backend != CSharpBackendCSharp || cmd.Attempts[1].Status != BackendAttemptChosen {
		t.Fatalf("second attempt = %#v, want selected csharp-ls", cmd.Attempts[1])
	}
	if cmd.Attempts[2].Backend != CSharpBackendOmni || cmd.Attempts[2].Status != BackendAttemptSkipped {
		t.Fatalf("third attempt = %#v, want skipped omnisharp", cmd.Attempts[2])
	}
}

func TestResolveCSharpBackendCSharpLSPUsesDiscoveredSolution(t *testing.T) {
	root := t.TempDir()
	solutionPath := filepath.Join(root, "App.sln")
	if err := os.WriteFile(solutionPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	lookPath := func(name string) (string, error) {
		if name == "csharp-ls" {
			return "/bin/csharp-ls", nil
		}
		return "", errors.New("missing")
	}

	cmd, ok := ResolveCSharpBackend(context.Background(), root, Config{}, lookPath, func(context.Context, string, ...string) error { return nil })
	if !ok {
		t.Fatal("ResolveCSharpBackend() failed, want csharp-ls fallback")
	}
	if cmd.Backend != CSharpBackendCSharp || cmd.Path != "/bin/csharp-ls" {
		t.Fatalf("command = %#v, want selected csharp-ls", cmd)
	}
	if !reflect.DeepEqual(cmd.Args, []string{"--solution", "App.sln"}) {
		t.Fatalf("csharp-ls args = %#v, want --solution App.sln", cmd.Args)
	}
}

func TestCSharpLSProjectPathUsesRelativeSolutionWithinRoot(t *testing.T) {
	root := t.TempDir()
	nestedSolutionPath := filepath.Join(root, "src", "App.sln")

	got := csharpLSProjectPath(root, nestedSolutionPath)
	want := filepath.Join("src", "App.sln")
	if got != want {
		t.Fatalf("csharpLSProjectPath() = %q, want %q", got, want)
	}
}

func TestCSharpLSProjectPathKeepsSolutionOutsideRoot(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "root")
	outsideSolutionPath := filepath.Join(base, "other", "App.sln")

	got := csharpLSProjectPath(root, outsideSolutionPath)
	if got != outsideSolutionPath {
		t.Fatalf("csharpLSProjectPath() = %q, want absolute outside-root path %q", got, outsideSolutionPath)
	}
}

func TestResolveCSharpBackendExplicitDoesNotFallback(t *testing.T) {
	cfg := Config{Languages: map[string]LanguageConfig{
		CSharpLanguageID: {Backend: CSharpBackendOmni},
	}}
	var lookedUp []string
	lookPath := func(name string) (string, error) {
		lookedUp = append(lookedUp, name)
		return "", errors.New("missing")
	}

	cmd, ok := ResolveCSharpBackend(context.Background(), t.TempDir(), cfg, lookPath, nil)
	if ok {
		t.Fatalf("ResolveCSharpBackend() succeeded: %#v", cmd)
	}
	if !reflect.DeepEqual(lookedUp, []string{"omnisharp"}) {
		t.Fatalf("lookedUp = %#v, want only omnisharp", lookedUp)
	}
	if len(cmd.Attempts) != 1 || cmd.Attempts[0].Backend != CSharpBackendOmni {
		t.Fatalf("attempts = %#v, want only omnisharp attempt", cmd.Attempts)
	}
}

func TestDetectUsesCSharpBackendResolver(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Program.cs"), []byte("class Program {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry([]Language{{ID: CSharpLanguageID, Name: "C#", Extensions: []string{".cs"}}})
	d := NewDetector(registry)
	d.LookPath = func(name string) (string, error) {
		if name == "omnisharp" {
			return "/bin/omnisharp", nil
		}
		return "", errors.New("missing")
	}
	d.RunCheck = func(context.Context, string, ...string) error { return nil }
	cfg := Config{Languages: map[string]LanguageConfig{CSharpLanguageID: {Backend: CSharpBackendOmni}}}

	commands, err := d.Detect(context.Background(), root, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 1 {
		t.Fatalf("commands = %#v, want one C# command", commands)
	}
	if commands[0].Backend != CSharpBackendOmni || commands[0].Name != "omnisharp" {
		t.Fatalf("command = %#v, want omnisharp backend", commands[0])
	}
}

func TestDiscoverCSharpProjectBreadthFirstSolutionBeforeProject(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "src", "App"))
	writeFile(t, filepath.Join(root, "src", "App", "App.csproj"))
	writeFile(t, filepath.Join(root, "b", "Nested.sln"))
	writeFile(t, filepath.Join(root, "eShopOnWeb.sln"))
	writeFile(t, filepath.Join(root, "Everything.sln"))

	got := DiscoverCSharpProject(root, "")
	want := filepath.Join(root, "eShopOnWeb.sln")
	if got.Path != want || got.Kind != "sln" {
		t.Fatalf("DiscoverCSharpProject() = %#v, want %s sln", got, want)
	}
}

func TestDiscoverCSharpProjectSlnxAndCsprojFallback(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "src"))
	writeFile(t, filepath.Join(root, "src", "Next.slnx"))
	writeFile(t, filepath.Join(root, "App.csproj"))
	got := DiscoverCSharpProject(root, "")
	if got.Path != filepath.Join(root, "src", "Next.slnx") || got.Kind != "slnx" {
		t.Fatalf("DiscoverCSharpProject() = %#v, want nested slnx before root csproj", got)
	}

	root = t.TempDir()
	mkdir(t, filepath.Join(root, "src"))
	writeFile(t, filepath.Join(root, "src", "App.csproj"))
	got = DiscoverCSharpProject(root, "")
	if got.Path != filepath.Join(root, "src", "App.csproj") || got.Kind != "csproj" {
		t.Fatalf("DiscoverCSharpProject() = %#v, want csproj fallback", got)
	}
}

func TestDiscoverCSharpProjectOverride(t *testing.T) {
	root := t.TempDir()
	got := DiscoverCSharpProject(root, "custom/Selected.slnx")
	want := filepath.Join(root, "custom", "Selected.slnx")
	if got.Path != want || got.Kind != "slnx" {
		t.Fatalf("DiscoverCSharpProject override = %#v, want %s slnx", got, want)
	}
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
}
