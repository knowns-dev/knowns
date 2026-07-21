package lsp

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// mockAdapter implements LanguageAdapter for testing.
type mockAdapter struct {
	id          string
	extensions  []string
	binaries    []BinaryCandidate
	runtimeDeps []RuntimeDependency
}

type resolvingMockAdapter struct {
	*mockAdapter
	resolve DependencyResolver
}

func (m *resolvingMockAdapter) ResolveRuntimeDependency(ctx context.Context, dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
	return m.resolve(ctx, dep, selector)
}

func (m *mockAdapter) ID() string                                                 { return m.id }
func (m *mockAdapter) Name() string                                               { return m.id }
func (m *mockAdapter) Extensions() []string                                       { return m.extensions }
func (m *mockAdapter) Binaries() []BinaryCandidate                                { return m.binaries }
func (m *mockAdapter) Prerequisites() []Prerequisite                              { return nil }
func (m *mockAdapter) CheckPrerequisites(context.Context) error                   { return nil }
func (m *mockAdapter) InstallGuide() InstallGuide                                 { return InstallGuide{} }
func (m *mockAdapter) CanInstall() bool                                           { return true }
func (m *mockAdapter) RuntimeDeps() []RuntimeDependency                           { return m.runtimeDeps }
func (m *mockAdapter) Install(_ context.Context, _ string) (string, error)        { return "", nil }
func (m *mockAdapter) InstalledPath() (string, bool)                              { return "", false }
func (m *mockAdapter) DefaultArgs() []string                                      { return nil }
func (m *mockAdapter) InitializeParams(_ string, _ map[string]any) map[string]any { return nil }
func (m *mockAdapter) InitializationOptions(_ map[string]any) map[string]any      { return nil }
func (m *mockAdapter) IsIgnoredDir(_ string) bool                                 { return false }
func (m *mockAdapter) NormalizeSymbolName(n string) string                        { return n }
func (m *mockAdapter) SupportsImplementation() bool                               { return false }
func (m *mockAdapter) SupportsReferences() bool                                   { return false }

// createTestBinary creates a simple binary content and returns it with its SHA-256 hash.
func createTestBinary() ([]byte, string) {
	content := []byte("#!/bin/sh\necho hello\n")
	h := sha256.Sum256(content)
	return content, hex.EncodeToString(h[:])
}

// createTestTarGz creates a tar.gz archive containing a file at the given path.
func createTestTarGz(fileName string, content []byte) ([]byte, error) {
	var buf []byte

	// Write to a temp file to get the bytes.
	tmpFile, err := os.CreateTemp("", "test-tar-gz-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpFile.Name())

	gw := gzip.NewWriter(tmpFile)
	tw := tar.NewWriter(gw)

	hdr := &tar.Header{
		Name: fileName,
		Mode: 0755,
		Size: int64(len(content)),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		tmpFile.Close()
		return nil, err
	}
	if _, err := tw.Write(content); err != nil {
		tmpFile.Close()
		return nil, err
	}
	tw.Close()
	gw.Close()
	tmpFile.Close()

	buf, err = os.ReadFile(tmpFile.Name())
	if err != nil {
		return nil, err
	}
	return buf, nil
}

func createTestZip(files map[string][]byte) ([]byte, error) {
	tmpFile, err := os.CreateTemp("", "test-zip-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpFile.Name())
	zw := zip.NewWriter(tmpFile)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			tmpFile.Close()
			return nil, err
		}
		if _, err := w.Write(content); err != nil {
			tmpFile.Close()
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		tmpFile.Close()
		return nil, err
	}
	if err := tmpFile.Close(); err != nil {
		return nil, err
	}
	return os.ReadFile(tmpFile.Name())
}

func TestIsInstalled_NotInstalled(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	adapter := &mockAdapter{
		id: "go",
		runtimeDeps: []RuntimeDependency{
			{
				ID:         "v1.0.0",
				PlatformID: CurrentPlatformID(),
				BinaryName: "gopls",
			},
		},
	}

	path, ok := installer.IsInstalled(adapter)
	if ok {
		t.Errorf("expected not installed, got path: %s", path)
	}
	if path != "" {
		t.Errorf("expected empty path, got: %s", path)
	}
}

func TestInstall_Binary(t *testing.T) {
	content, sha := createTestBinary()

	// Start a test HTTP server serving the binary.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer server.Close()

	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	adapter := &mockAdapter{
		id: "testlang",
		runtimeDeps: []RuntimeDependency{
			{
				ID:          "v1.0.0",
				PlatformID:  CurrentPlatformID(),
				URL:         server.URL + "/binary",
				SHA256:      sha,
				ArchiveType: "binary",
				BinaryName:  "test-server",
			},
		},
	}

	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	// Verify the binary exists.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("binary not found at %s: %v", path, err)
	}

	// Verify it's executable (skip on Windows where permission bits are not meaningful).
	info, _ := os.Stat(path)
	if runtime.GOOS != "windows" && info.Mode()&0111 == 0 {
		t.Error("binary is not executable")
	}

	// Verify IsInstalled now returns true.
	installedPath, ok := installer.IsInstalled(adapter)
	if !ok {
		t.Error("expected IsInstalled to return true after install")
	}
	if installedPath != path {
		t.Errorf("IsInstalled path mismatch: got %s, want %s", installedPath, path)
	}

	status := installer.Status(adapter)
	if !status.Installed {
		t.Fatal("expected status to report installed")
	}
	if status.Source != "binary" {
		t.Fatalf("status source = %q, want binary", status.Source)
	}
	if status.Version != "v1.0.0" {
		t.Fatalf("status version = %q, want v1.0.0", status.Version)
	}
	if status.CachePath == "" || status.SelectedPath != path {
		t.Fatalf("status paths not populated: %#v", status)
	}
}

func TestInstall_NPMDependencyUsesManagedCache(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	installer.runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != "npm" {
			t.Fatalf("runner command = %q, want npm", name)
		}
		var prefix string
		for i, arg := range args {
			if arg == "--prefix" && i+1 < len(args) {
				prefix = args[i+1]
				break
			}
		}
		if prefix == "" {
			t.Fatalf("npm args missing --prefix: %#v", args)
		}
		binDir := filepath.Join(prefix, "node_modules", ".bin")
		if err := os.MkdirAll(binDir, 0755); err != nil {
			t.Fatal(err)
		}
		binaryName := "test-ls"
		if runtime.GOOS == "windows" {
			binaryName += ".cmd"
		}
		if err := os.WriteFile(filepath.Join(binDir, binaryName), []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatal(err)
		}
		return []byte("ok"), nil
	}

	adapter := &mockAdapter{
		id: "npmtest",
		runtimeDeps: []RuntimeDependency{{
			ID:          "test-ls",
			Version:     "1.2.3",
			Source:      "npm",
			ArchiveType: "npm",
			BinaryName:  "test-ls",
			Packages:    []string{"test-ls", "typescript"},
		}},
	}

	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}
	wantPath := filepath.Join("npmtest", "test-ls-1.2.3", "node_modules", ".bin", "test-ls")
	if runtime.GOOS == "windows" {
		wantPath += ".cmd"
	}
	if !strings.Contains(path, wantPath) {
		t.Fatalf("installed path %q does not use managed npm cache", path)
	}
	status := installer.Status(adapter)
	if !status.Installed || status.Source != "npm" || status.Version != "1.2.3" {
		t.Fatalf("unexpected status: %#v", status)
	}
	if status.SelectedPath != path || status.CachePath == "" {
		t.Fatalf("status paths not populated: %#v", status)
	}
}

func TestInstallWithOptions_RecommendedNPMRecordsResolvedProvenance(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	var calls []string
	installer.runCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if name != "npm" {
			t.Fatalf("runner command = %q, want npm", name)
		}
		if len(args) > 0 && args[0] == "view" {
			if args[1] != "example-ls@1.2.3" {
				t.Fatalf("npm view package = %q, want recommended version", args[1])
			}
			return []byte(`{"version":"1.2.3","dist.integrity":"sha512-registry-integrity"}`), nil
		}
		var prefix string
		for index, arg := range args {
			if arg == "--prefix" && index+1 < len(args) {
				prefix = args[index+1]
			}
		}
		binDir := filepath.Join(prefix, "node_modules", ".bin")
		if err := os.MkdirAll(binDir, 0755); err != nil {
			t.Fatal(err)
		}
		binaryName := "example-ls"
		if runtime.GOOS == "windows" {
			binaryName += ".cmd"
		}
		if err := os.WriteFile(filepath.Join(binDir, binaryName), []byte("shim"), 0755); err != nil {
			t.Fatal(err)
		}
		return []byte("installed"), nil
	}
	adapter := &mockAdapter{id: "recommended-npm", runtimeDeps: []RuntimeDependency{{
		ID:                   "example-ls",
		Version:              "latest",
		RecommendedVersion:   "1.2.3",
		RecommendedIntegrity: "sha512-registry-integrity",
		Source:               "npm",
		ArchiveType:          "npm",
		PackageName:          "example-ls",
		BinaryName:           "example-ls",
	}}}

	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !strings.Contains(calls[1], "example-ls@1.2.3") {
		t.Fatalf("npm calls = %#v, want view then pinned install", calls)
	}
	status := installer.Status(adapter)
	if !status.Installed || status.SelectedPath != path {
		t.Fatalf("unexpected install status: %#v", status)
	}
	if status.RequestedVersion != "recommended" || status.ResolvedVersion != "1.2.3" || status.Version != "1.2.3" {
		t.Fatalf("version provenance missing: %#v", status)
	}
	if status.SourceLocation != "example-ls@1.2.3" || status.Integrity != "sha512-registry-integrity" {
		t.Fatalf("source/integrity provenance missing: %#v", status)
	}
	if !status.Verified || status.InstalledAt == "" {
		t.Fatalf("recommended install must be marked verified with timestamp: %#v", status)
	}
}

func TestParseNPMMetadataSupportsDottedNestedAndArrayForms(t *testing.T) {
	tests := []struct {
		name string
		data string
	}{
		{name: "dotted", data: `{"version":"1.2.3","dist.integrity":"sha512-dotted"}`},
		{name: "nested", data: `{"version":"1.2.3","dist":{"integrity":"sha512-nested"}}`},
		{name: "array", data: `[{"version":"1.2.2","dist.integrity":"old"},{"version":"1.2.3","dist.integrity":"sha512-array"}]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			version, integrity, err := parseNPMMetadata([]byte(test.data))
			if err != nil {
				t.Fatal(err)
			}
			if version != "1.2.3" || !strings.HasPrefix(integrity, "sha512-") {
				t.Fatalf("metadata = %q/%q", version, integrity)
			}
		})
	}
}

func TestInstallWithOptions_LegacyLatestIsNotVerifiedRecommended(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	installer.runCommand = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "view" {
			t.Fatal("legacy Version:latest must not be reinterpreted as recommended metadata")
		}
		var prefix string
		for index, arg := range args {
			if arg == "--prefix" && index+1 < len(args) {
				prefix = args[index+1]
			}
		}
		binDir := filepath.Join(prefix, "node_modules", ".bin")
		if err := os.MkdirAll(binDir, 0755); err != nil {
			t.Fatal(err)
		}
		name := "legacy-ls"
		if runtime.GOOS == "windows" {
			name += ".cmd"
		}
		return []byte("ok"), os.WriteFile(filepath.Join(binDir, name), []byte("shim"), 0755)
	}
	adapter := &mockAdapter{id: "legacy-latest", runtimeDeps: []RuntimeDependency{{
		Version: "latest", Source: "npm", ArchiveType: "npm", PackageName: "legacy-ls", BinaryName: "legacy-ls",
	}}}
	if _, err := installer.Install(context.Background(), adapter); err != nil {
		t.Fatal(err)
	}
	status := installer.Status(adapter)
	if status.Verified || status.RequestedVersion != "legacy-default" {
		t.Fatalf("legacy latest provenance was dishonest: %#v", status)
	}
}

func TestInstallWithOptions_FailedUpdatePreservesPreviousSelection(t *testing.T) {
	content, sha := createTestBinary()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(content) }))
	defer server.Close()
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	base := &mockAdapter{id: "preserve", runtimeDeps: []RuntimeDependency{{
		Version: "1.0.0", RecommendedVersion: "1.0.0", RecommendedIntegrity: "sha256:" + sha, URL: server.URL, SHA256: sha, ArchiveType: "binary", BinaryName: "server",
	}}}
	firstPath, err := installer.Install(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	adapter := &resolvingMockAdapter{mockAdapter: base, resolve: func(_ context.Context, dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
		dep.Version = selector.Version
		dep.URL = "http://127.0.0.1:1/unavailable"
		return DependencyResolution{Dependency: dep, RequestedVersion: selector.Version, ResolvedVersion: selector.Version, Source: dep.URL, Integrity: "sha256:" + dep.SHA256}, nil
	}}
	if _, err := installer.InstallWithOptions(context.Background(), adapter, InstallOptions{Selector: InstallSelector{Version: "2.0.0"}}); err == nil {
		t.Fatal("expected failed update")
	}
	status := installer.Status(base)
	if !status.Installed || status.SelectedPath != firstPath || status.ResolvedVersion != "1.0.0" {
		t.Fatalf("failed update replaced previous selection: %#v", status)
	}
	if _, err := os.Stat(firstPath); err != nil {
		t.Fatalf("previous selected binary was removed: %v", err)
	}
}

func TestInstallWithOptions_ReleaseAdapterResolverAndSelectedCleanup(t *testing.T) {
	content, sha := createTestBinary()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(content) }))
	defer server.Close()
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	base := &mockAdapter{id: "release", runtimeDeps: []RuntimeDependency{{
		Version: "1.0.0", RecommendedVersion: "1.0.0", RecommendedIntegrity: "sha256:" + sha, URL: server.URL, SHA256: sha, ArchiveType: "binary", BinaryName: "release-ls",
	}}}
	adapter := &resolvingMockAdapter{mockAdapter: base, resolve: func(_ context.Context, dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
		version := dep.RecommendedVersion
		requested := "recommended"
		if selector.Latest {
			version, requested = "2.0.0", "latest"
		}
		dep.Version = version
		return DependencyResolution{Dependency: dep, RequestedVersion: requested, ResolvedVersion: version, Source: dep.URL, Integrity: "sha256:" + dep.SHA256, Verified: version == dep.RecommendedVersion}, nil
	}}
	first, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatal(err)
	}
	second, err := installer.InstallWithOptions(context.Background(), adapter, InstallOptions{Selector: InstallSelector{Latest: true}})
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !strings.Contains(second, "2.0.0") {
		t.Fatalf("release resolver did not select latest version: first=%q second=%q", first, second)
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("old selected version was not cleaned up: %v", err)
	}
	status := installer.Status(adapter)
	if status.RequestedVersion != "latest" || status.ResolvedVersion != "2.0.0" || status.Verified {
		t.Fatalf("latest provenance incorrect: %#v", status)
	}
}

func TestInstallWithOptions_RejectsConflictingSelectors(t *testing.T) {
	installer := NewInstaller(t.TempDir())
	adapter := &mockAdapter{id: "conflict", runtimeDeps: []RuntimeDependency{{BinaryName: "server"}}}
	_, err := installer.InstallWithOptions(context.Background(), adapter, InstallOptions{Selector: InstallSelector{Latest: true, Version: "1.0.0"}})
	if err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
		t.Fatalf("conflicting selector error = %v", err)
	}
}

func TestNormalizeResolutionDerivesVerifiedFromPinnedIntegrity(t *testing.T) {
	tests := []struct {
		name       string
		original   RuntimeDependency
		resolution DependencyResolution
		verified   bool
		integrity  string
	}{
		{
			name:       "release ignores resolver assertion",
			original:   RuntimeDependency{RecommendedVersion: "1.0.0", RecommendedIntegrity: "sha256:pinned", BinaryName: "server"},
			resolution: DependencyResolution{Dependency: RuntimeDependency{Version: "1.0.0", SHA256: "actual", BinaryName: "server"}, ResolvedVersion: "1.0.0", Integrity: "sha256:pinned", Verified: true},
			integrity:  "sha256:actual",
		},
		{
			name:       "npm requires exact registry sri",
			original:   RuntimeDependency{RecommendedVersion: "1.0.0", RecommendedIntegrity: "sha512-PINNED", Source: "npm", PackageName: "server", BinaryName: "server"},
			resolution: DependencyResolution{Dependency: RuntimeDependency{Version: "1.0.0", Source: "npm", PackageName: "server", BinaryName: "server"}, ResolvedVersion: "1.0.0", Integrity: "sha512-pinned", Verified: true},
			integrity:  "sha512-pinned",
		},
		{
			name:       "npm exact pin verifies",
			original:   RuntimeDependency{RecommendedVersion: "1.0.0", RecommendedIntegrity: "sha512-exact", Source: "npm", PackageName: "server", BinaryName: "server"},
			resolution: DependencyResolution{Dependency: RuntimeDependency{Version: "1.0.0", Source: "npm", PackageName: "server", BinaryName: "server"}, ResolvedVersion: "1.0.0", Integrity: "sha512-exact"},
			verified:   true, integrity: "sha512-exact",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selector := InstallSelector{}
			if !test.verified {
				selector.Version = test.original.RecommendedVersion
			}
			got, err := normalizeResolution(test.original, selector, test.resolution)
			if err != nil {
				t.Fatal(err)
			}
			if got.Verified != test.verified || got.Integrity != test.integrity {
				t.Fatalf("resolution = %#v, want verified=%v integrity=%q", got, test.verified, test.integrity)
			}
		})
	}
}

func TestNormalizeResolutionRejectsRecommendedIntegrityMismatch(t *testing.T) {
	original := RuntimeDependency{
		RecommendedVersion:   "1.0.0",
		RecommendedIntegrity: "sha256:pinned",
		BinaryName:           "server",
	}
	_, err := normalizeResolution(original, InstallSelector{}, DependencyResolution{
		Dependency:      RuntimeDependency{Version: "1.0.0", SHA256: "different", BinaryName: "server"},
		ResolvedVersion: "1.0.0",
		Verified:        true,
	})
	if err == nil || !strings.Contains(err.Error(), "integrity mismatch") {
		t.Fatalf("recommended mismatch error = %v", err)
	}
}

func TestInstallWithOptions_IndependentInstallersSerializeAndCoalesce(t *testing.T) {
	baseDir := t.TempDir()
	adapter := &mockAdapter{id: "cross-process", runtimeDeps: []RuntimeDependency{{
		Version: "1.0.0", Source: "npm", ArchiveType: "npm", PackageName: "cross-process-ls", BinaryName: "cross-process-ls",
	}}}
	var active, maximum, installs, callbacks atomic.Int32
	newInstaller := func() *Installer {
		installer := NewInstaller(baseDir)
		installer.runCommand = func(_ context.Context, _ string, args ...string) ([]byte, error) {
			installs.Add(1)
			current := active.Add(1)
			defer active.Add(-1)
			for current > maximum.Load() && !maximum.CompareAndSwap(maximum.Load(), current) {
			}
			time.Sleep(120 * time.Millisecond)
			var prefix string
			for index, arg := range args {
				if arg == "--prefix" && index+1 < len(args) {
					prefix = args[index+1]
				}
			}
			binDir := filepath.Join(prefix, "node_modules", ".bin")
			if err := os.MkdirAll(binDir, 0o755); err != nil {
				return nil, err
			}
			name := "cross-process-ls"
			if runtime.GOOS == "windows" {
				name += ".cmd"
			}
			return []byte("ok"), os.WriteFile(filepath.Join(binDir, name), []byte("shim"), 0o755)
		}
		return installer
	}
	installers := []*Installer{newInstaller(), newInstaller()}
	start := make(chan struct{})
	paths := make([]string, len(installers))
	errs := make([]error, len(installers))
	var wg sync.WaitGroup
	for index, installer := range installers {
		wg.Add(1)
		go func(index int, installer *Installer) {
			defer wg.Done()
			<-start
			paths[index], errs[index] = installer.InstallWithOptions(context.Background(), adapter, InstallOptions{
				BeforeCleanup: func(string) error { callbacks.Add(1); return nil },
			})
		}(index, installer)
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if paths[0] != paths[1] || installs.Load() != 1 || maximum.Load() != 1 {
		t.Fatalf("paths=%#v installs=%d max-active=%d", paths, installs.Load(), maximum.Load())
	}
	if callbacks.Load() != 2 {
		t.Fatalf("activation callbacks = %d, want one per installer", callbacks.Load())
	}
}

func TestInstallWithOptions_SameVersionSelectionWriteFailureRollsBack(t *testing.T) {
	content, sha := createTestBinary()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(content) }))
	defer server.Close()
	installer := NewInstaller(t.TempDir())
	adapter := &mockAdapter{id: "same-version", runtimeDeps: []RuntimeDependency{{
		Version: "1.0.0", URL: server.URL, SHA256: sha, ArchiveType: "binary", BinaryName: "same-version-ls",
	}}}
	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatal(err)
	}
	selectionPath := filepath.Join(installer.baseDir, adapter.ID(), ".selected.json")
	selectionBefore, err := os.ReadFile(selectionPath)
	if err != nil {
		t.Fatal(err)
	}
	installer.writeSelectionOverride = func(LanguageAdapter, DependencyResolution, string) error {
		return fmt.Errorf("forced selection write failure")
	}
	if _, err := installer.Install(context.Background(), adapter); err == nil || !strings.Contains(err.Error(), "forced") {
		t.Fatalf("selection write error = %v", err)
	}
	selectionAfter, err := os.ReadFile(selectionPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(selectionAfter) != string(selectionBefore) {
		t.Fatal("failed same-version update changed selected provenance")
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(content) {
		t.Fatalf("previous selected binary was not restored: content=%q err=%v", got, err)
	}
}

func TestInstallWithOptions_BeforeCleanupRunsWhileOldVersionExists(t *testing.T) {
	content, sha := createTestBinary()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(content) }))
	defer server.Close()
	base := &mockAdapter{id: "activation-order", runtimeDeps: []RuntimeDependency{{
		Version: "1.0.0", URL: server.URL, SHA256: sha, ArchiveType: "binary", BinaryName: "activation-ls",
	}}}
	adapter := &resolvingMockAdapter{mockAdapter: base, resolve: func(_ context.Context, dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
		dep.Version = selector.Version
		return DependencyResolution{Dependency: dep, ResolvedVersion: selector.Version, Source: dep.URL}, nil
	}}
	installer := NewInstaller(t.TempDir())
	oldPath, err := installer.Install(context.Background(), base)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	newPath, err := installer.InstallWithOptions(context.Background(), adapter, InstallOptions{
		Selector: InstallSelector{Version: "2.0.0"},
		BeforeCleanup: func(path string) error {
			called = true
			if _, err := os.Stat(oldPath); err != nil {
				return fmt.Errorf("old version removed before activation refresh: %w", err)
			}
			if status := installer.Status(adapter); status.SelectedPath != path {
				return fmt.Errorf("new selection not visible during activation: %#v", status)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !called || newPath == oldPath {
		t.Fatalf("callback=%v old=%q new=%q", called, oldPath, newPath)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("old version remains after cleanup: %v", err)
	}
}

func TestDependencyVersionIDPreservesSimpleIDsAndAvoidsNormalizedCollisions(t *testing.T) {
	if got := dependencyVersionID(RuntimeDependency{Version: "v1.2.3"}); got != "v1.2.3" {
		t.Fatalf("simple semver ID changed to %q", got)
	}
	slashed := dependencyVersionID(RuntimeDependency{Version: "release/a"})
	underscored := dependencyVersionID(RuntimeDependency{Version: "release_a"})
	if slashed == underscored || strings.ContainsAny(slashed, `/\\`) {
		t.Fatalf("collision-resistant IDs = %q and %q", slashed, underscored)
	}
}

func TestStatusReadsLegacySelectionWithoutProvenance(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	adapter := &mockAdapter{id: "legacy-selection", runtimeDeps: []RuntimeDependency{{Version: "1.0.0", BinaryName: "legacy-ls"}}}
	selectedPath := filepath.Join(baseDir, adapter.ID(), "legacy-ls-1.0.0", "legacy-ls")
	if err := os.MkdirAll(filepath.Dir(selectedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(selectedPath, []byte("legacy"), 0o755); err != nil {
		t.Fatal(err)
	}
	legacyJSON := fmt.Sprintf(`{"version":"1.0.0","version_id":"1.0.0","source":"binary","cache_path":%q,"selected_path":%q}`, filepath.Dir(selectedPath), selectedPath)
	if err := os.WriteFile(filepath.Join(baseDir, adapter.ID(), ".selected.json"), []byte(legacyJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	status := installer.Status(adapter)
	if !status.Installed || status.Version != "1.0.0" || status.ResolvedVersion != "1.0.0" {
		t.Fatalf("legacy selection was not read compatibly: %#v", status)
	}
	if status.RequestedVersion != "" || status.Verified || status.InstalledAt != "" {
		t.Fatalf("legacy selection invented provenance: %#v", status)
	}
}

func TestInstall_NPMDependencyRecordsInstallError(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	installer.runCommand = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("network down"), fmt.Errorf("exit 1")
	}
	adapter := &mockAdapter{
		id: "npmfail",
		runtimeDeps: []RuntimeDependency{{
			ID:          "broken-ls",
			Version:     "latest",
			Source:      "npm",
			ArchiveType: "npm",
			BinaryName:  "broken-ls",
			PackageName: "broken-ls",
		}},
	}

	if _, err := installer.Install(context.Background(), adapter); err == nil {
		t.Fatal("expected install error")
	}
	status := installer.Status(adapter)
	if status.InstallError == "" || !strings.Contains(status.InstallError, "network down") {
		t.Fatalf("status InstallError = %q, want npm output", status.InstallError)
	}
	if status.Installed {
		t.Fatal("failed install should not be selected")
	}
}

func TestInstall_NuGetDependencyExtractsPackage(t *testing.T) {
	rid := "linux-x64"
	serverPath := "content/LanguageServer/" + rid + "/Microsoft.CodeAnalysis.LanguageServer.dll"
	content, err := createTestZip(map[string][]byte{
		serverPath:                          []byte("dll"),
		"content/LanguageServer/readme.txt": []byte("keep package contents"),
	})
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(content)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer server.Close()

	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)
	adapter := &mockAdapter{
		id: "csharp",
		runtimeDeps: []RuntimeDependency{{
			ID:          "Microsoft.CodeAnalysis.LanguageServer.linux-x64",
			Version:     "5.0.0-test",
			Source:      "nuget",
			ArchiveType: "nupkg",
			PackageName: "Microsoft.CodeAnalysis.LanguageServer.linux-x64",
			URL:         server.URL + "/package.nupkg",
			SHA256:      hex.EncodeToString(hash[:]),
			BinaryName:  "Microsoft.CodeAnalysis.LanguageServer.dll",
			ExtractPath: serverPath,
		}},
	}

	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}
	if !strings.HasSuffix(filepath.ToSlash(path), serverPath) {
		t.Fatalf("installed path = %q, want suffix %q", path, serverPath)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(path)), "readme.txt")); err != nil {
		t.Fatalf("expected full NuGet package contents to be extracted: %v", err)
	}
	status := installer.Status(adapter)
	if !status.Installed || status.Source != "nuget" || status.Version != "5.0.0-test" {
		t.Fatalf("unexpected status: %#v", status)
	}
	if status.SelectedPath != path || status.CachePath == "" {
		t.Fatalf("status paths not populated: %#v", status)
	}
}

func TestInstall_TarGz(t *testing.T) {
	binaryContent := []byte("#!/bin/sh\necho from tar\n")
	extractPath := "bin/my-server"

	archiveData, err := createTestTarGz(extractPath, binaryContent)
	if err != nil {
		t.Fatalf("failed to create test tar.gz: %v", err)
	}

	archiveSHA := sha256.Sum256(archiveData)
	shaHex := hex.EncodeToString(archiveSHA[:])

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(archiveData)
	}))
	defer server.Close()

	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	adapter := &mockAdapter{
		id: "tartest",
		runtimeDeps: []RuntimeDependency{
			{
				ID:          "v2.0.0",
				PlatformID:  CurrentPlatformID(),
				URL:         server.URL + "/archive.tar.gz",
				SHA256:      shaHex,
				ArchiveType: "tar.gz",
				BinaryName:  "my-server",
				ExtractPath: extractPath,
			},
		},
	}

	path, err := installer.Install(context.Background(), adapter)
	if err != nil {
		t.Fatalf("Install failed: %v", err)
	}

	// Verify the extracted binary content.
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read installed binary: %v", err)
	}
	if string(got) != string(binaryContent) {
		t.Errorf("binary content mismatch: got %q, want %q", got, binaryContent)
	}
}

func TestInstall_SHA256Mismatch(t *testing.T) {
	content, _ := createTestBinary()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(content)
	}))
	defer server.Close()

	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	adapter := &mockAdapter{
		id: "badsha",
		runtimeDeps: []RuntimeDependency{
			{
				ID:          "v1.0.0",
				PlatformID:  CurrentPlatformID(),
				URL:         server.URL + "/binary",
				SHA256:      "0000000000000000000000000000000000000000000000000000000000000000",
				ArchiveType: "binary",
				BinaryName:  "bad-server",
			},
		},
	}

	path, err := installer.Install(context.Background(), adapter)
	if err == nil {
		t.Fatal("expected error for SHA-256 mismatch, got nil")
	}
	if path != "" {
		t.Errorf("expected empty path on error, got: %s", path)
	}

	// Verify cleanup: the version directory should not exist.
	versionDir := filepath.Join(baseDir, "badsha", "bad-server-v1.0.0")
	if _, err := os.Stat(versionDir); !os.IsNotExist(err) {
		t.Error("expected version directory to be cleaned up after SHA-256 mismatch")
	}
}

func TestInstall_ConcurrentPrevention(t *testing.T) {
	content, sha := createTestBinary()

	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount.Add(1)
		// Simulate slow download.
		time.Sleep(100 * time.Millisecond)
		w.Write(content)
	}))
	defer server.Close()

	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	adapter := &mockAdapter{
		id: "concurrent",
		runtimeDeps: []RuntimeDependency{
			{
				ID:          "v1.0.0",
				PlatformID:  CurrentPlatformID(),
				URL:         server.URL + "/binary",
				SHA256:      sha,
				ArchiveType: "binary",
				BinaryName:  "concurrent-server",
			},
		},
	}

	var wg sync.WaitGroup
	results := make([]string, 2)
	errors := make([]error, 2)

	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			path, err := installer.Install(context.Background(), adapter)
			results[idx] = path
			errors[idx] = err
		}(i)
	}

	wg.Wait()

	// Both should succeed.
	for i, err := range errors {
		if err != nil {
			t.Errorf("goroutine %d failed: %v", i, err)
		}
	}

	// Only one HTTP request should have been made (second waits for first).
	count := requestCount.Load()
	if count != 1 {
		t.Errorf("expected 1 HTTP request (concurrent prevention), got %d", count)
	}
}

func TestCleanup_RemovesOldVersionsOnlyAfterNewerSelection(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	langDir := filepath.Join(baseDir, "cleantest")

	dirs := []string{"server-v1.0.0", "server-v2.0.0", "server-v3.0.0"}
	for _, d := range dirs {
		dirPath := filepath.Join(langDir, d)
		if err := os.MkdirAll(dirPath, 0755); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(dirPath, "server"), []byte("bin"), 0755)
	}

	if err := installer.Cleanup("cleantest"); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}
	if got := countDirs(t, langDir); got != 3 {
		t.Fatalf("cleanup without selected version removed dirs, got %d", got)
	}

	adapter := &mockAdapter{
		id: "cleantest",
		runtimeDeps: []RuntimeDependency{{
			ID:          "v3.0.0",
			PlatformID:  CurrentPlatformID(),
			ArchiveType: "binary",
			BinaryName:  "server",
		}},
	}
	selectedPath := filepath.Join(langDir, "server-v3.0.0", "server")
	if err := installer.writeSelection(adapter, adapter.runtimeDeps[0], selectedPath); err != nil {
		t.Fatal(err)
	}

	if err := installer.Cleanup("cleantest"); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}
	var names []string
	entries, err := os.ReadDir(langDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	if len(names) != 1 {
		t.Errorf("expected 1 directory after cleanup, got %d: %v", len(names), names)
	}

	if names[0] != "server-v3.0.0" {
		t.Errorf("expected server-v3.0.0 to remain, got %s", names[0])
	}
}

func countDirs(t *testing.T, path string) int {
	t.Helper()
	entries, err := os.ReadDir(path)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if entry.IsDir() {
			count++
		}
	}
	return count
}

func TestRemove(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	langDir := filepath.Join(baseDir, "removeme")
	os.MkdirAll(filepath.Join(langDir, "server-v1.0.0"), 0755)
	os.WriteFile(filepath.Join(langDir, "server-v1.0.0", "server"), []byte("bin"), 0755)

	err := installer.Remove("removeme")
	if err != nil {
		t.Fatalf("Remove failed: %v", err)
	}

	if _, err := os.Stat(langDir); !os.IsNotExist(err) {
		t.Error("expected language directory to be removed")
	}
}

func TestCurrentPlatformID(t *testing.T) {
	expected := fmt.Sprintf("%s-%s", runtime.GOOS, runtime.GOARCH)
	got := CurrentPlatformID()
	if got != expected {
		t.Errorf("CurrentPlatformID() = %s, want %s", got, expected)
	}
}

func TestDependencyBinaryPath_WindowsNPMUsesCmdShim(t *testing.T) {
	dep := RuntimeDependency{Source: "npm", PackageName: "yaml-language-server", BinaryName: "yaml-language-server"}
	got := filepath.ToSlash(dependencyBinaryPath("cache", dep, "windows"))
	if got != "cache/node_modules/.bin/yaml-language-server.cmd" {
		t.Fatalf("Windows npm binary path = %q", got)
	}
}
