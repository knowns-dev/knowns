package lspdaemon

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

var safeKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*-[0-9a-f]{16}$`)

func TestProjectIdentityCanonicalRootAndSafeKey(t *testing.T) {
	parent := t.TempDir()
	project := filepath.Join(parent, "My Project One")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}

	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("get wd: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWD) })
	if err := os.Chdir(parent); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	identity, err := IdentifyProject("My Project One")
	if err != nil {
		t.Fatalf("identify project: %v", err)
	}
	if want := canonicalForTest(t, project); identity.Root != want {
		t.Fatalf("root = %q, want %q", identity.Root, want)
	}
	if !safeKeyPattern.MatchString(identity.Key) {
		t.Fatalf("key %q is not filesystem-safe stable format", identity.Key)
	}
	if strings.ContainsAny(identity.Key, `/\:`) {
		t.Fatalf("key %q contains path or pipe separators", identity.Key)
	}
	if got := KeyForRoot(identity.Root); got != identity.Key {
		t.Fatalf("KeyForRoot = %q, want %q", got, identity.Key)
	}
}

func TestProjectIdentitySymlinkEquivalentPaths(t *testing.T) {
	target := t.TempDir()
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "project-link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	targetIdentity, err := IdentifyProject(target)
	if err != nil {
		t.Fatalf("identify target: %v", err)
	}
	linkIdentity, err := IdentifyProject(link)
	if err != nil {
		t.Fatalf("identify link: %v", err)
	}
	if targetIdentity != linkIdentity {
		t.Fatalf("symlink identity mismatch:\ntarget=%+v\nlink=%+v", targetIdentity, linkIdentity)
	}
}

func TestPathsUseKnownsRuntimeRootAndProjectScope(t *testing.T) {
	paths, home, _ := newTestPaths(t)

	wantGlobal := filepath.Join(home, ".knowns")
	wantRuntime := filepath.Join(wantGlobal, "runtime")
	if paths.GlobalRoot != wantGlobal {
		t.Fatalf("global root = %q, want %q", paths.GlobalRoot, wantGlobal)
	}
	if paths.RuntimeRoot != wantRuntime {
		t.Fatalf("runtime root = %q, want %q", paths.RuntimeRoot, wantRuntime)
	}
	if want := filepath.Join(wantRuntime, daemonRuntimeDir, paths.Project.Key); paths.DaemonDir != want {
		t.Fatalf("daemon dir = %q, want %q", paths.DaemonDir, want)
	}

	for _, path := range []string{paths.LockPath, paths.StatePath, paths.TokenPath, paths.LogPath} {
		rel, err := filepath.Rel(paths.DaemonDir, path)
		if err != nil {
			t.Fatalf("rel(%q): %v", path, err)
		}
		if rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			t.Fatalf("path %q is not scoped under daemon dir %q", path, paths.DaemonDir)
		}
	}
	if rel, err := filepath.Rel(os.TempDir(), paths.SocketPath); err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		t.Fatalf("socket path %q is not scoped under temp dir %q", paths.SocketPath, os.TempDir())
	}
	legacySocketPath := filepath.Join(paths.DaemonDir, "daemon.sock")
	if len(paths.SocketPath) >= len(legacySocketPath) {
		t.Fatalf("socket path = %q, want shorter than legacy path %q", paths.SocketPath, legacySocketPath)
	}
}

func TestClientsForSameProjectShareEndpointAndToken(t *testing.T) {
	home := isolateHome(t)
	root := t.TempDir()
	clientA, err := NewClient(root)
	if err != nil {
		t.Fatalf("client A: %v", err)
	}
	clientB, err := NewClient(root)
	if err != nil {
		t.Fatalf("client B: %v", err)
	}
	if clientA.identity != clientB.identity {
		t.Fatalf("identity mismatch: %+v != %+v", clientA.identity, clientB.identity)
	}
	if clientA.paths.SocketPath != clientB.paths.SocketPath {
		t.Fatalf("socket path mismatch: %q != %q", clientA.paths.SocketPath, clientB.paths.SocketPath)
	}
	if clientA.token == "" || clientA.token != clientB.token {
		t.Fatalf("shared token mismatch: %q != %q", clientA.token, clientB.token)
	}
	if !strings.HasPrefix(clientA.paths.DaemonDir, filepath.Join(home, ".knowns", "runtime")) {
		t.Fatalf("daemon dir = %q, want under isolated runtime root", clientA.paths.DaemonDir)
	}
}

func TestRunAcceptsSharedClients(t *testing.T) {
	isolateHome(t)
	root := t.TempDir()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	project := &models.Project{
		Name:      "daemon-test",
		ID:        "daemon-test",
		CreatedAt: time.Now().UTC(),
		Settings:  models.DefaultProjectSettings(),
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() { errCh <- Run(ctx, root) }()

	clientA, err := NewClient(root)
	if err != nil {
		t.Fatalf("client A: %v", err)
	}
	waitForPing(t, clientA)

	clientB, err := NewClient(root)
	if err != nil {
		t.Fatalf("client B: %v", err)
	}
	if clientA.paths.SocketPath != clientB.paths.SocketPath {
		t.Fatalf("socket path mismatch: %q != %q", clientA.paths.SocketPath, clientB.paths.SocketPath)
	}
	if clientA.token != clientB.token {
		t.Fatalf("token mismatch: %q != %q", clientA.token, clientB.token)
	}
	if err := clientB.Ping(context.Background()); err != nil {
		t.Fatalf("client B ping: %v", err)
	}
	statuses, err := clientB.RuntimeStatuses(context.Background())
	if err != nil {
		t.Fatalf("daemon statuses: %v", err)
	}
	if len(statuses) == 0 {
		t.Fatal("daemon statuses empty")
	}
	if statuses[0].Owner != "daemon" || statuses[0].DaemonPID == 0 || statuses[0].DaemonTransport == "" || statuses[0].DaemonEndpoint == "" {
		t.Fatalf("daemon metadata missing from status: %#v", statuses[0])
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for daemon shutdown")
	}
}

func waitForPing(t *testing.T, client *Client) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := client.Ping(context.Background()); err == nil {
			return
		} else {
			lastErr = err
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for ping: %v", lastErr)
}

func TestTokenPermissionsAndReuse(t *testing.T) {
	paths, _, _ := newTestPaths(t)

	first, err := EnsureToken(paths)
	if err != nil {
		t.Fatalf("ensure token first: %v", err)
	}
	if len(first) != tokenByteLen*2 {
		t.Fatalf("token length = %d, want %d", len(first), tokenByteLen*2)
	}
	requireDirMode(t, paths.DaemonDir, 0o700)
	requireFileMode(t, paths.TokenPath, 0o600)

	second, err := EnsureToken(paths)
	if err != nil {
		t.Fatalf("ensure token second: %v", err)
	}
	if second != first {
		t.Fatalf("token was not reused: first=%q second=%q", first, second)
	}
	raw, err := os.ReadFile(paths.TokenPath)
	if err != nil {
		t.Fatalf("read token file: %v", err)
	}
	if strings.TrimSpace(string(raw)) != first {
		t.Fatalf("token file content mismatch")
	}
}

func TestStatePermissionsAndReadback(t *testing.T) {
	paths, _, _ := newTestPaths(t)

	if err := WriteState(paths, State{PID: 1234}); err != nil {
		t.Fatalf("write state: %v", err)
	}
	requireFileMode(t, paths.StatePath, 0o600)

	state, err := ReadState(paths)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	if state.ProjectRoot != paths.Project.Root {
		t.Fatalf("state root = %q, want %q", state.ProjectRoot, paths.Project.Root)
	}
	if state.ProjectKey != paths.Project.Key {
		t.Fatalf("state key = %q, want %q", state.ProjectKey, paths.Project.Key)
	}
	if state.PID != 1234 {
		t.Fatalf("state pid = %d, want 1234", state.PID)
	}
	if state.Endpoint != paths.Endpoint() {
		t.Fatalf("state endpoint = %+v, want %+v", state.Endpoint, paths.Endpoint())
	}
	if state.UpdatedAt.IsZero() {
		t.Fatalf("state UpdatedAt was not populated")
	}
}

func TestValidateHandshakeRejectsMismatchedRootAndToken(t *testing.T) {
	project := t.TempDir()
	otherProject := t.TempDir()
	identity, err := IdentifyProject(project)
	if err != nil {
		t.Fatalf("identify project: %v", err)
	}
	token := "0123456789abcdef0123456789abcdef"

	if err := ValidateHandshake(identity, token, Handshake{ProjectRoot: project, Token: token}); err != nil {
		t.Fatalf("valid handshake rejected: %v", err)
	}
	if err := ValidateHandshake(identity, token, Handshake{ProjectRoot: otherProject, Token: token}); !errors.Is(err, ErrProjectMismatch) {
		t.Fatalf("root mismatch error = %v, want ErrProjectMismatch", err)
	}
	if err := ValidateHandshake(identity, token, Handshake{ProjectRoot: project, Token: token + "x"}); !errors.Is(err, ErrTokenMismatch) {
		t.Fatalf("token mismatch error = %v, want ErrTokenMismatch", err)
	}
	if !TokenEqual(token, token) {
		t.Fatalf("TokenEqual rejected identical tokens")
	}
	if TokenEqual(token, token+"x") {
		t.Fatalf("TokenEqual accepted mismatched tokens")
	}
}

func TestProjectLockRemovesStaleLock(t *testing.T) {
	paths, _, _ := newTestPaths(t)
	if err := paths.EnsureDir(); err != nil {
		t.Fatalf("ensure dir: %v", err)
	}
	if err := os.WriteFile(paths.LockPath, []byte("stale"), 0o600); err != nil {
		t.Fatalf("write stale lock: %v", err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(paths.LockPath, past, past); err != nil {
		t.Fatalf("chtimes stale lock: %v", err)
	}

	lock, err := AcquireProjectLock(paths, LockOptions{
		Timeout:      200 * time.Millisecond,
		StaleAge:     time.Millisecond,
		PollInterval: time.Millisecond,
	})
	if err != nil {
		t.Fatalf("acquire stale lock: %v", err)
	}
	requireFileMode(t, paths.LockPath, 0o600)
	raw, err := os.ReadFile(paths.LockPath)
	if err != nil {
		t.Fatalf("read lock: %v", err)
	}
	if got, want := strings.TrimSpace(string(raw)), strconv.Itoa(os.Getpid()); got != want {
		t.Fatalf("lock content = %q, want pid %q", got, want)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release lock: %v", err)
	}
	if _, err := os.Stat(paths.LockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock file after release error = %v, want not exist", err)
	}
}

func TestTransportEndpointNames(t *testing.T) {
	paths, _, _ := newTestPaths(t)

	unixEndpoint := paths.EndpointForGOOS("linux")
	if unixEndpoint.Kind != TransportUnixSocket {
		t.Fatalf("unix kind = %q, want %q", unixEndpoint.Kind, TransportUnixSocket)
	}
	if unixEndpoint.Address != paths.SocketPath {
		t.Fatalf("unix address = %q, want %q", unixEndpoint.Address, paths.SocketPath)
	}

	windowsEndpoint := paths.EndpointForGOOS("windows")
	wantPipe := `\\.\pipe\knowns-lsp-` + paths.Project.Key
	if windowsEndpoint.Kind != TransportWindowsPipe {
		t.Fatalf("windows kind = %q, want %q", windowsEndpoint.Kind, TransportWindowsPipe)
	}
	if windowsEndpoint.Address != wantPipe {
		t.Fatalf("windows pipe = %q, want %q", windowsEndpoint.Address, wantPipe)
	}
	keyPart := strings.TrimPrefix(windowsEndpoint.Address, `\\.\pipe\knowns-lsp-`)
	if keyPart != paths.Project.Key {
		t.Fatalf("pipe key part = %q, want %q", keyPart, paths.Project.Key)
	}
	if strings.ContainsAny(keyPart, `/\:`) {
		t.Fatalf("pipe key %q contains path or pipe separators", keyPart)
	}
}

func newTestPaths(t *testing.T) (Paths, string, string) {
	t.Helper()
	home := isolateHome(t)
	project := t.TempDir()
	paths, err := PathsForProject(project)
	if err != nil {
		t.Fatalf("paths for project: %v", err)
	}
	return paths, home, project
}

func isolateHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	volume := filepath.VolumeName(home)
	t.Setenv("HOMEDRIVE", volume)
	t.Setenv("HOMEPATH", strings.TrimPrefix(home, volume))
	return home
}

func canonicalForTest(t *testing.T, path string) string {
	t.Helper()
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("abs path: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	return filepath.Clean(abs)
}

func requireFileMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode(%s) = %04o, want %04o", path, got, want)
	}
}

func requireDirMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if !info.IsDir() {
		t.Fatalf("%s is not a directory", path)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode(%s) = %04o, want %04o", path, got, want)
	}
}
