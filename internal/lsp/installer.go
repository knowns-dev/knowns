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
	"time"
)

// CurrentPlatformID returns the current platform identifier (e.g. "darwin-arm64").
func CurrentPlatformID() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// Installer handles downloading, extracting, and verifying LSP server binaries.
type Installer struct {
	baseDir                string // ~/.knowns/lsp-servers/
	mu                     sync.Mutex
	installing             map[string]chan struct{} // prevent concurrent installs of same language
	runCommand             func(context.Context, string, ...string) ([]byte, error)
	writeSelectionOverride func(LanguageAdapter, DependencyResolution, string) error
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
	return i.InstallWithOptions(ctx, adapter, InstallOptions{})
}

// InstallWithOptions installs a concrete dependency selected from the
// adapter's recommended version, latest upstream version, or an explicit tag.
// Install remains the backward-compatible recommended/default entry point.
func (i *Installer) InstallWithOptions(ctx context.Context, adapter LanguageAdapter, opts InstallOptions) (string, error) {
	return i.installWithOptions(ctx, adapter, opts, false)
}

func (i *Installer) installWithOptions(ctx context.Context, adapter LanguageAdapter, opts InstallOptions, coalesceExisting bool) (string, error) {
	if err := validateInstallSelector(opts.Selector); err != nil {
		return "", err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	langID := adapter.ID()

	// Concurrent install prevention: if another goroutine is installing the same language, wait.
	i.mu.Lock()
	if ch, ok := i.installing[langID]; ok {
		i.mu.Unlock()
		select {
		case <-ch:
			return i.installWithOptions(ctx, adapter, opts, true)
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

	unlock, waited, err := acquireLanguageInstallLock(ctx, i.baseDir, langID)
	if err != nil {
		return "", err
	}
	defer unlock()

	dep, err := i.findDep(adapter)
	if err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}
	if coalesceExisting || waited {
		if selection, ok := i.readSelection(langID); ok && selectionSatisfiesRequest(selection, dep, opts.Selector) {
			if _, err := os.Stat(selection.SelectedPath); err == nil {
				if opts.BeforeCleanup != nil {
					if err := opts.BeforeCleanup(selection.SelectedPath); err != nil {
						return "", err
					}
				}
				_ = i.cleanupLocked(langID)
				_ = i.clearLastError(langID)
				return selection.SelectedPath, nil
			}
		}
	}
	previousSelection := i.snapshotSelection(langID)

	resolution, err := i.resolveDependency(ctx, adapter, dep, opts)
	if err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}

	path, rollback, commit, err := i.installResolvedDependency(ctx, adapter, resolution.Dependency)
	if err != nil {
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}
	writeSelection := i.writeSelectionResolution
	if i.writeSelectionOverride != nil {
		writeSelection = i.writeSelectionOverride
	}
	if err := writeSelection(adapter, resolution, path); err != nil {
		rollback()
		_ = i.writeLastError(langID, "install", err)
		return "", err
	}
	if opts.BeforeCleanup != nil {
		if err := opts.BeforeCleanup(path); err != nil {
			rollback()
			if restoreErr := i.restoreSelection(langID, previousSelection); restoreErr != nil {
				err = fmt.Errorf("%w (restore previous selection: %v)", err, restoreErr)
			}
			_ = i.writeLastError(langID, "install", err)
			return "", err
		}
	}
	commit()
	_ = i.clearLastError(langID)
	_ = i.cleanupLocked(langID)
	return path, nil
}

func selectionSatisfiesRequest(selection dependencySelection, dep RuntimeDependency, selector InstallSelector) bool {
	if selection.RequestedVersion != requestedVersionForDependency(dep, selector) {
		return false
	}
	if !selector.Latest && strings.TrimSpace(selector.Version) == "" && dep.RecommendedVersion != "" {
		return selection.ResolvedVersion == dep.RecommendedVersion &&
			selection.Integrity == dep.RecommendedIntegrity &&
			selection.Verified
	}
	return true
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
	if dep.RecommendedVersion != "" {
		dep.Version = dep.RecommendedVersion
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
	selectedDep := dep
	if dep.RecommendedVersion != "" {
		selectedDep.Version = dep.RecommendedVersion
	}
	status.Version = dependencyVersion(selectedDep)
	status.Source = dependencySource(dep)
	status.CachePath = i.versionDir(adapter.ID(), selectedDep)
	status.SelectedVersionID = dependencyVersionID(selectedDep)
	if selection, ok := i.readSelection(adapter.ID()); ok {
		status.Version = selection.Version
		status.RequestedVersion = selection.RequestedVersion
		status.ResolvedVersion = selection.ResolvedVersion
		if status.ResolvedVersion == "" {
			status.ResolvedVersion = selection.Version
		}
		status.Source = selection.Source
		status.SourceLocation = selection.SourceLocation
		status.Integrity = selection.Integrity
		status.InstalledAt = selection.InstalledAt
		status.Verified = selection.Verified
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
	unlock, _, err := acquireLanguageInstallLock(context.Background(), i.baseDir, languageID)
	if err != nil {
		return err
	}
	defer unlock()
	return i.cleanupLocked(languageID)
}

func (i *Installer) cleanupLocked(languageID string) error {
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

func validateInstallSelector(selector InstallSelector) error {
	selector.Version = strings.TrimSpace(selector.Version)
	if selector.Latest && selector.Version != "" {
		return fmt.Errorf("latest and explicit version selectors are mutually exclusive")
	}
	return nil
}

func requestedVersionForDependency(dep RuntimeDependency, selector InstallSelector) string {
	if selector.Latest {
		return "latest"
	}
	if version := strings.TrimSpace(selector.Version); version != "" {
		return version
	}
	if strings.TrimSpace(dep.RecommendedVersion) != "" {
		return "recommended"
	}
	return "legacy-default"
}

func (i *Installer) resolveDependency(ctx context.Context, adapter LanguageAdapter, dep RuntimeDependency, opts InstallOptions) (DependencyResolution, error) {
	resolver := opts.ReleaseResolver
	if isNPMDependency(dep) {
		resolver = opts.NPMResolver
		if resolver == nil {
			resolver = i.resolveNPMDependency
		}
	} else if resolver == nil {
		if provider, ok := adapter.(RuntimeDependencyResolverProvider); ok {
			resolver = provider.ResolveRuntimeDependency
		}
	}
	if resolver != nil {
		resolution, err := resolver(ctx, dep, opts.Selector)
		if err != nil {
			return DependencyResolution{}, err
		}
		return normalizeResolution(dep, opts.Selector, resolution)
	}
	return resolveStaticDependency(dep, opts.Selector)
}

func resolveStaticDependency(dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
	requested := requestedVersionForDependency(dep, selector)
	resolved := strings.TrimSpace(dep.Version)
	if dep.RecommendedVersion != "" && !selector.Latest && strings.TrimSpace(selector.Version) == "" {
		resolved = dep.RecommendedVersion
	}
	if version := strings.TrimSpace(selector.Version); version != "" {
		if dep.RecommendedVersion != version && dep.Version != version {
			return DependencyResolution{}, fmt.Errorf("release version %q requires a dependency resolver", version)
		}
		resolved = version
	}
	if selector.Latest {
		return DependencyResolution{}, fmt.Errorf("latest release requires a dependency resolver")
	}
	if resolved == "" {
		resolved = dependencyVersion(dep)
	}
	resolvedDep := dep
	resolvedDep.Version = resolved
	resolvedDep.URL = expandVersionTemplate(dep.URL, resolved)
	resolvedDep.ExtractPath = expandVersionTemplate(dep.ExtractPath, resolved)
	return normalizeResolution(dep, selector, DependencyResolution{
		Dependency:       resolvedDep,
		RequestedVersion: requested,
		ResolvedVersion:  resolved,
		Source:           dependencySourceLocation(resolvedDep),
		Integrity:        dependencyIntegrity(resolvedDep),
		Verified:         dep.RecommendedVersion != "" && resolved == dep.RecommendedVersion,
	})
}

func (i *Installer) resolveNPMDependency(ctx context.Context, dep RuntimeDependency, selector InstallSelector) (DependencyResolution, error) {
	requested := requestedVersionForDependency(dep, selector)
	target := strings.TrimSpace(selector.Version)
	shouldResolve := target != "" || selector.Latest || dep.RecommendedVersion != ""
	if selector.Latest {
		target = "latest"
	} else if target == "" && dep.RecommendedVersion != "" {
		target = dep.RecommendedVersion
	} else if target == "" {
		target = dependencyVersion(dep)
	}
	if !shouldResolve {
		resolvedDep := dep
		return normalizeResolution(dep, selector, DependencyResolution{
			Dependency:       resolvedDep,
			RequestedVersion: requested,
			ResolvedVersion:  dependencyVersion(resolvedDep),
			Source:           dependencySourceLocation(resolvedDep),
			Integrity:        dependencyIntegrity(resolvedDep),
			Verified:         false,
		})
	}

	packages := npmPackages(dep)
	if len(packages) == 0 || strings.TrimSpace(packages[0]) == "" {
		return DependencyResolution{}, fmt.Errorf("npm dependency has no package name")
	}
	packageSpec := npmPackageSpec(packages[0], target)
	output, err := i.runCommand(ctx, "npm", "view", packageSpec, "version", "dist.integrity", "--json")
	if err != nil {
		return DependencyResolution{}, fmt.Errorf("resolve npm package %s: %w: %s", packageSpec, err, strings.TrimSpace(string(output)))
	}
	resolvedVersion, integrity, err := parseNPMMetadata(output)
	if err != nil {
		return DependencyResolution{}, fmt.Errorf("parse npm metadata for %s: %w", packageSpec, err)
	}
	if resolvedVersion == "" {
		return DependencyResolution{}, fmt.Errorf("npm metadata for %s did not include a resolved version", packageSpec)
	}
	if integrity == "" {
		return DependencyResolution{}, fmt.Errorf("npm metadata for %s did not include integrity", packageSpec)
	}
	resolvedDep := dep
	resolvedDep.Version = resolvedVersion
	return normalizeResolution(dep, selector, DependencyResolution{
		Dependency:       resolvedDep,
		RequestedVersion: requested,
		ResolvedVersion:  resolvedVersion,
		Source:           packageSpec,
		Integrity:        integrity,
		Verified:         dep.RecommendedVersion != "" && resolvedVersion == dep.RecommendedVersion,
	})
}

func parseNPMMetadata(data []byte) (string, string, error) {
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return "", "", err
	}
	version, integrity := npmMetadataFromValue(value)
	return version, integrity, nil
}

func npmMetadataFromValue(value any) (string, string) {
	switch typed := value.(type) {
	case map[string]any:
		version, _ := typed["version"].(string)
		integrity, _ := typed["dist.integrity"].(string)
		if integrity == "" {
			if dist, ok := typed["dist"].(map[string]any); ok {
				integrity, _ = dist["integrity"].(string)
			}
		}
		return version, integrity
	case []any:
		for index := len(typed) - 1; index >= 0; index-- {
			version, integrity := npmMetadataFromValue(typed[index])
			if version != "" || integrity != "" {
				return version, integrity
			}
		}
	}
	return "", ""
}

func normalizeResolution(original RuntimeDependency, selector InstallSelector, resolution DependencyResolution) (DependencyResolution, error) {
	if err := validateInstallSelector(selector); err != nil {
		return DependencyResolution{}, err
	}
	if resolution.Dependency.BinaryName == "" {
		return DependencyResolution{}, fmt.Errorf("resolved dependency has no binary name")
	}
	resolution.RequestedVersion = requestedVersionForDependency(original, selector)
	if resolution.ResolvedVersion == "" {
		resolution.ResolvedVersion = dependencyVersion(resolution.Dependency)
	}
	resolution.Dependency.Version = resolution.ResolvedVersion
	if resolution.Source == "" {
		resolution.Source = dependencySourceLocation(resolution.Dependency)
	}
	resolution.Verified = false
	if isNPMDependency(original) {
		// npm's dist.integrity is an SRI value and therefore case-sensitive.
		resolution.Verified = original.RecommendedVersion != "" &&
			original.RecommendedIntegrity != "" &&
			resolution.ResolvedVersion == original.RecommendedVersion &&
			resolution.Integrity == original.RecommendedIntegrity
	} else {
		// Release provenance is the checksum the installer will actually use,
		// never a resolver-provided assertion.
		resolution.Integrity = dependencyIntegrity(resolution.Dependency)
		resolution.Verified = original.RecommendedVersion != "" &&
			original.RecommendedIntegrity != "" &&
			resolution.ResolvedVersion == original.RecommendedVersion &&
			strings.EqualFold(resolution.Integrity, original.RecommendedIntegrity)
	}
	if !selector.Latest && strings.TrimSpace(selector.Version) == "" && original.RecommendedVersion != "" && !resolution.Verified {
		if original.RecommendedIntegrity == "" {
			return DependencyResolution{}, fmt.Errorf("recommended version %s is missing pinned integrity metadata", original.RecommendedVersion)
		}
		return DependencyResolution{}, fmt.Errorf("recommended version %s integrity mismatch: expected %s, got %s", original.RecommendedVersion, original.RecommendedIntegrity, resolution.Integrity)
	}
	return resolution, nil
}

func expandVersionTemplate(value, version string) string {
	for _, token := range []string{"{{version}}", "${version}", "{version}"} {
		value = strings.ReplaceAll(value, token, version)
	}
	return value
}

func dependencySourceLocation(dep RuntimeDependency) string {
	if dep.URL != "" {
		return dep.URL
	}
	packages := npmPackages(dep)
	return strings.Join(packages, ",")
}

func dependencyIntegrity(dep RuntimeDependency) string {
	if dep.SHA512 != "" && !strings.EqualFold(dep.SHA512, "TODO") {
		return "sha512:" + dep.SHA512
	}
	if dep.SHA256 != "" && !strings.EqualFold(dep.SHA256, "TODO") {
		return "sha256:" + dep.SHA256
	}
	return ""
}

func (i *Installer) installResolvedDependency(ctx context.Context, adapter LanguageAdapter, dep RuntimeDependency) (string, func(), func(), error) {
	langDir := filepath.Join(i.baseDir, adapter.ID())
	if err := os.MkdirAll(langDir, 0755); err != nil {
		return "", nil, nil, fmt.Errorf("create language dir: %w", err)
	}
	stagingDir, err := os.MkdirTemp(langDir, ".install-")
	if err != nil {
		return "", nil, nil, fmt.Errorf("create staging dir: %w", err)
	}
	stagedPath, err := i.installDependencyAt(ctx, stagingDir, dep)
	if err != nil {
		_ = os.RemoveAll(stagingDir)
		return "", nil, nil, err
	}
	relPath, err := filepath.Rel(stagingDir, stagedPath)
	if err != nil || strings.HasPrefix(relPath, "..") {
		_ = os.RemoveAll(stagingDir)
		return "", nil, nil, fmt.Errorf("installed binary escaped staging dir")
	}

	versionDir := i.versionDir(adapter.ID(), dep)
	backupDir := versionDir + ".previous"
	_ = os.RemoveAll(backupDir)
	hadPrevious := false
	if _, statErr := os.Stat(versionDir); statErr == nil {
		if err := os.Rename(versionDir, backupDir); err != nil {
			_ = os.RemoveAll(stagingDir)
			return "", nil, nil, fmt.Errorf("preserve selected version: %w", err)
		}
		hadPrevious = true
	} else if !os.IsNotExist(statErr) {
		_ = os.RemoveAll(stagingDir)
		return "", nil, nil, fmt.Errorf("inspect selected version: %w", statErr)
	}
	if err := os.Rename(stagingDir, versionDir); err != nil {
		if hadPrevious {
			_ = os.Rename(backupDir, versionDir)
		}
		_ = os.RemoveAll(stagingDir)
		return "", nil, nil, fmt.Errorf("select installed version: %w", err)
	}

	rollback := func() {
		_ = os.RemoveAll(versionDir)
		if hadPrevious {
			_ = os.Rename(backupDir, versionDir)
		}
	}
	commit := func() { _ = os.RemoveAll(backupDir) }
	return filepath.Join(versionDir, relPath), rollback, commit, nil
}

func (i *Installer) installDependencyAt(ctx context.Context, versionDir string, dep RuntimeDependency) (string, error) {
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
	return dependencyBinaryPath(versionDir, dep, runtime.GOOS)
}

func dependencyBinaryPath(versionDir string, dep RuntimeDependency, goos string) string {
	if isNPMDependency(dep) {
		name := dep.BinaryName
		if goos == "windows" {
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
	if goos == "windows" {
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
	Version          string `json:"version"`
	VersionID        string `json:"version_id"`
	Source           string `json:"source"`
	CachePath        string `json:"cache_path"`
	SelectedPath     string `json:"selected_path"`
	RequestedVersion string `json:"requested_version,omitempty"`
	ResolvedVersion  string `json:"resolved_version,omitempty"`
	SourceLocation   string `json:"source_location,omitempty"`
	Integrity        string `json:"integrity,omitempty"`
	InstalledAt      string `json:"installed_at,omitempty"`
	Verified         bool   `json:"verified"`
}

type dependencySelectionSnapshot struct {
	data   []byte
	exists bool
}

type dependencyLastError struct {
	Operation string `json:"operation"`
	Error     string `json:"error"`
}

func defaultRunCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (i *Installer) writeSelection(adapter LanguageAdapter, dep RuntimeDependency, selectedPath string) error {
	return i.writeSelectionResolution(adapter, DependencyResolution{
		Dependency:       dep,
		RequestedVersion: dependencyVersion(dep),
		ResolvedVersion:  dependencyVersion(dep),
		Source:           dependencySourceLocation(dep),
		Integrity:        dependencyIntegrity(dep),
		Verified:         false,
	}, selectedPath)
}

func (i *Installer) writeSelectionResolution(adapter LanguageAdapter, resolution DependencyResolution, selectedPath string) error {
	dep := resolution.Dependency
	selection := dependencySelection{
		Version:          resolution.ResolvedVersion,
		VersionID:        dependencyVersionID(dep),
		Source:           dependencySource(dep),
		CachePath:        i.versionDir(adapter.ID(), dep),
		SelectedPath:     selectedPath,
		RequestedVersion: resolution.RequestedVersion,
		ResolvedVersion:  resolution.ResolvedVersion,
		SourceLocation:   resolution.Source,
		Integrity:        resolution.Integrity,
		InstalledAt:      time.Now().UTC().Format(time.RFC3339Nano),
		Verified:         resolution.Verified,
	}
	data, err := json.MarshalIndent(selection, "", "  ")
	if err != nil {
		return err
	}
	return i.writeSelectionData(adapter.ID(), data)
}

func (i *Installer) writeSelectionData(languageID string, data []byte) error {
	langDir := filepath.Join(i.baseDir, languageID)
	if err := os.MkdirAll(langDir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(langDir, ".selected-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	target := filepath.Join(langDir, ".selected.json")
	if err := os.Rename(tmpPath, target); err == nil {
		return nil
	}
	// Windows does not replace an existing file with Rename. Keep the old
	// selection recoverable until the new file is in place.
	backup := target + ".previous"
	_ = os.Remove(backup)
	if err := os.Rename(target, backup); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := os.Rename(tmpPath, target); err != nil {
		_ = os.Rename(backup, target)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func (i *Installer) snapshotSelection(languageID string) dependencySelectionSnapshot {
	data, err := os.ReadFile(filepath.Join(i.baseDir, languageID, ".selected.json"))
	if err != nil {
		return dependencySelectionSnapshot{}
	}
	return dependencySelectionSnapshot{data: data, exists: true}
}

func (i *Installer) restoreSelection(languageID string, snapshot dependencySelectionSnapshot) error {
	if snapshot.exists {
		return i.writeSelectionData(languageID, snapshot.data)
	}
	err := os.Remove(filepath.Join(i.baseDir, languageID, ".selected.json"))
	if err == nil || os.IsNotExist(err) {
		return nil
	}
	return err
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
	normalized := strings.NewReplacer("/", "_", "\\", "_", ":", "_", "@", "_").Replace(version)
	if normalized == version {
		return normalized
	}
	digest := sha256.Sum256([]byte(version))
	return normalized + "-" + hex.EncodeToString(digest[:6])
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
