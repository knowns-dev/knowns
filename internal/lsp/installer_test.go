package lsp

import (
	"archive/tar"
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
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// mockAdapter implements LanguageAdapter for testing.
type mockAdapter struct {
	id          string
	runtimeDeps []RuntimeDependency
}

func (m *mockAdapter) ID() string                        { return m.id }
func (m *mockAdapter) Name() string                      { return m.id }
func (m *mockAdapter) Extensions() []string              { return nil }
func (m *mockAdapter) Binaries() []BinaryCandidate       { return nil }
func (m *mockAdapter) Prerequisites() []Prerequisite     { return nil }
func (m *mockAdapter) CheckPrerequisites(context.Context) error { return nil }
func (m *mockAdapter) InstallGuide() InstallGuide        { return InstallGuide{} }
func (m *mockAdapter) CanInstall() bool                  { return true }
func (m *mockAdapter) RuntimeDeps() []RuntimeDependency  { return m.runtimeDeps }
func (m *mockAdapter) Install(_ context.Context, _ string) (string, error) { return "", nil }
func (m *mockAdapter) InstalledPath() (string, bool)     { return "", false }
func (m *mockAdapter) DefaultArgs() []string             { return nil }
func (m *mockAdapter) InitializeParams(_ string, _ map[string]any) map[string]any { return nil }
func (m *mockAdapter) InitializationOptions(_ map[string]any) map[string]any { return nil }
func (m *mockAdapter) IsIgnoredDir(_ string) bool        { return false }
func (m *mockAdapter) NormalizeSymbolName(n string) string { return n }
func (m *mockAdapter) SupportsImplementation() bool      { return false }
func (m *mockAdapter) SupportsReferences() bool          { return false }

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

func TestCleanup_RemovesOldVersions(t *testing.T) {
	baseDir := t.TempDir()
	installer := NewInstaller(baseDir)

	langDir := filepath.Join(baseDir, "cleantest")

	// Create multiple version directories with different mod times.
	dirs := []string{"server-v1.0.0", "server-v2.0.0", "server-v3.0.0"}
	for i, d := range dirs {
		dirPath := filepath.Join(langDir, d)
		if err := os.MkdirAll(dirPath, 0755); err != nil {
			t.Fatal(err)
		}
		// Write a file so the directory isn't empty.
		os.WriteFile(filepath.Join(dirPath, "server"), []byte("bin"), 0755)
		// Set different mod times (v3 is newest).
		modTime := time.Now().Add(time.Duration(i) * time.Hour)
		os.Chtimes(dirPath, modTime, modTime)
	}

	err := installer.Cleanup("cleantest")
	if err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}

	// Only the newest (v3.0.0) should remain.
	entries, err := os.ReadDir(langDir)
	if err != nil {
		t.Fatal(err)
	}

	if len(entries) != 1 {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("expected 1 directory after cleanup, got %d: %v", len(entries), names)
	}

	if entries[0].Name() != "server-v3.0.0" {
		t.Errorf("expected server-v3.0.0 to remain, got %s", entries[0].Name())
	}
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
