//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
	newProcGroup    = 0x00000200
	breakawayJob    = 0x01000000
)

func daemonFiles() ([]*os.File, func()) { return []*os.File{nil, nil, nil}, func() {} }

// DETACHED_PROCESS, no console window, no inherited handles: with nil files os.StartProcess passes
// an empty handle list, so nothing leaks from the agent's process into the daemon.
func daemonAttr(breakaway bool) *syscall.SysProcAttr {
	flags := uint32(detachedProcess | newProcGroup | createNoWindow)
	if breakaway {
		flags |= breakawayJob
	}
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}

// The child keeps the three standard handles (os/exec restricts inheritance to exactly those).
func childAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

var (
	k32            = syscall.NewLazyDLL("kernel32.dll")
	pCreateFile    = k32.NewProc("CreateFileW")
	pReadFile      = k32.NewProc("ReadFile")
	pWriteFile     = k32.NewProc("WriteFile")
	pCreateEvent   = k32.NewProc("CreateEventW")
	pGetOverlapped = k32.NewProc("GetOverlappedResult")
	pCancelIoEx    = k32.NewProc("CancelIoEx")
	pWaitPipe      = k32.NewProc("WaitNamedPipeW")
	pServerPid     = k32.NewProc("GetNamedPipeServerProcessId")
)

const (
	genericRW      = 0xC0000000
	openExisting   = 3
	flagOverlapped = 0x40000000
	// SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server can learn who connected but can
	// never impersonate this user, so a pipe squatting on the daemon's name gains nothing.
	flagIdentify = 0x00100000 | 0x00010000
	errIOPending = 997
	errPipeBusy  = 231
)

type overlapped struct {
	Internal, InternalHigh uintptr
	Offset, OffsetHigh     uint32
	HEvent                 syscall.Handle
}

// newOverlapped returns a heap object: the kernel keeps the pointer while the I/O is pending, so
// it must never live on a movable goroutine stack.
//
//go:noinline
func newOverlapped(ev syscall.Handle) *overlapped { return &overlapped{HEvent: ev} }

type winPipe struct {
	h        syscall.Handle
	rev, wev syscall.Handle

	mu     sync.Mutex
	closed bool
	active sync.WaitGroup // calls inside ReadFile/WriteFile; Close waits for them before CloseHandle
}

func dial(kind, addr string, wantPid int) (io.ReadWriteCloser, error) {
	if kind != "windows_pipe" {
		return nil, errors.New("unsupported endpoint kind " + kind)
	}
	name, err := syscall.UTF16PtrFromString(addr)
	if err != nil {
		return nil, err
	}
	var h syscall.Handle
	var lastErr error
	for i := 0; i < 20; i++ {
		r, _, e := pCreateFile.Call(uintptr(unsafe.Pointer(name)), genericRW, 0, 0, openExisting, flagOverlapped|flagIdentify, 0)
		if syscall.Handle(r) != syscall.InvalidHandle {
			h = syscall.Handle(r)
			break
		}
		lastErr = e
		if e == syscall.Errno(errPipeBusy) {
			pWaitPipe.Call(uintptr(unsafe.Pointer(name)), 200)
			continue
		}
		return nil, e
	}
	if h == 0 {
		if lastErr == nil {
			lastErr = errors.New("pipe busy")
		}
		return nil, lastErr
	}
	if wantPid > 0 {
		var pid uint32
		if r, _, _ := pServerPid.Call(uintptr(h), uintptr(unsafe.Pointer(&pid))); r == 0 || int(pid) != wantPid {
			syscall.CloseHandle(h)
			return nil, errBadServer
		}
	}
	rev, _, e1 := pCreateEvent.Call(0, 1, 0, 0)
	if rev == 0 {
		syscall.CloseHandle(h)
		return nil, e1
	}
	wev, _, e2 := pCreateEvent.Call(0, 1, 0, 0)
	if wev == 0 {
		syscall.CloseHandle(syscall.Handle(rev))
		syscall.CloseHandle(h)
		return nil, e2
	}
	return &winPipe{h: h, rev: syscall.Handle(rev), wev: syscall.Handle(wev)}, nil
}

func (p *winPipe) enter() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.active.Add(1)
	return true
}

func (p *winPipe) do(fn *syscall.LazyProc, ev syscall.Handle, b []byte) (int, error) {
	if !p.enter() {
		return 0, io.ErrClosedPipe
	}
	defer p.active.Done()
	o := newOverlapped(ev)
	var n uint32
	r, _, e := fn.Call(uintptr(p.h), uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&n)), uintptr(unsafe.Pointer(o)))
	if r == 0 {
		if e != syscall.Errno(errIOPending) {
			return 0, e
		}
		r, _, e = pGetOverlapped.Call(uintptr(p.h), uintptr(unsafe.Pointer(o)), uintptr(unsafe.Pointer(&n)), 1)
		if r == 0 {
			return 0, e
		}
	}
	runtime.KeepAlive(o)
	runtime.KeepAlive(b)
	return int(n), nil
}

func (p *winPipe) Read(b []byte) (int, error) {
	if len(b) == 0 {
		return 0, nil
	}
	for {
		n, err := p.do(pReadFile, p.rev, b)
		if err != nil {
			if err == io.ErrClosedPipe {
				return n, io.EOF
			}
			if errno, ok := err.(syscall.Errno); ok && (errno == 109 || errno == 233 || errno == 995 || errno == 6) {
				return n, io.EOF
			}
			return n, err
		}
		if n > 0 {
			return n, nil
		}
	}
}

func (p *winPipe) Write(b []byte) (int, error) {
	total := 0
	for total < len(b) {
		n, err := p.do(pWriteFile, p.wev, b[total:])
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

// Close stops new calls, cancels the ones in progress and only then closes the handle, so a reader
// that was descheduled can never call ReadFile on a handle value the system has already reused.
func (p *winPipe) Close() error {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return nil
	}
	p.closed = true
	p.mu.Unlock()
	done := make(chan struct{})
	go func() { p.active.Wait(); close(done) }()
	for waiting := true; waiting; {
		pCancelIoEx.Call(uintptr(p.h), 0)
		select {
		case <-done:
			waiting = false
		case <-time.After(10 * time.Millisecond):
		}
	}
	syscall.CloseHandle(p.h)
	syscall.CloseHandle(p.rev)
	syscall.CloseHandle(p.wev)
	return nil
}
