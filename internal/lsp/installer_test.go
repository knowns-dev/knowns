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
	runtimeDeps []RuntimeDependency
}

func (m *mockAdapter) ID() string                                                 { return m.id }
func (m *mockAdapter) Name() string                                               { return m.id }
func (m *mockAdapter) Extensions() []string                                       { return m.extensions }
func (m *mockAdapter) Binaries() []BinaryCandidate                                { return nil }
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
		if err := os.WriteFile(filepath.Join(binDir, "test-ls"), []byte("#!/bin/sh\n"), 0755); err != nil {
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
	if !strings.Contains(path, filepath.Join("npmtest", "test-ls-1.2.3", "node_modules", ".bin", "test-ls")) {
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
