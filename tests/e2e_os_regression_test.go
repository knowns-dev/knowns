package tests

// OS regression tests.
//
// Every test here pins an OS-specific bug that was already fixed in the Go
// implementation. They drive the binary only through its CLI and HTTP surface,
// so they run unchanged against any TEST_BINARY (including the TypeScript
// build). The inventory with commit/issue, platform and test per fix lives in
// the doc specs/2026-11-03/os-regression-inventory.
//
// Platform-specific tests call t.Skip with a reason on other platforms.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---------- helpers ----------

// osrHome returns a fresh temp dir to use as the user's home directory.
func osrHome(t *testing.T) string {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp home: %v", err)
	}
	return home
}

// osrEnv returns the environment for a child process whose home directory is
// home on every platform (os.UserHomeDir reads HOME on Unix, USERPROFILE on
// Windows).
func osrEnv(home string, extra ...string) []string {
	env := append(os.Environ(),
		"NO_COLOR=1",
		"HOME="+home,
		"USERPROFILE="+home,
		"KNOWNS_LSP_DAEMON=0",
	)
	return append(env, extra...)
}

// osrRun runs the binary in dir with an isolated home.
func osrRun(t *testing.T, dir, home string, extra []string, args ...string) CLIResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, getBinaryPath(t), args...)
	cmd.Dir = dir
	cmd.Env = osrEnv(home, extra...)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	return CLIResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: code}
}

// osrInlineRun runs the binary with the runtime kept in-process.
func osrInlineRun(t *testing.T, dir, home string, args ...string) CLIResult {
	t.Helper()
	return osrRun(t, dir, home, []string{"KNOWNS_RUNTIME_INLINE=1"}, args...)
}

// osrInitProject creates a git repo at dir and runs knowns init.
func osrInitProject(t *testing.T, dir, _ string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@e2e.local"},
		{"config", "user.name", "E2E Test"},
	} {
		c := exec.Command("git", args...)
		c.Dir = dir
		if err := c.Run(); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	// init runs with the developer's real environment, like setupTestProject:
	// with an empty home it downloads language servers and takes over a minute.
	// Only the commands under test run with the isolated home.
	res := runCli(t, dir, "init", "osr-test", "--no-wizard")
	if res.ExitCode != 0 {
		t.Fatalf("knowns init failed (code %d): %s\n%s", res.ExitCode, res.Stderr, res.Stdout)
	}
}

func osrFreePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// osrBrowser is a running `knowns browser` server.
type osrBrowser struct {
	base string
	cmd  *exec.Cmd
}

// osrStartBrowser starts `knowns browser` against project (spelled exactly as
// given) with an isolated home and waits until the API answers.
func osrStartBrowser(t *testing.T, home, project string) *osrBrowser {
	t.Helper()
	port := osrFreePort(t)
	cmd := exec.Command(getBinaryPath(t), "browser", "--project", project, "--no-open", "--port", strconv.Itoa(port))
	cmd.Dir = home
	cmd.Env = osrEnv(home, "KNOWNS_RUNTIME_INLINE=1")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		t.Fatalf("start browser: %v", err)
	}
	b := &osrBrowser{base: fmt.Sprintf("http://127.0.0.1:%d", port), cmd: cmd}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
		// Stop anything the server left running in this home so the temp dir
		// can be removed.
		osrRun(t, home, home, []string{"KNOWNS_RUNTIME_INLINE=1"}, "runtime", "stop")
		time.Sleep(300 * time.Millisecond)
	})

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(b.base + "/api/workspaces")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == 200 {
				return b
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("browser did not answer on %s within 60s", b.base)
	return nil
}

func (b *osrBrowser) get(t *testing.T, path string) []byte {
	t.Helper()
	resp, err := http.Get(b.base + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return body
}

type osrWorkspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

func (b *osrBrowser) workspaces(t *testing.T) []osrWorkspace {
	t.Helper()
	var ws []osrWorkspace
	body := b.get(t, "/api/workspaces")
	if err := json.Unmarshal(body, &ws); err != nil {
		t.Fatalf("decode /api/workspaces: %v\n%s", err, truncate(string(body), 400))
	}
	return ws
}

func osrReadRegistry(t *testing.T, home string) []osrWorkspace {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, ".knowns", "registry.json"))
	if err != nil {
		t.Fatalf("read registry.json under isolated home: %v", err)
	}
	var ws []osrWorkspace
	if err := json.Unmarshal(data, &ws); err != nil {
		t.Fatalf("decode registry.json: %v\n%s", err, truncate(string(data), 400))
	}
	return ws
}

// osrCaseInsensitiveProject builds <tmp>/MixedCase/Project and returns it plus
// an all-lowercase spelling. It skips when the filesystem is case-sensitive,
// because then the two spellings are different directories and the bug cannot
// occur.
func osrCaseInsensitiveProject(t *testing.T, home string) (onDisk, lowered string) {
	t.Helper()
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skipf("path-casing fixes apply to case-insensitive filesystems (Windows, default macOS); %s is case-sensitive", runtime.GOOS)
	}
	root := osrHome(t)
	onDisk = filepath.Join(root, "MixedCase", "Project")
	lowered = filepath.Join(strings.ToLower(root), "mixedcase", "project")
	osrInitProject(t, onDisk, home)
	if _, err := os.Stat(lowered); err != nil {
		t.Skipf("filesystem under %s is case-sensitive (lowercase spelling does not resolve): %v", root, err)
	}
	return onDisk, lowered
}

// ---------- #144, a888550, 090ca95: workspace registry path casing ----------

// A folder reached through a differently cased path must register under the
// spelling stored on disk, not the spelling the caller typed.
func TestOSRegression_RegistryStoresOnDiskCasing(t *testing.T) {
	home := osrHome(t)
	onDisk, lowered := osrCaseInsensitiveProject(t, home)

	b := osrStartBrowser(t, home, lowered)
	ws := b.workspaces(t)
	if len(ws) != 1 {
		t.Fatalf("expected exactly 1 workspace, got %d: %+v", len(ws), ws)
	}
	// Compare through EvalSymlinks so /var vs /private/var does not matter,
	// but keep the casing the caller typed out of the picture.
	got, err := filepath.EvalSymlinks(ws[0].Path)
	if err != nil {
		t.Fatalf("resolve registered path %q: %v", ws[0].Path, err)
	}
	if got != onDisk && ws[0].Path != onDisk {
		t.Fatalf("registered path %q is not the on-disk spelling %q", ws[0].Path, onDisk)
	}
	if reg := osrReadRegistry(t, home); len(reg) != 1 || reg[0].Path != ws[0].Path {
		t.Fatalf("registry.json disagrees with the API: %+v vs %+v", reg, ws)
	}
}

// One folder spelled two ways in an already-written registry must collapse to a
// single workspace row when read (registries written before the fix).
func TestOSRegression_RegistryCollapsesCaseDuplicates(t *testing.T) {
	home := osrHome(t)
	onDisk, lowered := osrCaseInsensitiveProject(t, home)

	entries := []map[string]any{
		{"id": "aaaaaa", "name": "Osr", "path": onDisk, "lastUsed": "2026-01-01T00:00:00Z"},
		{"id": "bbbbbb", "name": "osr", "path": lowered, "lastUsed": "2026-01-02T00:00:00Z"},
	}
	data, _ := json.Marshal(entries)
	if err := os.MkdirAll(filepath.Join(home, ".knowns"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".knowns", "registry.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	b := osrStartBrowser(t, home, onDisk)
	if ws := b.workspaces(t); len(ws) != 1 {
		t.Fatalf("one folder under two spellings must be one workspace, got %d: %+v", len(ws), ws)
	}
}

// ---------- c17bab0, 19c18f5, d492c81: HOME / USERPROFILE isolation ----------

// User-level state (registry, runtime) must land under the home directory the
// platform reports: HOME on Unix, USERPROFILE on Windows. A binary that reads
// the wrong variable shares state between supposedly isolated runs.
func TestOSRegression_HomeIsolation(t *testing.T) {
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	b := osrStartBrowser(t, home, proj)
	if ws := b.workspaces(t); len(ws) != 1 {
		t.Fatalf("expected 1 workspace in the isolated home, got %+v", ws)
	}
	if reg := osrReadRegistry(t, home); len(reg) != 1 {
		t.Fatalf("expected registry.json under isolated home to hold 1 project, got %+v", reg)
	}

	// A second, separate home must not see the first one's registry.
	other := osrHome(t)
	proj2 := filepath.Join(osrHome(t), "proj2")
	osrInitProject(t, proj2, other)
	b2 := osrStartBrowser(t, other, proj2)
	ws := b2.workspaces(t)
	if len(ws) != 1 || ws[0].Path == "" || strings.EqualFold(filepath.Base(ws[0].Path), "proj") {
		t.Fatalf("second home leaked state from the first: %+v", ws)
	}
}

// ---------- 354c413: macOS kqueue descriptor exhaustion ----------

func osrOpenFDs(t *testing.T, pid int) int {
	t.Helper()
	if entries, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid)); err == nil {
		return len(entries)
	}
	if _, err := exec.LookPath("lsof"); err != nil {
		t.Skip("neither /proc nor lsof available to count file descriptors")
	}
	out, err := exec.Command("lsof", "-p", strconv.Itoa(pid)).Output()
	if err != nil && len(out) == 0 {
		t.Skipf("lsof could not inspect pid %d: %v", pid, err)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	return len(lines) - 1 // header
}

// The shared runtime must not hold a watch descriptor per source file. On macOS
// kqueue costs one descriptor per watched file, so watching source trees across
// many registered projects exhausted the per-process limit.
func TestOSRegression_RuntimeDoesNotWatchSourceTree(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skipf("descriptor counting uses lsof or /proc; not available on %s", runtime.GOOS)
	}
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	const sourceFiles = 1500
	src := filepath.Join(proj, "src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < sourceFiles; i++ {
		if err := os.WriteFile(filepath.Join(src, fmt.Sprintf("f%d.txt", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// Run without KNOWNS_RUNTIME_INLINE so a shared runtime process starts.
	t.Cleanup(func() { osrRun(t, proj, home, nil, "runtime", "stop") })
	res := osrRun(t, proj, home, nil, "task", "create", "watch probe")
	requireSuccess(t, res, "task create")

	pidFile := filepath.Join(home, ".knowns", "runtime", "knowns-runtime.pid")
	var pid int
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(pidFile); err == nil {
			if p, err := strconv.Atoi(strings.TrimSpace(string(data))); err == nil && p > 0 {
				pid = p
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	if pid == 0 {
		t.Skipf("no shared runtime pid file at %s; this build keeps the runtime elsewhere or inline", pidFile)
	}
	time.Sleep(3 * time.Second) // let the watcher attach to the registered project

	if n := osrOpenFDs(t, pid); n >= sourceFiles {
		t.Fatalf("runtime pid %d holds %d descriptors with %d source files in the project: source tree appears to be watched", pid, n, sourceFiles)
	}
}

// ---------- 405587c, 09c5a96: path containment across platforms ----------

func TestOSRegression_DocPathContainment(t *testing.T) {
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)
	outside := osrHome(t)

	// Parent traversal, forward and backslash spelling, must be refused on
	// every platform (a backslash is a separator on Windows).
	for _, folder := range []string{"../../escape", `..\..\escape`} {
		res := osrInlineRun(t, proj, home, "doc", "create", "Escape", "-f", folder, "-c", "x")
		if res.ExitCode == 0 {
			t.Errorf("doc create -f %q must be rejected, got success:\n%s", folder, res.Stdout)
		}
	}

	// An absolute folder (Unix style on every platform, drive style on Windows)
	// must never write outside the project: it is refused or re-rooted below
	// .knowns/docs.
	abs := []string{filepath.ToSlash(filepath.Join(outside, "abs-unix"))}
	if runtime.GOOS == "windows" {
		abs = append(abs, filepath.Join(outside, "abs-win"))
	}
	for _, folder := range abs {
		osrInlineRun(t, proj, home, "doc", "create", "Absolute", "-f", folder, "-c", "x")
	}
	var stray []string
	_ = filepath.WalkDir(outside, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			stray = append(stray, p)
		}
		return nil
	})
	if len(stray) > 0 {
		t.Fatalf("doc create wrote outside the project: %v", stray)
	}
	if _, err := os.Stat(filepath.Join(proj, "..", "escape")); err == nil {
		t.Fatalf("doc create escaped through parent traversal")
	}
}

func TestOSRegression_DocSymlinkEscape(t *testing.T) {
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	outside := osrHome(t)
	secret := filepath.Join(outside, "secret.md")
	if err := os.WriteFile(secret, []byte("---\ntitle: Secret\n---\nTOPSECRETMARKER\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(proj, ".knowns", "docs", "linkdir")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("cannot create symlinks on this host (%s needs privilege or developer mode): %v", runtime.GOOS, err)
	}

	res := osrInlineRun(t, proj, home, "doc", "view", "linkdir/secret", "--plain")
	if strings.Contains(res.Stdout, "TOPSECRETMARKER") {
		t.Fatalf("doc view followed a symlink out of .knowns/docs:\n%s", res.Stdout)
	}

	// Writing through the link must not touch the outside directory either.
	osrInlineRun(t, proj, home, "doc", "create", "Planted", "-f", "linkdir", "-c", "x")
	entries, _ := os.ReadDir(outside)
	for _, e := range entries {
		if e.Name() != "secret.md" {
			t.Fatalf("doc create wrote %q through a symlink outside the project", e.Name())
		}
	}
}

// ---------- 5bca0e2, 12341b8: Windows cannot fsync a directory ----------

// Windows returns ERROR_ACCESS_DENIED when a directory is fsynced. Writes that
// append history must treat that as success: create, edit and history must work
// and the history must record every revision.
func TestOSRegression_HistoryWriteSurvivesDirectorySync(t *testing.T) {
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	requireSuccess(t, osrInlineRun(t, proj, home, "doc", "create", "History Probe", "-c", "one"), "doc create")
	requireSuccess(t, osrInlineRun(t, proj, home, "doc", "edit", "history-probe", "-c", "two"), "doc edit 1")
	requireSuccess(t, osrInlineRun(t, proj, home, "doc", "edit", "history-probe", "-a", "three"), "doc edit 2")

	res := osrInlineRun(t, proj, home, "doc", "history", "history-probe", "--plain")
	requireSuccess(t, res, "doc history")
	if strings.Contains(res.Stdout, "No version history") || strings.TrimSpace(res.Stdout) == "" {
		t.Fatalf("expected recorded history after edits, got:\n%s", res.Stdout)
	}

	task := osrInlineRun(t, proj, home, "task", "create", "History task")
	requireSuccess(t, task, "task create")
	id := extractTaskIDShort(task.Stdout)
	if id == "" {
		t.Fatalf("no task id in output: %s", task.Stdout)
	}
	requireSuccess(t, osrInlineRun(t, proj, home, "task", "edit", id, "-s", "in-progress"), "task edit")
}

// ---------- BOM tolerance (Windows PowerShell writes UTF-8 with BOM) ----------

// Files edited by Windows PowerShell 5 (Set-Content -Encoding UTF8) start with
// a UTF-8 byte order mark. Project config must still load.
func TestOSRegression_ConfigAcceptsUTF8BOM(t *testing.T) {
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	path := filepath.Join(proj, ".knowns", "config.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := os.WriteFile(path, append([]byte{0xEF, 0xBB, 0xBF}, data...), 0o644); err != nil {
		t.Fatal(err)
	}
	res := osrInlineRun(t, proj, home, "task", "list", "--plain")
	if res.ExitCode != 0 {
		t.Fatalf("config.json with a UTF-8 BOM must load, got code %d:\n%s%s", res.ExitCode, res.Stdout, res.Stderr)
	}
}

// Known gap in the Go build: registry.json with a BOM is not read (the project
// list comes back empty). Recorded as the contract for the TypeScript build and
// only enforced when KNOWNS_OSR_EXPECT_BOM_REGISTRY=1.
func TestOSRegression_RegistryAcceptsUTF8BOM(t *testing.T) {
	if os.Getenv("KNOWNS_OSR_EXPECT_BOM_REGISTRY") != "1" {
		t.Skip("Go build does not tolerate a BOM in registry.json (no fix to preserve); set KNOWNS_OSR_EXPECT_BOM_REGISTRY=1 to enforce against the TypeScript build")
	}
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)

	b := osrStartBrowser(t, home, proj)
	_ = b.cmd.Process.Kill()
	_, _ = b.cmd.Process.Wait()
	path := filepath.Join(home, ".knowns", "registry.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read registry: %v", err)
	}
	if err := os.WriteFile(path, append([]byte{0xEF, 0xBB, 0xBF}, data...), 0o644); err != nil {
		t.Fatal(err)
	}
	b2 := osrStartBrowser(t, home, proj)
	if ws := b2.workspaces(t); len(ws) != 1 {
		t.Fatalf("registry.json with a UTF-8 BOM must load and keep 1 workspace, got %+v", ws)
	}
}

// #155 (open): install.json written with a BOM made `knowns update` fail with
// "read install metadata: invalid character". The Go implementation still has
// the bug and update needs the network, so the contract is recorded here but
// only runs when explicitly enabled for the TypeScript build.
func TestOSRegression_UpdateReadsBOMInstallMetadata(t *testing.T) {
	if os.Getenv("KNOWNS_OSR_EXPECT_BOM_INSTALL_JSON") != "1" {
		t.Skip("issue #155 is still open in the Go build and update needs the npm registry; set KNOWNS_OSR_EXPECT_BOM_INSTALL_JSON=1 to enforce against the TypeScript build")
	}
	home := osrHome(t)
	dir := osrHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".knowns"), 0o755); err != nil {
		t.Fatal(err)
	}
	meta := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"method":"script","managedBy":"script","updateStrategy":"self-update"}`)...)
	if err := os.WriteFile(filepath.Join(home, ".knowns", "install.json"), meta, 0o644); err != nil {
		t.Fatal(err)
	}
	res := osrInlineRun(t, dir, home, "update")
	if strings.Contains(res.Stdout+res.Stderr, "read install metadata") {
		t.Fatalf("update failed to read BOM-prefixed install.json:\n%s%s", res.Stdout, res.Stderr)
	}
}

// ---------- #138, 2ecd073: Windows console handle leak ----------

func osrCountProcesses(t *testing.T, image string) int {
	t.Helper()
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq "+image, "/NH", "/FO", "CSV").Output()
	if err != nil {
		t.Skipf("tasklist unavailable: %v", err)
	}
	n := 0
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), `"`+image) {
			n++
		}
	}
	return n
}

// Polling the runtime status endpoints (what the web UI does continuously)
// must not spawn a hidden console host per poll. Before the fix every poll ran
// docker/dotnet probes and leaked conhost.exe/OpenConsole.exe.
func TestOSRegression_StatusPollingDoesNotLeakConsoles(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("conhost.exe/OpenConsole.exe leak is Windows-only (issue #138)")
	}
	home := osrHome(t)
	proj := filepath.Join(osrHome(t), "proj")
	osrInitProject(t, proj, home)
	b := osrStartBrowser(t, home, proj)

	b.get(t, "/api/runtime/ps") // warm up any one-time probe cache
	before := osrCountProcesses(t, "conhost.exe") + osrCountProcesses(t, "OpenConsole.exe")
	for i := 0; i < 30; i++ {
		b.get(t, "/api/runtime/ps")
		b.get(t, "/api/status")
	}
	time.Sleep(2 * time.Second)
	after := osrCountProcesses(t, "conhost.exe") + osrCountProcesses(t, "OpenConsole.exe")
	// Other programs may open consoles meanwhile; a per-poll leak would add 30+.
	if after-before > 5 {
		t.Fatalf("console host processes grew from %d to %d across 60 status polls", before, after)
	}
}
