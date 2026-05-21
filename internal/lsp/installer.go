package lsp

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// CurrentPlatformID returns the current platform identifier (e.g. "darwin-arm64").
func CurrentPlatformID() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// Installer handles downloading, extracting, and verifying LSP server binaries.
type Installer struct {
	baseDir    string // ~/.knowns/lsp-servers/
	mu         sync.Mutex
	installing map[string]chan struct{} // prevent concurrent installs of same language
}

// NewInstaller creates a new Installer with the given base directory.
func NewInstaller(baseDir string) *Installer {
	return &Installer{
		baseDir:    baseDir,
		installing: make(map[string]chan struct{}),
	}
}

// Install downloads and installs an LSP server for the given adapter.
// Returns the path to the installed binary.
// User-initiated only (called from `knowns lsp install`).
func (i *Installer) Install(ctx context.Context, adapter LanguageAdapter) (string, error) {
	langID := adapter.ID()

	// Concurrent install prevention: if another goroutine is installing the same language, wait.
	i.mu.Lock()
	if ch, ok := i.installing[langID]; ok {
		i.mu.Unlock()
		select {
		case <-ch:
			// Previous install finished, check if it succeeded.
			path, ok := i.IsInstalled(adapter)
			if !ok {
				return "", fmt.Errorf("concurrent install of %s failed", langID)
			}
			return path, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	ch := make(chan struct{})
	i.installing[langID] = ch
	i.mu.Unlock()

	defer func() {
		i.mu.Lock()
		delete(i.installing, langID)
		close(ch)
		i.mu.Unlock()
	}()

	// Find the runtime dependency for the current platform.
	dep, err := i.findDep(adapter)
	if err != nil {
		return "", err
	}

	// Create the version directory.
	versionDir := filepath.Join(i.baseDir, langID, dep.BinaryName+"-"+dep.ID)
	if err := os.MkdirAll(versionDir, 0755); err != nil {
		return "", fmt.Errorf("create version dir: %w", err)
	}

	// Download the file.
	tmpFile, err := i.download(ctx, dep.URL)
	if err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("download: %w", err)
	}
	defer os.Remove(tmpFile)

	// Verify SHA-256.
	if err := i.verifySHA256(tmpFile, dep.SHA256); err != nil {
		os.RemoveAll(versionDir)
		return "", err
	}

	// Extract or copy the binary.
	binaryPath := filepath.Join(versionDir, dep.BinaryName)
	if runtime.GOOS == "windows" {
		binaryPath += ".exe"
	}
	if err := i.extract(tmpFile, binaryPath, dep); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("extract: %w", err)
	}

	// Set executable permissions.
	if err := os.Chmod(binaryPath, 0755); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("chmod: %w", err)
	}

	// Cleanup old versions.
	_ = i.Cleanup(langID)

	return binaryPath, nil
}

// IsInstalled checks if the adapter's LSP server is already installed.
// Returns (binaryPath, true) if found, ("", false) otherwise.
func (i *Installer) IsInstalled(adapter LanguageAdapter) (string, bool) {
	dep, err := i.findDep(adapter)
	if err != nil {
		return "", false
	}

	versionDir := filepath.Join(i.baseDir, adapter.ID(), dep.BinaryName+"-"+dep.ID)
	binaryPath := filepath.Join(versionDir, dep.BinaryName)
	if runtime.GOOS == "windows" {
		binaryPath += ".exe"
	}

	if _, err := os.Stat(binaryPath); err == nil {
		return binaryPath, true
	}
	return "", false
}

// Remove removes all installed versions for a language.
func (i *Installer) Remove(languageID string) error {
	langDir := filepath.Join(i.baseDir, languageID)
	return os.RemoveAll(langDir)
}

// Cleanup removes old versions for a language, keeping only the latest.
func (i *Installer) Cleanup(languageID string) error {
	langDir := filepath.Join(i.baseDir, languageID)
	entries, err := os.ReadDir(langDir)
	if err != nil {
		return err
	}

	if len(entries) <= 1 {
		return nil
	}

	// Sort by modification time (newest first).
	type dirInfo struct {
		name    string
		modTime int64
	}
	var dirs []dirInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		dirs = append(dirs, dirInfo{name: e.Name(), modTime: info.ModTime().UnixNano()})
	}

	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i].modTime > dirs[j].modTime
	})

	// Remove all but the newest.
	for idx := 1; idx < len(dirs); idx++ {
		os.RemoveAll(filepath.Join(langDir, dirs[idx].name))
	}

	return nil
}

// findDep finds the RuntimeDependency matching the current platform.
func (i *Installer) findDep(adapter LanguageAdapter) (RuntimeDependency, error) {
	platform := CurrentPlatformID()
	for _, dep := range adapter.RuntimeDeps() {
		if dep.PlatformID == platform {
			return dep, nil
		}
	}
	return RuntimeDependency{}, fmt.Errorf("no runtime dependency for platform %s", platform)
}

// download fetches a URL to a temporary file and returns the path.
func (i *Installer) download(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	tmpFile, err := os.CreateTemp("", "knowns-lsp-download-*")
	if err != nil {
		return "", err
	}
	defer tmpFile.Close()

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		os.Remove(tmpFile.Name())
		return "", err
	}

	return tmpFile.Name(), nil
}

// verifySHA256 computes the SHA-256 hash of a file and compares it to the expected value.
func (i *Installer) verifySHA256(filePath, expected string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}

	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("SHA-256 mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

// extract handles archive extraction or raw binary copy based on ArchiveType.
func (i *Installer) extract(archivePath, binaryPath string, dep RuntimeDependency) error {
	switch dep.ArchiveType {
	case "tar.gz":
		return i.extractTarGz(archivePath, binaryPath, dep.ExtractPath)
	case "zip":
		return i.extractZip(archivePath, binaryPath, dep.ExtractPath)
	case "binary":
		return i.copyBinary(archivePath, binaryPath)
	default:
		return fmt.Errorf("unsupported archive type: %s", dep.ArchiveType)
	}
}

// extractTarGz extracts a specific file from a tar.gz archive.
func (i *Installer) extractTarGz(archivePath, binaryPath, extractPath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		// Match the extract path within the archive.
		if hdr.Name == extractPath || strings.HasSuffix(hdr.Name, "/"+extractPath) {
			out, err := os.OpenFile(binaryPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
			if err != nil {
				return err
			}
			defer out.Close()

			if _, err := io.Copy(out, tr); err != nil {
				return err
			}
			return nil
		}
	}

	return fmt.Errorf("file %q not found in tar.gz archive", extractPath)
}

// extractZip extracts a specific file from a zip archive.
func (i *Installer) extractZip(archivePath, binaryPath, extractPath string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		if f.Name == extractPath || strings.HasSuffix(f.Name, "/"+extractPath) {
			rc, err := f.Open()
			if err != nil {
				return err
			}
			defer rc.Close()

			out, err := os.OpenFile(binaryPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
			if err != nil {
				return err
			}
			defer out.Close()

			if _, err := io.Copy(out, rc); err != nil {
				return err
			}
			return nil
		}
	}

	return fmt.Errorf("file %q not found in zip archive", extractPath)
}

// copyBinary copies a raw binary file to the target path.
func (i *Installer) copyBinary(srcPath, dstPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	defer dst.Close()

	_, err = io.Copy(dst, src)
	return err
}
