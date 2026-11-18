//go:build windows

package main

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

var (
	pAllocConsole    = k32.NewProc("AllocConsole")
	pGenerateCtrl    = k32.NewProc("GenerateConsoleCtrlEvent")
	pSetCtrlHandler  = k32.NewProc("SetConsoleCtrlHandler")
	pOpenProcess     = k32.NewProc("OpenProcess")
	pGetExitCodeProc = k32.NewProc("GetExitCodeProcess")
)

func alive(pid int) bool {
	const processQueryLimited = 0x1000
	h, _, _ := pOpenProcess.Call(processQueryLimited, 0, uintptr(pid))
	if h == 0 {
		return false
	}
	defer syscall.CloseHandle(syscall.Handle(h))
	var code uint32
	pGetExitCodeProc.Call(h, uintptr(unsafePtr(&code)))
	return code == 259 // STILL_ACTIVE
}

func killPid(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}

func readUntil(t *testing.T, br *bufio.Reader, prefix string) string {
	t.Helper()
	deadline := time.After(20 * time.Second)
	done := make(chan string, 1)
	go func() {
		for {
			l, err := br.ReadString('\n')
			if strings.HasPrefix(l, prefix) {
				done <- strings.TrimSpace(strings.TrimPrefix(l, prefix))
				return
			}
			if err != nil {
				done <- ""
				return
			}
		}
	}()
	select {
	case v := <-done:
		return v
	case <-deadline:
		t.Fatalf("no %q line in time", prefix)
		return ""
	}
}

// Ctrl+Break aimed at the launcher's process group reaches the engine (same console, same group)
// exactly once, the launcher survives the event and reports the engine's exit code.
func TestWindowsCtrlBreakReachesTheEngineAndTheExitCodeComesBack(t *testing.T) {
	_, launcher := install(t, true)
	pAllocConsole.Call() // the SSH session has no console; the group event needs one
	pSetCtrlHandler.Call(0, 1)
	cmd := exec.Command(launcher, "wait-signal")
	cmd.Env = cleanEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(stdout)
	enginePid, _ := strconv.Atoi(readUntil(t, br, "pid="))
	readUntil(t, br, "ready")
	if r, _, err := pGenerateCtrl.Call(1, uintptr(cmd.Process.Pid)); r == 0 { // CTRL_BREAK_EVENT
		t.Skipf("no console to send Ctrl+Break on: %v", err)
	}
	got := readUntil(t, br, "got signal")
	err := cmd.Wait()
	ee, _ := err.(*exec.ExitError)
	if got == "" && ee == nil {
		t.Fatalf("engine did not get the event")
	}
	if ee == nil || ee.ExitCode() != 130 {
		t.Fatalf("launcher exit %v, want 130 from the engine", err)
	}
	if alive(enginePid) {
		t.Errorf("engine %d outlived the launcher", enginePid)
	}
}

// Killing the launcher takes the engine (and its ordinary children) with it, and nothing is left
// running; a child the engine started with CREATE_BREAKAWAY_FROM_JOB (the daemons) survives.
func TestWindowsKillingTheLauncherKillsTheEngineButNotBreakawayChildren(t *testing.T) {
	_, launcher := install(t, true)
	for _, mode := range []string{"detached", "normal"} {
		cmd := exec.Command(launcher, "spawn", mode, "stay")
		cmd.Env = cleanEnv()
		stdout, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		br := bufio.NewReader(stdout)
		child, _ := strconv.Atoi(readUntil(t, br, "child="))
		if child == 0 || !alive(child) {
			t.Fatalf("%s: child %d not running", mode, child)
		}
		cmd.Process.Kill()
		cmd.Wait()
		time.Sleep(1500 * time.Millisecond)
		if mode == "normal" && alive(child) {
			killPid(child)
			t.Errorf("normal child %d outlived a killed launcher", child)
		}
		if mode == "detached" {
			if !alive(child) {
				t.Errorf("breakaway child %d died with the launcher", child)
			}
			killPid(child)
		}
	}
}

func TestWindowsStdinPipeAndExitCodeThroughTheLauncher(t *testing.T) {
	_, launcher := install(t, true)
	out, _, code := run(t, launcher, "abc\r\ndef\r\n", cleanEnv(), "cat")
	if code != 0 || out != "abc\r\ndef\r\n" {
		t.Fatalf("code %d out %q", code, out)
	}
	if _, _, code := run(t, launcher, "", cleanEnv(), "exit", "42"); code != 42 {
		t.Fatalf("exit code %d", code)
	}
}
