package qdrantruntime

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	pathpkg "path"
	"path/filepath"
	"runtime"
	"strings"
)

const SupportedQdrantVersion = "1.14.1"
const maxQdrantArchiveBytes int64 = 512 << 20
const maxQdrantBinaryBytes int64 = 256 << 20

type Artifact struct{ OS, Arch, Filename, SHA256 string }

var supportedArtifacts = map[string]Artifact{
	// Checksums are pinned release metadata. A mirror override must serve the
	// same artifact bytes; it never weakens verification.
	"darwin/arm64": {"darwin", "arm64", "qdrant-aarch64-apple-darwin.tar.gz", "e790977ad8e93a9fdcd45d311c4e36e643187ff01ba3a7f6614ab8b02743e9ad"},
	"darwin/amd64": {"darwin", "amd64", "qdrant-x86_64-apple-darwin.tar.gz", "fac93bfd88f019afa312d9248d913a07fb68fe5b498b6927a26d699f865d9eb8"},
	"linux/amd64":  {"linux", "amd64", "qdrant-x86_64-unknown-linux-gnu.tar.gz", "7d43068cce7477061a7bd91fd5e5e139e35cfacb09d0dcdc4f4a33ace7d782d8"},
	"linux/arm64":  {"linux", "arm64", "qdrant-aarch64-unknown-linux-musl.tar.gz", "ed221c141e240d1443535ba44e71c965f1d2d5e702f01c52c5ad4b7fc64bb604"},
}

type Installer struct {
	Root, Mirror string
	HTTPClient   *http.Client
	GOOS, GOARCH string
}

func (i Installer) Install(ctx context.Context) (Paths, error) {
	osName, arch := i.GOOS, i.GOARCH
	if osName == "" {
		osName = runtime.GOOS
	}
	if arch == "" {
		arch = runtime.GOARCH
	}
	artifact, ok := supportedArtifacts[osName+"/"+arch]
	if !ok {
		return Paths{}, fmt.Errorf("unsupported Qdrant platform %s/%s; configure an external Qdrant endpoint", osName, arch)
	}
	paths := PathsForRoot(i.Root)
	if err := os.MkdirAll(paths.Root, 0o755); err != nil {
		return paths, err
	}
	manifestPath := filepath.Join(paths.Root, "install.json")
	if data, err := os.ReadFile(manifestPath); err == nil {
		var m struct {
			Version string `json:"version"`
			SHA256  string `json:"sha256"`
		}
		if json.Unmarshal(data, &m) == nil && m.Version == SupportedQdrantVersion && strings.EqualFold(m.SHA256, artifact.SHA256) {
			if info, statErr := os.Stat(paths.BinaryPath); statErr == nil && !info.IsDir() {
				return paths, nil
			}
		}
	}
	staging, err := os.MkdirTemp(paths.Root, "install-")
	if err != nil {
		return paths, err
	}
	defer os.RemoveAll(staging)
	archivePath := filepath.Join(staging, artifact.Filename)
	if err := i.fetch(ctx, artifact, archivePath); err != nil {
		return paths, err
	}
	if err := verifySHA256(archivePath, artifact.SHA256); err != nil {
		return paths, fmt.Errorf("verify pinned Qdrant %s checksum: %w", SupportedQdrantVersion, err)
	}
	stagedBinary := filepath.Join(staging, "qdrant")
	if osName == "windows" {
		stagedBinary += ".exe"
	}
	if err := extractBinary(archivePath, stagedBinary); err != nil {
		return paths, fmt.Errorf("extract verified Qdrant artifact: %w", err)
	}
	if err := os.Chmod(stagedBinary, 0o755); err != nil {
		return paths, err
	}
	if err := os.MkdirAll(paths.BinDir, 0o755); err != nil {
		return paths, err
	}
	backup := paths.BinaryPath + ".previous"
	if _, err := os.Stat(paths.BinaryPath); err == nil {
		_ = os.Remove(backup)
		if err := os.Rename(paths.BinaryPath, backup); err != nil {
			return paths, fmt.Errorf("preserve previous Qdrant binary: %w", err)
		}
	}
	if err := os.Rename(stagedBinary, paths.BinaryPath); err != nil {
		if _, statErr := os.Stat(backup); statErr == nil {
			_ = os.Rename(backup, paths.BinaryPath)
		}
		return paths, fmt.Errorf("atomically activate verified Qdrant binary: %w", err)
	}
	manifest, _ := json.MarshalIndent(struct {
		Version  string `json:"version"`
		SHA256   string `json:"sha256"`
		Artifact string `json:"artifact"`
	}{SupportedQdrantVersion, artifact.SHA256, artifact.Filename}, "", "  ")
	if err := os.WriteFile(manifestPath, manifest, 0o644); err != nil {
		return paths, fmt.Errorf("write Qdrant install manifest: %w", err)
	}
	return paths, nil
}

func (i Installer) fetch(ctx context.Context, a Artifact, dst string) error {
	base := strings.TrimSpace(i.Mirror)
	var source string
	if base == "" {
		source = "https://github.com/qdrant/qdrant/releases/download/v" + SupportedQdrantVersion + "/" + a.Filename
	} else {
		u, err := url.Parse(base)
		if err != nil {
			return fmt.Errorf("invalid Qdrant mirror URL: %w", err)
		}
		if u.Scheme == "file" {
			if u.Host != "" {
				return fmt.Errorf("Qdrant local mirror must use a local file:// path")
			}
			source = filepath.Join(u.Path, a.Filename)
		} else if u.Scheme != "https" || u.Hostname() == "" {
			return fmt.Errorf("Qdrant mirror must be HTTPS or file:// local path")
		} else {
			// Validate HTTPS URLs don't contain sensitive data
			if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
				return fmt.Errorf("Qdrant HTTPS mirror URL must not contain userinfo, query, or fragment")
			}
			u.Path = strings.TrimRight(u.Path, "/") + "/" + a.Filename
			source = u.String()
		}
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	if !strings.Contains(source, "://") {
		in, err := os.Open(source)
		if err != nil {
			return fmt.Errorf("read Qdrant local mirror %s: %w", source, err)
		}
		defer in.Close()
		if info, statErr := in.Stat(); statErr != nil {
			return statErr
		} else if info.Size() > maxQdrantArchiveBytes {
			return fmt.Errorf("Qdrant artifact exceeds %d bytes", maxQdrantArchiveBytes)
		}
		return copyLimited(out, in, maxQdrantArchiveBytes, "Qdrant artifact")
	}
	sourceURL, err := url.Parse(source)
	if err != nil || sourceURL.User != nil || sourceURL.RawQuery != "" || sourceURL.Fragment != "" {
		return fmt.Errorf("Qdrant download URL must not contain userinfo, query, or fragment")
	}
	hc := http.Client{}
	if i.HTTPClient != nil {
		hc = *i.HTTPClient
	}
	hc.CheckRedirect = qdrantRedirectPolicy(sourceURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return err
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("download Qdrant (check offline/proxy/mirror settings): %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("download Qdrant from mirror returned %s", resp.Status)
	}
	if resp.ContentLength > maxQdrantArchiveBytes {
		return fmt.Errorf("Qdrant artifact exceeds %d bytes", maxQdrantArchiveBytes)
	}
	return copyLimited(out, resp.Body, maxQdrantArchiveBytes, "Qdrant artifact")
}

func qdrantRedirectPolicy(source *url.URL) func(*http.Request, []*http.Request) error {
	initialHost := strings.ToLower(source.Hostname())
	allowSignedReleaseAssetQuery := initialHost == "github.com"
	allowedHosts := map[string]bool{initialHost: true}
	if allowSignedReleaseAssetQuery {
		allowedHosts["release-assets.githubusercontent.com"] = true
	}
	return func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return fmt.Errorf("Qdrant download redirect must remain HTTPS")
		}
		isSignedReleaseAsset := allowSignedReleaseAssetQuery && strings.EqualFold(req.URL.Hostname(), "release-assets.githubusercontent.com")
		if req.URL.User != nil || req.URL.Fragment != "" || (req.URL.RawQuery != "" && !isSignedReleaseAsset) {
			return fmt.Errorf("Qdrant download redirect must not contain userinfo, query, or fragment")
		}
		if len(via) > 0 && !allowedHosts[strings.ToLower(req.URL.Hostname())] {
			return fmt.Errorf("Qdrant download redirect to unapproved host %s", req.URL.Hostname())
		}
		return nil
	}
}
func verifySHA256(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(got, want) {
		return fmt.Errorf("checksum mismatch: got %s want %s", got, want)
	}
	return nil
}
func extractBinary(archive, dst string) error {
	if strings.HasSuffix(archive, ".zip") {
		z, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer z.Close()
		var candidate *zip.File
		for _, f := range z.File {
			if unsafeArchivePath(f.Name) {
				return fmt.Errorf("unsafe archive path %q", f.Name)
			}
			if filepath.Base(f.Name) != "qdrant" && filepath.Base(f.Name) != "qdrant.exe" {
				continue
			}
			if !f.Mode().IsRegular() {
				return fmt.Errorf("qdrant archive entry must be a regular file")
			}
			if f.UncompressedSize64 > uint64(maxQdrantBinaryBytes) {
				return fmt.Errorf("qdrant binary exceeds %d bytes", maxQdrantBinaryBytes)
			}
			if candidate != nil {
				return fmt.Errorf("duplicate qdrant binary entries in archive")
			}
			candidate = f
		}
		if candidate == nil {
			return fmt.Errorf("qdrant binary missing from archive")
		}
		r, err := candidate.Open()
		if err != nil {
			return err
		}
		defer r.Close()
		return copyExclusiveLimited(dst, r, maxQdrantBinaryBytes)
	}
	f, err := os.Open(archive)
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
	found := false
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if unsafeArchivePath(h.Name) {
			return fmt.Errorf("unsafe archive path %q", h.Name)
		}
		if h.Typeflag == tar.TypeSymlink || h.Typeflag == tar.TypeLink {
			return fmt.Errorf("archive links are not allowed: %q", h.Name)
		}
		if filepath.Base(h.Name) != "qdrant" {
			continue
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA {
			return fmt.Errorf("qdrant archive entry must be a regular file")
		}
		if h.Size < 0 || h.Size > maxQdrantBinaryBytes {
			return fmt.Errorf("qdrant binary exceeds %d bytes", maxQdrantBinaryBytes)
		}
		if found {
			return fmt.Errorf("duplicate qdrant binary entries in archive")
		}
		if err := copyExclusiveLimited(dst, tr, maxQdrantBinaryBytes); err != nil {
			return err
		}
		found = true
	}
	if !found {
		return fmt.Errorf("qdrant binary missing from archive")
	}
	return nil
}
func unsafeArchivePath(name string) bool {
	clean := pathpkg.Clean(strings.ReplaceAll(name, "\\", "/"))
	first := strings.SplitN(clean, "/", 2)[0]
	return strings.HasPrefix(clean, "/") || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(first, ":")
}
func copyExclusiveLimited(dst string, r io.Reader, limit int64) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o700)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := copyLimited(f, r, limit, "qdrant binary"); err != nil {
		_ = os.Remove(dst)
		return err
	}
	return nil
}
func copyLimited(dst io.Writer, src io.Reader, limit int64, label string) error {
	n, err := io.Copy(dst, io.LimitReader(src, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return fmt.Errorf("%s exceeds %d bytes", label, limit)
	}
	return nil
}
