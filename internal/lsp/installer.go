package lsp

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	runCommand func(context.Context, string, ...string) ([]byte, error)
}

// NewInstaller creates a new Installer with the given base directory.
func NewInstaller(baseDir string) *Installer {
	return &Installer{
		baseDir:    baseDir,
		installing: make(map[string]chan struct{}),
		runCommand: defaultRunCommand,
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

	dep, err := i.findDep(adapter)
	if err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}

	path, err := i.installDependency(ctx, adapter, dep)
	if err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}
	if err := i.writeSelection(adapter, dep, path); err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}
	_ = i.clearLastError(langID)
	_ = i.Cleanup(langID)
	return path, nil
}

// IsInstalled checks if the adapter's LSP server is already installed.
// Returns (binaryPath, true) if found, ("", false) otherwise.
func (i *Installer) IsInstalled(adapter LanguageAdapter) (string, bool) {
	if selection, ok := i.readSelection(adapter.ID()); ok && selection.SelectedPath != "" {
		if _, err := os.Stat(selection.SelectedPath); err == nil {
			return selection.SelectedPath, true
		}
	}

	dep, err := i.findDep(adapter)
	if err != nil {
		return "", false
	}

	binaryPath := i.expectedBinaryPath(adapter.ID(), dep)

	if _, err := os.Stat(binaryPath); err == nil {
		return binaryPath, true
	}
	return "", false
}

// Status reports managed dependency state for an adapter.
func (i *Installer) Status(adapter LanguageAdapter) ManagedDependencyStatus {
	status := ManagedDependencyStatus{
		LanguageID:  adapter.ID(),
		Installable: adapter.CanInstall(),
	}
	dep, err := i.findDep(adapter)
	if err != nil {
		status.InstallError = err.Error()
		if last, ok := i.readLastError(adapter.ID()); ok {
			status.InstallError = last.Error
		}
		return status
	}
	status.Version = dependencyVersion(dep)
	status.Source = dependencySource(dep)
	status.CachePath = i.versionDir(adapter.ID(), dep)
	status.SelectedVersionID = dependencyVersionID(dep)
	if selection, ok := i.readSelection(adapter.ID()); ok {
		status.Version = selection.Version
		status.Source = selection.Source
		status.CachePath = selection.CachePath
		status.SelectedPath = selection.SelectedPath
		status.SelectedVersionID = selection.VersionID
		if _, err := os.Stat(selection.SelectedPath); err == nil {
			status.Installed = true
		}
	}
	if last, ok := i.readLastError(adapter.ID()); ok {
		if last.Operation == "update" {
			status.UpdateError = last.Error
		} else {
			status.InstallError = last.Error
		}
	}
	status.CleanupEligible = i.cleanupEligible(adapter.ID(), status.SelectedPath)
	return status
}

// Remove removes all installed versions for a language.
func (i *Installer) Remove(languageID string) error {
	langDir := filepath.Join(i.baseDir, languageID)
	return os.RemoveAll(langDir)
}

// Cleanup removes old versions for a language, keeping only versions other than
// the runtime-selected one. Without a selected version, cleanup is intentionally
// a no-op so a failed install/update cannot remove the last working server.
func (i *Installer) Cleanup(languageID string) error {
	langDir := filepath.Join(i.baseDir, languageID)
	selection, ok := i.readSelection(languageID)
	if !ok || selection.SelectedPath == "" {
		return nil
	}
	selectedDir, ok := i.selectedVersionDir(languageID, selection.SelectedPath)
	if !ok {
		return nil
	}
	entries, err := os.ReadDir(langDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if filepath.Join(langDir, e.Name()) == selectedDir {
			continue
		}
		if err := os.RemoveAll(filepath.Join(langDir, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

// findDep finds the RuntimeDependency matching the current platform.
func (i *Installer) findDep(adapter LanguageAdapter) (RuntimeDependency, error) {
	platform := CurrentPlatformID()
	for _, dep := range adapter.RuntimeDeps() {
		if dep.PlatformID == "" || dep.PlatformID == platform {
			return dep, nil
		}
	}
	return RuntimeDependency{}, fmt.Errorf("no runtime dependency for platform %s", platform)
}

func (i *Installer) installDependency(ctx context.Context, adapter LanguageAdapter, dep RuntimeDependency) (string, error) {
	versionDir := i.versionDir(adapter.ID(), dep)
	if err := os.MkdirAll(versionDir, 0755); err != nil {
		return "", fmt.Errorf("create version dir: %w", err)
	}
	if isNuGetDependency(dep) {
		return i.installNuGet(ctx, versionDir, dep)
	}
	if isNPMDependency(dep) {
		return i.installNPM(ctx, versionDir, dep)
	}
	return i.installArchive(ctx, versionDir, dep)
}

func (i *Installer) installArchive(ctx context.Context, versionDir string, dep RuntimeDependency) (string, error) {
	tmpFile, err := i.download(ctx, dep.URL)
	if err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("download: %w", err)
	}
	defer os.Remove(tmpFile)

	if err := i.verifySHA256(tmpFile, dep.SHA256); err != nil {
		os.RemoveAll(versionDir)
		return "", err
	}

	binaryPath := i.binaryPath(versionDir, dep)
	if err := i.extract(tmpFile, binaryPath, dep); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("extract: %w", err)
	}
	if err := os.Chmod(binaryPath, 0755); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("chmod: %w", err)
	}
	return binaryPath, nil
}

func (i *Installer) installNPM(ctx context.Context, versionDir string, dep RuntimeDependency) (string, error) {
	if err := os.MkdirAll(versionDir, 0755); err != nil {
		return "", fmt.Errorf("create npm prefix: %w", err)
	}
	args := []string{"install", "--prefix", versionDir, "--no-audit", "--no-fund"}
	for _, pkg := range npmPackages(dep) {
		args = append(args, npmPackageSpec(pkg, dependencyVersion(dep)))
	}
	output, err := i.runCommand(ctx, "npm", args...)
	if err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("npm install failed: %w: %s", err, strings.TrimSpace(string(output)))
	}
	binaryPath := i.binaryPath(versionDir, dep)
	if _, err := os.Stat(binaryPath); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("npm install completed but %s was not found: %w", binaryPath, err)
	}
	if runtime.GOOS != "windows" {
		_ = os.Chmod(binaryPath, 0755)
	}
	return binaryPath, nil
}

func (i *Installer) installNuGet(ctx context.Context, versionDir string, dep RuntimeDependency) (string, error) {
	url := dep.URL
	if url == "" {
		url = nugetPackageURL(dep)
	}
	if url == "" {
		return "", fmt.Errorf("nuget package URL is not configured")
	}
	tmpFile, err := i.download(ctx, url)
	if err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("download: %w", err)
	}
	defer os.Remove(tmpFile)

	if dep.SHA256 != "" && !strings.EqualFold(dep.SHA256, "TODO") {
		if err := i.verifySHA256(tmpFile, dep.SHA256); err != nil {
			os.RemoveAll(versionDir)
			return "", err
		}
	}
	if dep.SHA512 != "" && !strings.EqualFold(dep.SHA512, "TODO") {
		if err := i.verifySHA512(tmpFile, dep.SHA512); err != nil {
			os.RemoveAll(versionDir)
			return "", err
		}
	}

	if err := i.extractZipAll(tmpFile, versionDir); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("extract: %w", err)
	}
	binaryPath := i.binaryPath(versionDir, dep)
	if _, err := os.Stat(binaryPath); err != nil {
		os.RemoveAll(versionDir)
		return "", fmt.Errorf("nuget install completed but %s was not found: %w", binaryPath, err)
	}
	return binaryPath, nil
}

func (i *Installer) versionDir(languageID string, dep RuntimeDependency) string {
	return filepath.Join(i.baseDir, languageID, dependencyCacheName(dep)+"-"+dependencyVersionID(dep))
}

func (i *Installer) expectedBinaryPath(languageID string, dep RuntimeDependency) string {
	return i.binaryPath(i.versionDir(languageID, dep), dep)
}

func (i *Installer) binaryPath(versionDir string, dep RuntimeDependency) string {
	if isNPMDependency(dep) {
		name := dep.BinaryName
		if runtime.GOOS == "windows" {
			name += ".cmd"
		}
		return filepath.Join(versionDir, "node_modules", ".bin", name)
	}
	if isNuGetDependency(dep) {
		if dep.ExtractPath != "" {
			return filepath.Join(versionDir, filepath.FromSlash(dep.ExtractPath))
		}
		return filepath.Join(versionDir, dep.BinaryName)
	}
	binaryPath := filepath.Join(versionDir, dep.BinaryName)
	if runtime.GOOS == "windows" {
		binaryPath += ".exe"
	}
	return binaryPath
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

func (i *Installer) verifySHA512(filePath, expected string) error {
	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha512.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}

	sum := h.Sum(nil)
	if decoded, err := base64.StdEncoding.DecodeString(expected); err == nil {
		if string(decoded) != string(sum) {
			return fmt.Errorf("SHA-512 mismatch")
		}
		return nil
	}
	actual := hex.EncodeToString(sum)
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("SHA-512 mismatch: expected %s, got %s", expected, actual)
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

func (i *Installer) extractZipAll(archivePath, targetDir string) error {
	r, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer r.Close()

	cleanTarget, err := filepath.Abs(targetDir)
	if err != nil {
		return err
	}
	for _, f := range r.File {
		name := filepath.Clean(filepath.FromSlash(f.Name))
		if name == "." || strings.HasPrefix(name, ".."+string(os.PathSeparator)) || filepath.IsAbs(name) {
			return fmt.Errorf("unsafe zip path %q", f.Name)
		}
		target := filepath.Join(cleanTarget, name)
		if !strings.HasPrefix(target, cleanTarget+string(os.PathSeparator)) && target != cleanTarget {
			return fmt.Errorf("unsafe zip path %q", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, f.Mode()); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			rc.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		closeErr := out.Close()
		rc.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
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

type dependencySelection struct {
	Version      string `json:"version"`
	VersionID    string `json:"version_id"`
	Source       string `json:"source"`
	CachePath    string `json:"cache_path"`
	SelectedPath string `json:"selected_path"`
}

type dependencyLastError struct {
	Operation string `json:"operation"`
	Error     string `json:"error"`
}

func defaultRunCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (i *Installer) writeSelection(adapter LanguageAdapter, dep RuntimeDependency, selectedPath string) error {
	selection := dependencySelection{
		Version:      dependencyVersion(dep),
		VersionID:    dependencyVersionID(dep),
		Source:       dependencySource(dep),
		CachePath:    i.versionDir(adapter.ID(), dep),
		SelectedPath: selectedPath,
	}
	data, err := json.MarshalIndent(selection, "", "  ")
	if err != nil {
		return err
	}
	langDir := filepath.Join(i.baseDir, adapter.ID())
	if err := os.MkdirAll(langDir, 0755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(langDir, ".selected.json"), data, 0644)
}

func (i *Installer) readSelection(languageID string) (dependencySelection, bool) {
	data, err := os.ReadFile(filepath.Join(i.baseDir, languageID, ".selected.json"))
	if err != nil {
		return dependencySelection{}, false
	}
	var selection dependencySelection
	if err := json.Unmarshal(data, &selection); err != nil {
		return dependencySelection{}, false
	}
	return selection, true
}

func (i *Installer) writeLastError(languageID, operation string, installErr error) error {
	if installErr == nil {
		return nil
	}
	langDir := filepath.Join(i.baseDir, languageID)
	if err := os.MkdirAll(langDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(dependencyLastError{Operation: operation, Error: installErr.Error()}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(langDir, ".last-error.json"), data, 0644)
}

func (i *Installer) readLastError(languageID string) (dependencyLastError, bool) {
	data, err := os.ReadFile(filepath.Join(i.baseDir, languageID, ".last-error.json"))
	if err != nil {
		return dependencyLastError{}, false
	}
	var last dependencyLastError
	if err := json.Unmarshal(data, &last); err != nil {
		return dependencyLastError{}, false
	}
	return last, true
}

func (i *Installer) clearLastError(languageID string) error {
	err := os.Remove(filepath.Join(i.baseDir, languageID, ".last-error.json"))
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
}

func (i *Installer) cleanupEligible(languageID, selectedPath string) bool {
	if selectedPath == "" {
		return false
	}
	selectedDir, ok := i.selectedVersionDir(languageID, selectedPath)
	if !ok {
		return false
	}
	entries, err := os.ReadDir(filepath.Join(i.baseDir, languageID))
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if entry.IsDir() && filepath.Join(i.baseDir, languageID, entry.Name()) != selectedDir {
			return true
		}
	}
	return false
}

func (i *Installer) selectedVersionDir(languageID, selectedPath string) (string, bool) {
	langDir := filepath.Join(i.baseDir, languageID)
	rel, err := filepath.Rel(langDir, selectedPath)
	if err != nil || strings.HasPrefix(rel, "..") || rel == "." {
		return "", false
	}
	parts := strings.Split(rel, string(os.PathSeparator))
	if len(parts) == 0 || parts[0] == "" || parts[0] == "." {
		return "", false
	}
	return filepath.Join(langDir, parts[0]), true
}

func dependencyVersion(dep RuntimeDependency) string {
	if dep.Version != "" {
		return dep.Version
	}
	if dep.ID != "" {
		return dep.ID
	}
	return "current"
}

func dependencyVersionID(dep RuntimeDependency) string {
	version := dependencyVersion(dep)
	return strings.NewReplacer("/", "_", "\\", "_", ":", "_", "@", "_").Replace(version)
}

func dependencyCacheName(dep RuntimeDependency) string {
	if isNuGetDependency(dep) {
		if dep.PackageName != "" {
			return dependencyVersionID(RuntimeDependency{ID: dep.PackageName})
		}
		if dep.ID != "" {
			return dependencyVersionID(RuntimeDependency{ID: dep.ID})
		}
	}
	if dep.BinaryName != "" {
		return dep.BinaryName
	}
	if dep.ID != "" {
		return dependencyVersionID(RuntimeDependency{ID: dep.ID})
	}
	return "dependency"
}

func dependencySource(dep RuntimeDependency) string {
	if dep.Source != "" {
		return dep.Source
	}
	if isNuGetDependency(dep) {
		return "nuget"
	}
	if isNPMDependency(dep) {
		return "npm"
	}
	if dep.ArchiveType == "binary" {
		return "binary"
	}
	if dep.ArchiveType != "" {
		return dep.ArchiveType
	}
	return "managed"
}

func isNPMDependency(dep RuntimeDependency) bool {
	if isNuGetDependency(dep) {
		return false
	}
	return strings.EqualFold(dep.Source, "npm") || strings.EqualFold(dep.ArchiveType, "npm") || dep.PackageName != "" || len(dep.Packages) > 0
}

func isNuGetDependency(dep RuntimeDependency) bool {
	return strings.EqualFold(dep.Source, "nuget") || strings.EqualFold(dep.ArchiveType, "nupkg")
}

func nugetPackageURL(dep RuntimeDependency) string {
	pkg := dep.PackageName
	if pkg == "" {
		pkg = dep.ID
	}
	version := dependencyVersion(dep)
	if pkg == "" || version == "" || version == "current" {
		return ""
	}
	base := strings.TrimRight(dep.PackageSource, "/")
	if base == "" {
		base = "https://api.nuget.org/v3-flatcontainer"
	}
	lowerPkg := strings.ToLower(pkg)
	lowerVersion := strings.ToLower(version)
	return fmt.Sprintf("%s/%s/%s/%s.%s.nupkg", base, lowerPkg, lowerVersion, lowerPkg, lowerVersion)
}

func npmPackages(dep RuntimeDependency) []string {
	if len(dep.Packages) > 0 {
		return append([]string(nil), dep.Packages...)
	}
	if dep.PackageName != "" {
		return []string{dep.PackageName}
	}
	if dep.ID != "" {
		return []string{dep.ID}
	}
	return []string{dep.BinaryName}
}

func npmPackageSpec(pkg, version string) string {
	if version == "" || version == "latest" {
		return pkg
	}
	if strings.HasPrefix(pkg, "@") {
		if idx := strings.LastIndex(pkg, "@"); idx > strings.Index(pkg, "/") {
			return pkg
		}
		return pkg + "@" + version
	}
	if strings.Contains(pkg, "@") {
		return pkg
	}
	return pkg + "@" + version
}
