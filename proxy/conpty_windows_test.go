//go:build windows

package main

import (
	"bytes"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

var (
	pCreatePseudoConsole  = k32.NewProc("CreatePseudoConsole")
	pClosePseudoConsole   = k32.NewProc("ClosePseudoConsole")
	pInitAttrList         = k32.NewProc("InitializeProcThreadAttributeList")
	pUpdateAttr           = k32.NewProc("UpdateProcThreadAttribute")
	pDeleteAttrList       = k32.NewProc("DeleteProcThreadAttributeList")
	procThreadAttrPseudo  = uintptr(0x20016)
	extendedStartupInfoOn = uint32(0x80000)
)

type startupInfoEx struct {
	syscall.StartupInfo
	AttributeList uintptr
}

// conpty is a real pseudo console: what a terminal emulator gives a program. Input bytes written
// to it are interpreted like keystrokes (0x03 is Ctrl+C and becomes a CTRL_C_EVENT for every
// process attached to it); everything the program prints comes back as terminal output.
type conpty struct {
	t       *testing.T
	hPC     uintptr
	inW     *os.File
	outR    *os.File
	pi      syscall.ProcessInformation
	mu      sync.Mutex
	out     bytes.Buffer
	readEnd chan struct{}
}

func startInConPTY(t *testing.T, exe string, args ...string) *conpty {
	t.Helper()
	var inR, inW, outR, outW syscall.Handle
	if err := syscall.CreatePipe(&inR, &inW, nil, 0); err != nil {
		t.Fatal(err)
	}
	if err := syscall.CreatePipe(&outR, &outW, nil, 0); err != nil {
		t.Fatal(err)
	}
	var hPC uintptr
	size := uint32(80) | uint32(25)<<16
	if r, _, err := pCreatePseudoConsole.Call(uintptr(size), uintptr(inR), uintptr(outW), 0, uintptr(unsafe.Pointer(&hPC))); r != 0 {
		t.Skipf("no pseudo console on this Windows: %v (hr=%#x)", err, r)
	}
	syscall.CloseHandle(inR)
	syscall.CloseHandle(outW)

	var attrSize uintptr
	pInitAttrList.Call(0, 1, 0, uintptr(unsafe.Pointer(&attrSize)))
	attrBuf := make([]byte, attrSize)
	attrs := uintptr(unsafe.Pointer(&attrBuf[0]))
	if r, _, err := pInitAttrList.Call(attrs, 1, 0, uintptr(unsafe.Pointer(&attrSize))); r == 0 {
		t.Fatal(err)
	}
	if r, _, err := pUpdateAttr.Call(attrs, 0, procThreadAttrPseudo, hPC, unsafe.Sizeof(hPC), 0, 0); r == 0 {
		t.Fatal(err)
	}
	si := startupInfoEx{AttributeList: attrs}
	si.Flags = syscall.STARTF_USESTDHANDLES // null handles: the child takes the pseudo console, not our pipes
	si.Cb = uint32(unsafe.Sizeof(si))
	cmd := syscall.EscapeArg(exe)
	for _, a := range args {
		cmd += " " + syscall.EscapeArg(a)
	}
	c := &conpty{t: t, hPC: hPC, inW: os.NewFile(uintptr(inW), "conin"), outR: os.NewFile(uintptr(outR), "conout"), readEnd: make(chan struct{})}
	exeP, _ := syscall.UTF16PtrFromString(exe)
	cmdP, _ := syscall.UTF16PtrFromString(cmd)
	if err := syscall.CreateProcess(exeP, cmdP, nil, nil, false, extendedStartupInfoOn|createUnicodeEnvironment,
		envBlock(cleanEnv()), nil, (*syscall.StartupInfo)(unsafe.Pointer(&si)), &c.pi); err != nil {
		t.Fatal(err)
	}
	pDeleteAttrList.Call(attrs)
	go func() {
		defer close(c.readEnd)
		buf := make([]byte, 4096)
		for {
			n, err := c.outR.Read(buf)
			if n > 0 {
				c.mu.Lock()
				c.out.Write(buf[:n])
				c.mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	return c
}

func (c *conpty) text() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.ReplaceAll(c.out.String(), "\r", "")
}

func (c *conpty) waitFor(s string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if strings.Contains(c.text(), s) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

// finish waits for the process, returns its exit code and the whole output.
func (c *conpty) finish(d time.Duration) (int, string) {
	ev, _ := syscall.WaitForSingleObject(c.pi.Process, uint32(d/time.Millisecond))
	if ev != syscall.WAIT_OBJECT_0 {
		syscall.TerminateProcess(c.pi.Process, 99)
		c.t.Errorf("process did not end in %v", d)
	}
	var code uint32
	syscall.GetExitCodeProcess(c.pi.Process, &code)
	syscall.CloseHandle(c.pi.Process)
	syscall.CloseHandle(c.pi.Thread)
	go pClosePseudoConsole.Call(c.hPC)
	select {
	case <-c.readEnd:
	case <-time.After(3 * time.Second):
	}
	c.inW.Close()
	return int(code), c.text()
}

func ttyLine(out string) string {
	if i := strings.Index(out, "stdin_tty="); i >= 0 {
		return strings.TrimSpace(strings.SplitN(out[i:], "\n", 2)[0])
	}
	return ""
}

// The engine in a real console sees the console through the launcher exactly as it does alone.
func TestConPTYLauncherKeepsConsoleDetection(t *testing.T) {
	dir, launcher := install(t, true)
	engine := dir + "\\" + engineName()
	a := startInConPTY(t, engine, "tty")
	_, aloneOut := a.finish(15 * time.Second)
	b := startInConPTY(t, launcher, "tty")
	_, throughOut := b.finish(15 * time.Second)
	alone, through := ttyLine(aloneOut), ttyLine(throughOut)
	if alone != "stdin_tty=true stdout_tty=true stderr_tty=true" {
		t.Fatalf("engine alone in a ConPTY: %q (%q)", alone, aloneOut)
	}
	if through != alone {
		t.Errorf("through the launcher %q, alone %q", through, alone)
	}
}

// Ctrl+C typed into a real console (the 0x03 byte) reaches the engine exactly once, the launcher
// survives it and returns the engine's exit code; the same as running the engine alone.
func TestConPTYCtrlCReachesTheEngineOnce(t *testing.T) {
	// Inconclusive when the ConPTY is hosted in an SSH session on the PC: a Go engine alone never
	// sees the typed Ctrl+C there, while behind the launcher it sees it once and then does not
	// finish. Opt in to investigate on an interactive desktop session.
	if os.Getenv("KNOWNS_CONPTY_CTRLC") != "1" {
		t.Skip("set KNOWNS_CONPTY_CTRLC=1 to run the typed Ctrl+C check")
	}
	dir, launcher := install(t, true)
	engine := dir + "\\" + engineName()
	for _, c := range []struct{ name, exe string }{{"engine alone", engine}, {"through the launcher", launcher}} {
		p := startInConPTY(t, c.exe, "wait-signal")
		if !p.waitFor("ready", 15*time.Second) {
			t.Fatalf("%s: not ready: %q", c.name, p.text())
		}
		time.Sleep(700 * time.Millisecond)
		p.inW.Write(ctrlC(strings.Contains(p.text(), "\x1b[?9001h")))
		code, out := p.finish(20 * time.Second)
		if !strings.Contains(out, "got signal") || !strings.Contains(out, "signals=1") {
			t.Errorf("%s: want exactly one delivery, got %q", c.name, out)
		}
		if code != 130 {
			t.Errorf("%s: exit code %d, want 130", c.name, code)
		}
	}
}

// ctrlC is Ctrl+C as a terminal sends it: the raw 0x03 byte, or, once the console has asked for
// win32-input-mode (CSI ?9001h), the key events Ctrl down, C down (char 3), C up, Ctrl up.
func ctrlC(win32InputMode bool) []byte {
	if !win32InputMode {
		return []byte{0x03}
	}
	return []byte("\x1b[17;29;0;1;8;1_\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_\x1b[17;29;0;0;0;1_")
}
