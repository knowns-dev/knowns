package qdrantruntime

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerRejectsUnsupportedPlatformAndChecksumMismatch(t *testing.T) {
	for _, key := range []string{"darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"} {
		artifact, ok := supportedArtifacts[key]
		if !ok || artifact.Filename == "" || len(artifact.SHA256) != 64 {
			t.Fatalf("supported artifact %s is not fully pinned: %#v", key, artifact)
		}
	}
	if _, err := (Installer{Root: t.TempDir(), GOOS: "plan9", GOARCH: "mips"}).Install(context.Background()); err == nil || !strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("unsupported err=%v", err)
	}
	mirror := t.TempDir()
	artifact := supportedArtifacts["darwin/arm64"]
	if err := os.WriteFile(filepath.Join(mirror, artifact.Filename), []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := (Installer{Root: t.TempDir(), Mirror: "file://" + mirror, GOOS: "darwin", GOARCH: "arm64"}).Install(context.Background()); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("checksum err=%v", err)
	}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("proxy unavailable")
}

func TestInstallerReportsActionableOfflineProxyFailure(t *testing.T) {
	_, err := (Installer{Root: t.TempDir(), GOOS: "darwin", GOARCH: "arm64", HTTPClient: &http.Client{Transport: failingTransport{}}}).Install(context.Background())
	if err == nil || !strings.Contains(err.Error(), "offline/proxy/mirror") {
		t.Fatalf("offline error=%v", err)
	}
}

func TestQdrantRedirectPolicyAllowsGitHubReleaseAssetHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://release-assets.githubusercontent.com/qdrant.tar.gz?sp=r&sv=2024-11-04&sig=opaque-signature", http.StatusFound)
	}))
	defer server.Close()

	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host == "release-assets.githubusercontent.com" {
			return &http.Response{StatusCode: http.StatusOK, Status: "200 OK", Body: http.NoBody, Header: make(http.Header), Request: req}, nil
		}
		return http.DefaultTransport.RoundTrip(req)
	})
	source, _ := url.Parse("https://github.com/qdrant/qdrant/releases/download/v1.14.1/qdrant.tar.gz")
	client := &http.Client{Transport: transport, CheckRedirect: qdrantRedirectPolicy(source)}
	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("approved redirect rejected: %v", err)
	}
	resp.Body.Close()
}

func TestQdrantRedirectPolicyRejectsUnapprovedDowngradeAndSecrets(t *testing.T) {
	tests := []struct {
		name, source, location string
	}{
		{name: "unapproved host", source: "https://github.com/qdrant/qdrant/releases/download/v1.14.1/qdrant.tar.gz", location: "https://downloads.example.test/qdrant.tar.gz"},
		{name: "http downgrade", source: "https://github.com/qdrant/qdrant/releases/download/v1.14.1/qdrant.tar.gz", location: "http://github.com/qdrant.tar.gz"},
		{name: "mirror query", source: "https://mirror.example.test/qdrant.tar.gz", location: "https://mirror.example.test/qdrant.tar.gz?token=secret"},
		{name: "userinfo", source: "https://github.com/qdrant/qdrant/releases/download/v1.14.1/qdrant.tar.gz", location: "https://user:pass@release-assets.githubusercontent.com/qdrant.tar.gz"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, tt.location, http.StatusFound)
			}))
			defer server.Close()
			source, _ := url.Parse(tt.source)
			client := &http.Client{CheckRedirect: qdrantRedirectPolicy(source)}
			_, err := client.Get(server.URL)
			if err == nil {
				t.Fatalf("redirect %q unexpectedly accepted", tt.location)
			}
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestInstallerAtomicActivationReusesVerifiedManifestAndPreservesPrevious(t *testing.T) {
	mirror := t.TempDir()
	name := "test-qdrant.tar.gz"
	archive := filepath.Join(mirror, name)
	writeTestQdrantArchive(t, archive, []byte("new-binary"))
	data, _ := os.ReadFile(archive)
	sum := sha256.Sum256(data)
	old := supportedArtifacts["darwin/arm64"]
	supportedArtifacts["darwin/arm64"] = Artifact{"darwin", "arm64", name, hex.EncodeToString(sum[:])}
	defer func() { supportedArtifacts["darwin/arm64"] = old }()
	root := t.TempDir()
	paths := PathsForRoot(root)
	if err := os.MkdirAll(paths.BinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.BinaryPath, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	installer := Installer{Root: root, Mirror: "file://" + mirror, GOOS: "darwin", GOARCH: "arm64"}
	if _, err := installer.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(paths.BinaryPath)
	previous, _ := os.ReadFile(paths.BinaryPath + ".previous")
	if string(got) != "new-binary" || string(previous) != "old-binary" {
		t.Fatalf("active=%q previous=%q", got, previous)
	}
	if err := os.Remove(archive); err != nil {
		t.Fatal(err)
	}
	if _, err := installer.Install(context.Background()); err != nil {
		t.Fatalf("verified reuse attempted download: %v", err)
	}
}

func writeTestQdrantArchive(t *testing.T, path string, body []byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "qdrant", Mode: 0o755, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestExtractBinaryRejectsUnsafeDuplicateLinkAndOversizeEntries(t *testing.T) {
	tests := []struct {
		name    string
		headers []tar.Header
		want    string
	}{
		{"traversal", []tar.Header{{Name: "../qdrant", Typeflag: tar.TypeReg, Mode: 0o755, Size: 1}}, "unsafe archive path"},
		{"symlink", []tar.Header{{Name: "qdrant", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh"}}, "links are not allowed"},
		{"hardlink", []tar.Header{{Name: "qdrant", Typeflag: tar.TypeLink, Linkname: "other"}}, "links are not allowed"},
		{"non-regular", []tar.Header{{Name: "qdrant", Typeflag: tar.TypeDir}}, "regular file"},
		{"duplicate", []tar.Header{{Name: "qdrant", Typeflag: tar.TypeReg, Mode: 0o755, Size: 1}, {Name: "nested/qdrant", Typeflag: tar.TypeReg, Mode: 0o755, Size: 1}}, "duplicate"},
		{"oversize", []tar.Header{{Name: "qdrant", Typeflag: tar.TypeReg, Mode: 0o755, Size: maxQdrantBinaryBytes + 1}}, "exceeds"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			archive := filepath.Join(t.TempDir(), "bad.tar.gz")
			writeTarHeaders(t, archive, tt.headers)
			err := extractBinary(archive, filepath.Join(t.TempDir(), "qdrant"))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("err=%v want %q", err, tt.want)
			}
		})
	}
}

func writeTarHeaders(t *testing.T, path string, headers []tar.Header) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, h := range headers {
		header := h
		if err := tw.WriteHeader(&header); err != nil {
			t.Fatal(err)
		}
		if header.Typeflag == tar.TypeReg && header.Size > 0 && header.Size <= 16 {
			_, _ = tw.Write(make([]byte, header.Size))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()
}
