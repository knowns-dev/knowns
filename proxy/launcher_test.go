package main

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The launcher is built once and run as a real process against a fake engine that reports what it
// was given, so the handoff is tested as users see it: exit codes, stdin, argv[0], environment,
// signals, a missing or broken engine.

const fakeEngineSrc = `package main

import (
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"syscall"
)

func main() {
	args := os.Args[1:]
	if len(args) > 0 {
		switch args[0] {
		case "exit":
			n, _ := strconv.Atoi(args[1])
			os.Exit(n)
		case "cat":
			io.Copy(os.Stdout, os.Stdin)
			return
		case "wait-signal":
			c := make(chan os.Signal, 1)
			signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
			fmt.Println("ready")
			<-c
			fmt.Println("got signal")
			os.Exit(130)
		}
	}
	fmt.Printf("argv0=%s\n", os.Args[0])
	for _, a := range args {
		fmt.Printf("arg=%q\n", a)
	}
	fmt.Printf("launcher=%s\n", os.Getenv("KNOWNS_LAUNCHER"))
	fmt.Printf("proxy=%s\n", os.Getenv("KNOWNS_MCP_PROXY"))
}
`

var (
	buildOnce    sync.Once
	launcherExe  string
	fakeEngineEx string
	buildErr     error
)

func exeSuffix() string {
	if runtime.GOOS == "windows" {
		return ".exe"
	}
	return ""
}

func buildBoth(t *testing.T) (string, string) {
	t.Helper()
	buildOnce.Do(func() {
		dir, err := os.MkdirTemp("", "knowns-launcher-test-")
		if err != nil {
			buildErr = err
			return
		}
		launcherExe = filepath.Join(dir, "launcher"+exeSuffix())
		out, err := exec.Command("go", "build", "-o", launcherExe, ".").CombinedOutput()
		if err != nil {
			buildErr = &buildFailure{string(out)}
			return
		}
		src := filepath.Join(dir, "engine-src")
		os.MkdirAll(src, 0o755)
		os.WriteFile(filepath.Join(src, "main.go"), []byte(fakeEngineSrc), 0o644)
		os.WriteFile(filepath.Join(src, "go.mod"), []byte("module fakeengine\n\ngo 1.21\n"), 0o644)
		fakeEngineEx = filepath.Join(dir, "engine"+exeSuffix())
		cmd := exec.Command("go", "build", "-o", fakeEngineEx, ".")
		cmd.Dir = src
		if out, err := cmd.CombinedOutput(); err != nil {
			buildErr = &buildFailure{string(out)}
		}
	})
	if buildErr != nil {
		t.Fatal(buildErr)
	}
	return launcherExe, fakeEngineEx
}

type buildFailure struct{ out string }

func (b *buildFailure) Error() string { return "build failed: " + b.out }

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	data, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, data, 0o755); err != nil {
		t.Fatal(err)
	}
}

// install lays out a directory the way an installed copy looks: knowns + knowns-engine.
func install(t *testing.T, withEngine bool) (dir, launcher string) {
	t.Helper()
	l, e := buildBoth(t)
	dir = t.TempDir()
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		dir = r
	}
	launcher = filepath.Join(dir, "knowns"+exeSuffix())
	copyFile(t, l, launcher)
	if withEngine {
		copyFile(t, e, filepath.Join(dir, engineName()))
	}
	return dir, launcher
}

func cleanEnv(extra ...string) []string {
	var out []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "KNOWNS_") {
			continue
		}
		out = append(out, e)
	}
	return append(out, extra...)
}

func run(t *testing.T, launcher string, stdin string, env []string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	cmd := exec.Command(launcher, args...)
	cmd.Env = env
	cmd.Stdin = strings.NewReader(stdin)
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	code = 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return so.String(), se.String(), code
}

func TestLauncherPassesArgumentsAndEnvironmentToTheEngine(t *testing.T) {
	dir, launcher := install(t, true)
	out, _, code := run(t, launcher, "", cleanEnv(), "task", "list", "two words", `quo"te`, "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	for _, want := range []string{"arg=\"task\"", "arg=\"list\"", "arg=\"two words\"", `arg="quo\"te"`, `arg=""`, "launcher=" + launcher} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if !strings.Contains(out, "proxy=\n") {
		t.Errorf("KNOWNS_MCP_PROXY must not be invented:\n%s", out)
	}
	_ = dir
}

func TestLauncherPassesExitCodesThrough(t *testing.T) {
	_, launcher := install(t, true)
	for _, n := range []string{"0", "1", "7", "42"} {
		_, _, code := run(t, launcher, "", cleanEnv(), "exit", n)
		if strconvAtoi(n) != code {
			t.Errorf("exit %s: got %d", n, code)
		}
	}
}

func strconvAtoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func TestLauncherPipesStdinToTheEngine(t *testing.T) {
	_, launcher := install(t, true)
	payload := strings.Repeat("line of input\n", 5000)
	out, _, code := run(t, launcher, payload, cleanEnv(), "cat")
	if code != 0 || out != payload {
		t.Fatalf("code %d, echoed %d of %d bytes", code, len(out), len(payload))
	}
}

func TestLauncherFindsTheEngineThroughASymlinkAndKeepsArgv0(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows; kn.exe is a copy there")
	}
	dir, launcher := install(t, true)
	link := filepath.Join(t.TempDir(), "kn")
	if err := os.Symlink(launcher, link); err != nil {
		t.Fatal(err)
	}
	out, _, code := run(t, link, "", cleanEnv(), "status")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if !strings.Contains(out, "argv0="+link) && !strings.Contains(out, "argv0=kn") {
		t.Errorf("argv[0] lost:\n%s", out)
	}
	if !strings.Contains(out, "launcher="+launcher) {
		t.Errorf("KNOWNS_LAUNCHER must be the resolved path %s:\n%s", launcher, out)
	}
	_ = dir
}

func TestLauncherKnCopyFindsTheEngineBesideItself(t *testing.T) {
	dir, launcher := install(t, true)
	kn := filepath.Join(dir, "kn"+exeSuffix())
	copyFile(t, launcher, kn)
	out, _, code := run(t, kn, "", cleanEnv(), "status")
	if code != 0 || !strings.Contains(out, "arg=\"status\"") || !strings.Contains(out, "launcher="+kn) {
		t.Fatalf("exit %d:\n%s", code, out)
	}
}

func TestLauncherDeliversInterruptToTheEngine(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Ctrl+C on Windows is tested on a console, see KN-06XWDR")
	}
	_, launcher := install(t, true)
	cmd := exec.Command(launcher, "wait-signal")
	cmd.Env = cleanEnv()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(stdout)
	line, _ := br.ReadString('\n')
	if strings.TrimSpace(line) != "ready" {
		t.Fatalf("engine not ready: %q", line)
	}
	cmd.Process.Signal(syscall.SIGINT) // exec replaced the launcher: this pid is the engine
	rest, _ := io.ReadAll(br)
	err := cmd.Wait()
	ee, _ := err.(*exec.ExitError)
	if ee == nil || ee.ExitCode() != 130 || !strings.Contains(string(rest), "got signal") {
		t.Fatalf("engine did not see the interrupt: %v %q", err, rest)
	}
}

func TestLauncherReportsAMissingEngine(t *testing.T) {
	_, launcher := install(t, false)
	_, stderr, code := run(t, launcher, "", cleanEnv(), "task", "list")
	if code != 127 {
		t.Errorf("exit %d, want 127", code)
	}
	for _, want := range []string{engineName(), "reinstall", reinstallHint(launcher)} {
		if !strings.Contains(stderr, want) {
			t.Errorf("stderr lacks %q:\n%s", want, stderr)
		}
	}
	// --version still says something useful: the launcher's own version, plus the error.
	out, stderr, code := run(t, launcher, "", cleanEnv(), "--version")
	if code == 0 || !strings.Contains(out, "knowns version dev") || !strings.Contains(stderr, engineName()) {
		t.Errorf("--version without an engine: code %d out %q err %q", code, out, stderr)
	}
}

func TestLauncherNamesNpmWhenInstalledByNpm(t *testing.T) {
	l, _ := buildBoth(t)
	dir := filepath.Join(t.TempDir(), "node_modules", "knowns", "bin")
	os.MkdirAll(dir, 0o755)
	launcher := filepath.Join(dir, "knowns"+exeSuffix())
	copyFile(t, l, launcher)
	_, stderr, code := run(t, launcher, "", cleanEnv(), "task", "list")
	if code != 127 || !strings.Contains(stderr, "npm i -g knowns") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestLauncherReportsABrokenEngine(t *testing.T) {
	dir, launcher := install(t, false)
	os.WriteFile(filepath.Join(dir, engineName()), []byte("this is not an executable\n"), 0o755)
	_, stderr, code := run(t, launcher, "", cleanEnv(), "task", "list")
	if code != 126 || !strings.Contains(stderr, "cannot run the knowns engine") || !strings.Contains(stderr, "reinstall") {
		t.Errorf("code %d stderr %q", code, stderr)
	}
}

func TestLauncherMcpOptOutRunsTheEnginesInProcessMcp(t *testing.T) {
	_, launcher := install(t, true)
	out, _, code := run(t, launcher, "", cleanEnv("KNOWNS_MCP_PROXY=0"), "mcp", "--stdio")
	if code != 0 || !strings.Contains(out, "arg=\"mcp\"") || !strings.Contains(out, "arg=\"--stdio\"") || !strings.Contains(out, "proxy=0") {
		t.Fatalf("exit %d:\n%s", code, out)
	}
}

func TestLauncherHandsOtherMcpInvocationsToTheEngine(t *testing.T) {
	_, launcher := install(t, true)
	for _, args := range [][]string{{"mcp", "--help"}, {"mcp"}, {"mcp", "--stdio", "--http"}} {
		out, _, code := run(t, launcher, "", cleanEnv(), args...)
		if code != 0 || !strings.Contains(out, "arg=\"mcp\"") {
			t.Errorf("%v: exit %d:\n%s", args, code, out)
		}
	}
}

func TestMcpStdioRecognition(t *testing.T) {
	cases := []struct {
		args    []string
		project string
		ok      bool
	}{
		{[]string{"mcp", "--stdio"}, "", true},
		{[]string{"mcp", "--stdio", "--project", "/p"}, "/p", true},
		{[]string{"mcp", "--project=/p", "--stdio"}, "/p", true},
		{[]string{"mcp"}, "", false},
		{[]string{"mcp", "--stdio", "--debug"}, "", false},
		{[]string{"mcp", "--help"}, "", false},
		{[]string{"task", "mcp", "--stdio"}, "", false},
		{nil, "", false},
	}
	for _, c := range cases {
		p, ok := mcpStdio(c.args)
		if ok != c.ok || p != c.project {
			t.Errorf("%v: got (%q, %v), want (%q, %v)", c.args, p, ok, c.project, c.ok)
		}
	}
}

// With no daemon to be had the launcher serves `mcp --stdio` through the engine's in-process
// server: here the fake engine echoes, so the line the agent sent comes straight back.
func TestLauncherMcpFallsBackToTheEngineChild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("covered by the Windows run on the PC")
	}
	dir, launcher := install(t, false)
	script := "#!/bin/sh\nif [ \"$1\" = \"__runtime\" ]; then exit 0; fi\nif [ \"$KNOWNS_MCP_PROXY\" != \"0\" ]; then echo bad-env >&2; exit 9; fi\nexec cat\n"
	os.WriteFile(filepath.Join(dir, engineName()), []byte(script), 0o755)
	root := t.TempDir()
	env := cleanEnv("KNOWNS_RUNTIME_ROOT="+root, "HOME="+root)
	cmd := exec.Command(launcher, "mcp", "--stdio")
	cmd.Env = env
	cmd.Dir = dir
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line := `{"jsonrpc":"2.0","method":"ping","id":1}` + "\n"
	io.WriteString(stdin, line)
	got := make(chan string, 1)
	go func() { s, _ := bufio.NewReader(stdout).ReadString('\n'); got <- s }()
	select {
	case s := <-got:
		if s != line {
			t.Errorf("echo %q", s)
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("no answer through the engine child; stderr: %s", stderr.String())
	}
	stdin.Close()
	cmd.Process.Kill() // the proxy session end is covered by its own tests
	cmd.Wait()
}
