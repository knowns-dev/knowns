package adapters

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	marksmanRecommendedVersion = "2026-02-08"
	marksmanRepositoryURL      = "https://github.com/artempyanykh/marksman"
	marksmanReleasesAPI        = "https://api.github.com/repos/artempyanykh/marksman/releases"
)

type MarksmanAdapter struct{ lsp.BaseAdapter }

func NewMarksmanAdapter() *MarksmanAdapter { return &MarksmanAdapter{} }

func (a *MarksmanAdapter) ID() string           { return "markdown" }
func (a *MarksmanAdapter) Name() string         { return "Markdown" }
func (a *MarksmanAdapter) Extensions() []string { return []string{".md", ".markdown"} }
func (a *MarksmanAdapter) PathMatchers() []lsp.PathMatcher {
	return []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".markdown", Priority: 100},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".md", Priority: 100},
	}
}
func (a *MarksmanAdapter) LazyStart() bool { return true }
func (a *MarksmanAdapter) CapabilityProfile() lsp.CapabilityProfile {
	return lsp.DocumentConfigCapabilityProfile()
}
func (a *MarksmanAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: "marksman", Args: []string{"server"}, CheckArgs: []string{"--version"}}}
}
func (a *MarksmanAdapter) Prerequisites() []lsp.Prerequisite        { return nil }
func (a *MarksmanAdapter) CheckPrerequisites(context.Context) error { return nil }
func (a *MarksmanAdapter) CanInstall() bool                         { return true }
func (a *MarksmanAdapter) DefaultArgs() []string                    { return []string{"server"} }
func (a *MarksmanAdapter) SupportsImplementation() bool             { return false }
func (a *MarksmanAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		KnownsCmd: "knowns lsp install markdown",
		URL:       marksmanRepositoryURL,
		Notes:     "Standalone Marksman binaries are installed on demand; existing PATH binaries take precedence",
	}
}

func (a *MarksmanAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{
		marksmanRuntimeDependency("darwin-arm64", "marksman-macos", "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b"),
		marksmanRuntimeDependency("darwin-amd64", "marksman-macos", "6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b"),
		marksmanRuntimeDependency("linux-arm64", "marksman-linux-arm64", "db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb"),
		marksmanRuntimeDependency("linux-amd64", "marksman-linux-x64", "be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087"),
		marksmanRuntimeDependency("windows-amd64", "marksman.exe", "a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705"),
	}
}

func marksmanRuntimeDependency(platformID, assetName, sha256 string) lsp.RuntimeDependency {
	return lsp.RuntimeDependency{
		ID:                   marksmanRecommendedVersion,
		PlatformID:           platformID,
		Version:              marksmanRecommendedVersion,
		RecommendedVersion:   marksmanRecommendedVersion,
		RecommendedIntegrity: "sha256:" + sha256,
		Source:               "release",
		PackageSource:        marksmanRepositoryURL,
		URL: fmt.Sprintf(
			"%s/releases/download/%s/%s",
			marksmanRepositoryURL,
			marksmanRecommendedVersion,
			assetName,
		),
		SHA256:      sha256,
		ArchiveType: "binary",
		BinaryName:  "marksman",
	}
}

func (a *MarksmanAdapter) ResolveRuntimeDependency(ctx context.Context, dep lsp.RuntimeDependency, selector lsp.InstallSelector) (lsp.DependencyResolution, error) {
	return resolveMarksmanRuntimeDependency(ctx, http.DefaultClient, marksmanReleasesAPI, dep, selector)
}

func resolveMarksmanRuntimeDependency(
	ctx context.Context,
	client *http.Client,
	apiBase string,
	dep lsp.RuntimeDependency,
	selector lsp.InstallSelector,
) (lsp.DependencyResolution, error) {
	explicitVersion := strings.TrimSpace(selector.Version)
	if selector.Latest && explicitVersion != "" {
		return lsp.DependencyResolution{}, fmt.Errorf("latest and explicit version selectors are mutually exclusive")
	}

	if !selector.Latest && explicitVersion == "" {
		resolved := dep
		if resolved.RecommendedVersion != "" {
			resolved.Version = resolved.RecommendedVersion
		}
		return lsp.DependencyResolution{
			Dependency:       resolved,
			RequestedVersion: "recommended",
			ResolvedVersion:  resolved.Version,
			Source:           resolved.URL,
			Integrity:        "sha256:" + resolved.SHA256,
		}, nil
	}

	assetName, err := marksmanAssetName(dep.PlatformID)
	if err != nil {
		return lsp.DependencyResolution{}, err
	}
	if client == nil {
		client = http.DefaultClient
	}

	releasePath := "/latest"
	requested := "latest"
	if explicitVersion != "" {
		releasePath = "/tags/" + url.PathEscape(explicitVersion)
		requested = explicitVersion
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(apiBase, "/")+releasePath, nil)
	if err != nil {
		return lsp.DependencyResolution{}, fmt.Errorf("resolve Marksman release: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "knowns-lsp-installer")

	resp, err := client.Do(req)
	if err != nil {
		return lsp.DependencyResolution{}, fmt.Errorf("resolve Marksman release: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return lsp.DependencyResolution{}, fmt.Errorf("resolve Marksman release: HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}

	var release marksmanGitHubRelease
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&release); err != nil {
		return lsp.DependencyResolution{}, fmt.Errorf("decode Marksman release: %w", err)
	}
	if strings.TrimSpace(release.TagName) == "" {
		return lsp.DependencyResolution{}, fmt.Errorf("Marksman release response did not include a tag")
	}
	if explicitVersion != "" && release.TagName != explicitVersion {
		return lsp.DependencyResolution{}, fmt.Errorf("Marksman release tag mismatch: requested %s, got %s", explicitVersion, release.TagName)
	}
	for _, asset := range release.Assets {
		if asset.Name != assetName {
			continue
		}
		sha256, err := parseGitHubSHA256Digest(asset.Digest)
		if err != nil {
			return lsp.DependencyResolution{}, fmt.Errorf("Marksman release %s asset %s: %w", release.TagName, assetName, err)
		}
		if strings.TrimSpace(asset.DownloadURL) == "" {
			return lsp.DependencyResolution{}, fmt.Errorf("Marksman release %s asset %s has no download URL", release.TagName, assetName)
		}
		resolved := dep
		resolved.ID = release.TagName
		resolved.Version = release.TagName
		resolved.URL = asset.DownloadURL
		resolved.SHA256 = sha256
		return lsp.DependencyResolution{
			Dependency:       resolved,
			RequestedVersion: requested,
			ResolvedVersion:  release.TagName,
			Source:           asset.DownloadURL,
			Integrity:        "sha256:" + sha256,
		}, nil
	}
	return lsp.DependencyResolution{}, fmt.Errorf("Marksman release %s has no %s asset", release.TagName, assetName)
}

type marksmanGitHubRelease struct {
	TagName string `json:"tag_name"`
	Assets  []struct {
		Name        string `json:"name"`
		DownloadURL string `json:"browser_download_url"`
		Digest      string `json:"digest"`
	} `json:"assets"`
}

func marksmanAssetName(platformID string) (string, error) {
	switch platformID {
	case "darwin-arm64", "darwin-amd64":
		return "marksman-macos", nil
	case "linux-arm64":
		return "marksman-linux-arm64", nil
	case "linux-amd64":
		return "marksman-linux-x64", nil
	case "windows-amd64":
		return "marksman.exe", nil
	default:
		return "", fmt.Errorf("Marksman has no managed release asset for platform %s", platformID)
	}
}

func parseGitHubSHA256Digest(digest string) (string, error) {
	algorithm, value, ok := strings.Cut(strings.TrimSpace(digest), ":")
	if !ok || !strings.EqualFold(algorithm, "sha256") {
		return "", fmt.Errorf("missing published SHA-256 digest")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != 32 {
		return "", fmt.Errorf("invalid published SHA-256 digest")
	}
	return strings.ToLower(value), nil
}

func (a *MarksmanAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	path, err := lsp.NewInstaller(targetDir).Install(ctx, a)
	if err != nil {
		return "", fmt.Errorf("install Marksman: %w", err)
	}
	return path, nil
}

func (a *MarksmanAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}

func (a *MarksmanAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}

func (a *MarksmanAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
