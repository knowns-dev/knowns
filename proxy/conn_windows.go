//go:build windows

package main

import (
	"errors"
	"io"
	"os"
	"runtime"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	createNoWindow  = 0x08000000
	detachedProcess = 0x00000008
	newProcGroup    = 0x00000200
)

func daemonFiles() ([]*os.File, func()) { return []*os.File{nil, nil, nil}, func() {} }

// DETACHED_PROCESS, no console window, no inherited handles: with nil files os.StartProcess passes
// an empty handle list, so nothing leaks from the agent's process into the daemon.
func daemonAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: detachedProcess | newProcGroup | createNoWindow}
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
)

const (
	genericRW      = 0xC0000000
	openExisting   = 3
	flagOverlapped = 0x40000000
	errIOPending   = 997
	errPipeBusy    = 231
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
	closed   atomic.Bool
}

func dial(kind, addr string) (io.ReadWriteCloser, error) {
	if kind != "windows_pipe" {
		return nil, errors.New("unsupported endpoint kind " + kind)
	}
	name, err := syscall.UTF16PtrFromString(addr)
	if err != nil {
		return nil, err
	}
	for i := 0; i < 20; i++ {
		h, _, e := pCreateFile.Call(uintptr(unsafe.Pointer(name)), genericRW, 0, 0, openExisting, flagOverlapped, 0)
		if syscall.Handle(h) != syscall.InvalidHandle {
			rev, _, _ := pCreateEvent.Call(0, 1, 0, 0)
			wev, _, _ := pCreateEvent.Call(0, 1, 0, 0)
			return &winPipe{h: syscall.Handle(h), rev: syscall.Handle(rev), wev: syscall.Handle(wev)}, nil
		}
		if e == syscall.Errno(errPipeBusy) {
			pWaitPipe.Call(uintptr(unsafe.Pointer(name)), 200)
			continue
		}
		return nil, e
	}
	return nil, errors.New("pipe busy")
}

func (p *winPipe) do(fn *syscall.LazyProc, ev syscall.Handle, b []byte) (int, error) {
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
		if p.closed.Load() {
			return 0, io.EOF
		}
		n, err := p.do(pReadFile, p.rev, b)
		if err != nil {
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
		if p.closed.Load() {
			return total, io.ErrClosedPipe
		}
		n, err := p.do(pWriteFile, p.wev, b[total:])
		if err != nil {
			return total, err
		}
		total += n
	}
	return total, nil
}

func (p *winPipe) Close() error {
	if p.closed.Swap(true) {
		return nil
	}
	pCancelIoEx.Call(uintptr(p.h), 0)
	time.Sleep(5 * time.Millisecond)
	syscall.CloseHandle(p.h)
	return nil
}
