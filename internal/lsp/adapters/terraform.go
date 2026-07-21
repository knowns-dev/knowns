package adapters

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/howznguyen/knowns/internal/lsp"
)

const (
	terraformLSRecommendedVersion = "0.38.8"
	terraformLSRepositoryURL      = "https://github.com/hashicorp/terraform-ls"
	terraformLSGitHubReleasesAPI  = "https://api.github.com/repos/hashicorp/terraform-ls/releases"
	terraformLSReleasesBase       = "https://releases.hashicorp.com/terraform-ls"

	terraformPathPriority         = 200
	terraformCompoundPathPriority = 300
)

var terraformLSVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)

type TerraformLSAdapter struct{ lsp.BaseAdapter }

func NewTerraformLSAdapter() *TerraformLSAdapter { return &TerraformLSAdapter{} }

func (a *TerraformLSAdapter) ID() string   { return "terraform" }
func (a *TerraformLSAdapter) Name() string { return "Terraform" }
func (a *TerraformLSAdapter) Extensions() []string {
	return []string{".tf", ".tfvars", ".tf.json", ".tfvars.json"}
}
func (a *TerraformLSAdapter) PathMatchers() []lsp.PathMatcher {
	return []lsp.PathMatcher{
		{Kind: lsp.PathMatcherSuffix, Pattern: ".tfvars.json", Priority: terraformCompoundPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".tf.json", Priority: terraformCompoundPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".tfvars", Priority: terraformPathPriority},
		{Kind: lsp.PathMatcherSuffix, Pattern: ".tf", Priority: terraformPathPriority},
	}
}
func (a *TerraformLSAdapter) LazyStart() bool { return true }
func (a *TerraformLSAdapter) CapabilityProfile() lsp.CapabilityProfile {
	return lsp.CodeCapabilityProfile()
}
func (a *TerraformLSAdapter) DocumentSyncForPath(path string) lsp.DocumentSyncOptions {
	languageID, jsonVariant := terraformDocumentKind(path)
	return lsp.DocumentSyncOptions{LanguageID: languageID, Suppress: jsonVariant}
}
func (a *TerraformLSAdapter) PathCapabilityForAction(path, action, _ string) (lsp.PathCapabilityDecision, bool) {
	_, jsonVariant := terraformDocumentKind(path)
	if !jsonVariant {
		return lsp.PathCapabilityDecision{}, false
	}
	explanation := "terraform-ls does not support Terraform JSON configuration documents"
	if action != "" {
		explanation += fmt.Sprintf("; action %q is unavailable for %s", action, path)
	}
	return lsp.PathCapabilityDecision{Explanation: explanation}, true
}
func terraformDocumentKind(path string) (languageID string, jsonVariant bool) {
	normalized := strings.ToLower(strings.ReplaceAll(path, `\`, "/"))
	switch {
	case strings.HasSuffix(normalized, ".tfvars.json"):
		return "terraform-vars", true
	case strings.HasSuffix(normalized, ".tf.json"):
		return "terraform", true
	case strings.HasSuffix(normalized, ".tfvars"):
		return "terraform-vars", false
	default:
		return "terraform", false
	}
}
func (a *TerraformLSAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{
		Name:      "terraform-ls",
		Args:      []string{"serve"},
		CheckArgs: []string{"version"},
	}}
}
func (a *TerraformLSAdapter) Prerequisites() []lsp.Prerequisite {
	return []lsp.Prerequisite{{
		Name:        "Terraform CLI",
		CheckCmd:    "terraform version",
		InstallHint: "Install Terraform from https://developer.hashicorp.com/terraform/install",
	}}
}
func (a *TerraformLSAdapter) CheckPrerequisites(ctx context.Context) error {
	return checkBinary(ctx, "terraform", "version")
}
func (a *TerraformLSAdapter) InstallGuide() lsp.InstallGuide {
	return lsp.InstallGuide{
		KnownsCmd: "knowns lsp install terraform",
		URL:       terraformLSRepositoryURL,
		Notes:     "Requires Terraform CLI; existing PATH terraform-ls binaries take precedence over the managed release",
	}
}
func (a *TerraformLSAdapter) CanInstall() bool             { return true }
func (a *TerraformLSAdapter) DefaultArgs() []string        { return []string{"serve"} }
func (a *TerraformLSAdapter) SupportsImplementation() bool { return false }
func (a *TerraformLSAdapter) IsIgnoredDir(name string) bool {
	return isIgnoredDir(name, map[string]struct{}{`.terraform`: {}})
}

func (a *TerraformLSAdapter) RuntimeDeps() []lsp.RuntimeDependency {
	return []lsp.RuntimeDependency{
		terraformLSRuntimeDependency("darwin-amd64", "darwin_amd64", "34cfe6cbbb61da5b8fd21721e14be0f134417f249350872da1669454dc8762a4"),
		terraformLSRuntimeDependency("darwin-arm64", "darwin_arm64", "510a506f7bf1550294202347261961e52daa4664a795e2deffbf7df7296b1f6c"),
		terraformLSRuntimeDependency("linux-amd64", "linux_amd64", "d16077d9c83f13ac33501af49ea75f43218d3fa2437c6c1374550b2625edc3ef"),
		terraformLSRuntimeDependency("linux-arm64", "linux_arm64", "762db754428dd188b949533ca05437955e26f4b3fc699d4b93392668a24e7a10"),
		terraformLSRuntimeDependency("windows-amd64", "windows_amd64", "5152e76e45103ea2a31b8a8dadc43833ae559a4aba4cb12f57c1c006c11dda8c"),
		terraformLSRuntimeDependency("windows-arm64", "windows_arm64", "5cee26a3645487125bf65daee8cfc85c84d8c7e03bbb00662fb12225afe9d6cd"),
	}
}

func terraformLSRuntimeDependency(platformID, archivePlatform, sha256 string) lsp.RuntimeDependency {
	archiveName := fmt.Sprintf("terraform-ls_%s_%s.zip", terraformLSRecommendedVersion, archivePlatform)
	extractPath := "terraform-ls"
	if strings.HasPrefix(platformID, "windows-") {
		extractPath += ".exe"
	}
	return lsp.RuntimeDependency{
		ID:                   terraformLSRecommendedVersion,
		PlatformID:           platformID,
		Version:              terraformLSRecommendedVersion,
		RecommendedVersion:   terraformLSRecommendedVersion,
		RecommendedIntegrity: "sha256:" + sha256,
		Source:               "release",
		PackageSource:        terraformLSReleasesBase,
		URL:                  terraformLSReleasesBase + "/" + terraformLSRecommendedVersion + "/" + archiveName,
		SHA256:               sha256,
		ArchiveType:          "zip",
		BinaryName:           "terraform-ls",
		ExtractPath:          extractPath,
	}
}

func (a *TerraformLSAdapter) ResolveRuntimeDependency(ctx context.Context, dep lsp.RuntimeDependency, selector lsp.InstallSelector) (lsp.DependencyResolution, error) {
	return resolveTerraformLSRuntimeDependency(
		ctx,
		http.DefaultClient,
		terraformLSGitHubReleasesAPI,
		terraformLSReleasesBase,
		dep,
		selector,
	)
}

func resolveTerraformLSRuntimeDependency(
	ctx context.Context,
	client *http.Client,
	githubAPI string,
	releasesBase string,
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
	if client == nil {
		client = http.DefaultClient
	}

	requested := explicitVersion
	version := explicitVersion
	if selector.Latest {
		requested = "latest"
		latestURL := strings.TrimRight(githubAPI, "/") + "/latest"
		body, err := terraformLSGet(ctx, client, latestURL, 4<<20)
		if err != nil {
			return lsp.DependencyResolution{}, fmt.Errorf("resolve latest terraform-ls release: %w", err)
		}
		var release struct {
			TagName string `json:"tag_name"`
		}
		if err := json.Unmarshal(body, &release); err != nil {
			return lsp.DependencyResolution{}, fmt.Errorf("decode latest terraform-ls release: %w", err)
		}
		version = release.TagName
	}

	version, err := normalizeTerraformLSVersion(version)
	if err != nil {
		return lsp.DependencyResolution{}, err
	}
	archiveName, extractPath, err := terraformLSArchive(version, dep.PlatformID)
	if err != nil {
		return lsp.DependencyResolution{}, err
	}
	versionBase := strings.TrimRight(releasesBase, "/") + "/" + url.PathEscape(version)
	checksumsName := "terraform-ls_" + version + "_SHA256SUMS"
	checksumsURL := versionBase + "/" + url.PathEscape(checksumsName)
	manifest, err := terraformLSGet(ctx, client, checksumsURL, 2<<20)
	if err != nil {
		return lsp.DependencyResolution{}, fmt.Errorf("fetch terraform-ls %s checksums: %w", version, err)
	}
	sha256, err := terraformLSChecksum(manifest, archiveName)
	if err != nil {
		return lsp.DependencyResolution{}, fmt.Errorf("resolve terraform-ls %s checksum: %w", version, err)
	}

	archiveURL := versionBase + "/" + url.PathEscape(archiveName)
	resolved := dep
	resolved.ID = version
	resolved.Version = version
	resolved.URL = archiveURL
	resolved.SHA256 = sha256
	resolved.ExtractPath = extractPath
	return lsp.DependencyResolution{
		Dependency:       resolved,
		RequestedVersion: requested,
		ResolvedVersion:  version,
		Source:           archiveURL,
		Integrity:        "sha256:" + sha256,
	}, nil
}

func normalizeTerraformLSVersion(version string) (string, error) {
	version = strings.TrimSpace(version)
	version = strings.TrimPrefix(version, "v")
	if !terraformLSVersionPattern.MatchString(version) {
		return "", fmt.Errorf("invalid terraform-ls release version %q", version)
	}
	return version, nil
}

func terraformLSArchive(version, platformID string) (string, string, error) {
	var platform string
	switch platformID {
	case "darwin-amd64":
		platform = "darwin_amd64"
	case "darwin-arm64":
		platform = "darwin_arm64"
	case "linux-amd64":
		platform = "linux_amd64"
	case "linux-arm64":
		platform = "linux_arm64"
	case "windows-amd64":
		platform = "windows_amd64"
	case "windows-arm64":
		platform = "windows_arm64"
	default:
		return "", "", fmt.Errorf("terraform-ls has no managed release asset for platform %s", platformID)
	}
	extractPath := "terraform-ls"
	if strings.HasPrefix(platformID, "windows-") {
		extractPath += ".exe"
	}
	return fmt.Sprintf("terraform-ls_%s_%s.zip", version, platform), extractPath, nil
}

func terraformLSGet(ctx context.Context, client *http.Client, requestURL string, maxBytes int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "knowns-lsp-installer")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<10))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxBytes {
		return nil, fmt.Errorf("response exceeds %d bytes", maxBytes)
	}
	return body, nil
}

func terraformLSChecksum(manifest []byte, archiveName string) (string, error) {
	checksum := ""
	for _, line := range strings.Split(string(manifest), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[1] != archiveName {
			continue
		}
		decoded, err := hex.DecodeString(fields[0])
		if err != nil || len(decoded) != 32 {
			return "", fmt.Errorf("invalid SHA-256 for %s", archiveName)
		}
		candidate := strings.ToLower(fields[0])
		if checksum != "" && checksum != candidate {
			return "", fmt.Errorf("conflicting SHA-256 entries for %s", archiveName)
		}
		checksum = candidate
	}
	if checksum == "" {
		return "", fmt.Errorf("published SHA-256 for %s was not found", archiveName)
	}
	return checksum, nil
}

func (a *TerraformLSAdapter) Install(ctx context.Context, targetDir string) (string, error) {
	path, err := lsp.NewInstaller(targetDir).Install(ctx, a)
	if err != nil {
		return "", fmt.Errorf("install terraform-ls: %w", err)
	}
	return path, nil
}

func (a *TerraformLSAdapter) InstalledPath() (string, bool) {
	return installedPath(a.ID(), a.RuntimeDeps())
}

func (a *TerraformLSAdapter) InitializeParams(root string, settings map[string]any) map[string]any {
	return initializeParams(root, settings)
}

func (a *TerraformLSAdapter) InitializationOptions(settings map[string]any) map[string]any {
	return initializationOptions(settings)
}
