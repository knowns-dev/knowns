//go:build !windows

package main

import (
	"os/exec"
	"runtime"
	"strings"
	"testing"
)

// ttyReport runs argv under a pseudo terminal with script(1) (a real pty, so the engine sees a TTY)
// and returns the engine's own report.
func ttyReport(t *testing.T, argv ...string) string {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "darwin" {
		cmd = exec.Command("script", append([]string{"-q", "/dev/null"}, argv...)...)
	} else {
		cmd = exec.Command("script", "-qc", strings.Join(argv, " "), "/dev/null")
	}
	cmd.Env = cleanEnv()
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("script: %v\n%s", err, out)
	}
	text := strings.ReplaceAll(string(out), "\r", "")
	if i := strings.Index(text, "stdin_tty="); i >= 0 {
		return strings.TrimSpace(strings.SplitN(text[i:], "\n", 2)[0])
	}
	t.Fatalf("no tty report in %q", out)
	return ""
}

// The engine must see the same terminal through the launcher as when it runs alone: a pty stays
// a TTY (colors and prompts), a pipe stays a pipe. exec keeps the descriptors, so this is the
// whole contract on macOS and Linux.
func TestLauncherKeepsTTYDetection(t *testing.T) {
	if _, err := exec.LookPath("script"); err != nil {
		t.Skip("no script(1) to make a pty")
	}
	dir, launcher := install(t, true)
	engine := dir + "/" + engineName()

	alone := ttyReport(t, engine, "tty")
	through := ttyReport(t, launcher, "tty")
	if alone != "stdin_tty=true stdout_tty=true stderr_tty=true" {
		t.Fatalf("the pty harness is not giving a TTY: %q", alone)
	}
	if through != alone {
		t.Errorf("under a pty: launcher %q, engine alone %q", through, alone)
	}

	pipedAlone, _, _ := run(t, engine, "", cleanEnv(), "tty")
	pipedThrough, _, _ := run(t, launcher, "", cleanEnv(), "tty")
	want := "stdin_tty=false stdout_tty=false stderr_tty=false\n"
	if pipedAlone != want || pipedThrough != want {
		t.Errorf("piped: launcher %q, engine alone %q", pipedThrough, pipedAlone)
	}
}
