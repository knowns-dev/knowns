//go:build windows

package main

import (
	"os"
	"strings"
	"syscall"
	"unsafe"
)

var (
	pCreateJobObject         = k32.NewProc("CreateJobObjectW")
	pSetInformationJobObject = k32.NewProc("SetInformationJobObject")
	pAssignProcessToJob      = k32.NewProc("AssignProcessToJobObject")
	pResumeThread            = k32.NewProc("ResumeThread")
	pSetConsoleCtrlHandler   = k32.NewProc("SetConsoleCtrlHandler")
	pSetHandleInformation    = k32.NewProc("SetHandleInformation")
)

const (
	jobObjectExtendedLimitInformation = 9
	jobLimitKillOnJobClose            = 0x2000
	jobLimitBreakawayOK               = 0x800
	createSuspended                   = 0x4
	createUnicodeEnvironment          = 0x400
	startfUseStdHandles               = 0x100
	handleFlagInherit                 = 1
)

// jobExtendedLimits is JOBOBJECT_EXTENDED_LIMIT_INFORMATION for the 64-bit targets (amd64, arm64).
type jobExtendedLimits struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
	IoInfo                  [6]uint64
	ProcessMemoryLimit      uintptr
	JobMemoryLimit          uintptr
	PeakProcessMemoryUsed   uintptr
	PeakJobMemoryUsed       uintptr
}

// killOnCloseJob makes a job whose processes die when this launcher does. BREAKAWAY_OK (not
// SILENT_BREAKAWAY_OK) lets the engine start the runtime daemon, LSP daemon and UI listener with
// CREATE_BREAKAWAY_FROM_JOB so they outlive a short command, while ordinary children still die.
func killOnCloseJob() syscall.Handle {
	h, _, _ := pCreateJobObject.Call(0, 0)
	if h == 0 {
		return 0
	}
	info := jobExtendedLimits{LimitFlags: jobLimitKillOnJobClose | jobLimitBreakawayOK}
	r, _, _ := pSetInformationJobObject.Call(h, jobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		syscall.CloseHandle(syscall.Handle(h))
		return 0
	}
	return syscall.Handle(h)
}

// shieldConsoleEvents keeps Ctrl+C and Ctrl+Break from ending the launcher. The engine is in the
// same console and receives its own copy of the event, so forwarding it would deliver it twice;
// the launcher only has to outlive it and report the engine's exit code. Close, logoff and
// shutdown are left alone: the launcher ends and the job takes the engine with it.
func shieldConsoleEvents() {
	cb := syscall.NewCallback(func(ctrlType uint32) uintptr {
		if ctrlType == 0 || ctrlType == 1 { // CTRL_C_EVENT, CTRL_BREAK_EVENT
			return 1
		}
		return 0
	})
	pSetConsoleCtrlHandler.Call(cb, 1)
}

func envBlock(env []string) *uint16 {
	var b []uint16
	for _, e := range env {
		if strings.IndexByte(e, 0) >= 0 {
			continue
		}
		u, err := syscall.UTF16FromString(e)
		if err != nil {
			continue
		}
		b = append(b, u...) // UTF16FromString appends the terminating NUL
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	b = append(b, 0)
	return &b[0]
}

// handoff runs the engine as a child with this process's std handles and environment, waits for
// it and returns its exit code.
func handoff(engine string, args []string) int {
	cmd := syscall.EscapeArg(engine)
	for _, a := range args {
		cmd += " " + syscall.EscapeArg(a)
	}
	app, err := syscall.UTF16PtrFromString(engine)
	if err != nil {
		return missingEngine("bad engine path "+engine, 126)
	}
	cmdline, err := syscall.UTF16PtrFromString(cmd)
	if err != nil {
		return missingEngine("bad arguments", 126)
	}
	var std [3]syscall.Handle
	for i, id := range []int{syscall.STD_INPUT_HANDLE, syscall.STD_OUTPUT_HANDLE, syscall.STD_ERROR_HANDLE} {
		h, _ := syscall.GetStdHandle(id)
		std[i] = h
		if h != 0 && h != syscall.InvalidHandle {
			pSetHandleInformation.Call(uintptr(h), handleFlagInherit, handleFlagInherit)
		}
	}
	job := killOnCloseJob()
	shieldConsoleEvents()

	si := &syscall.StartupInfo{Flags: startfUseStdHandles, StdInput: std[0], StdOutput: std[1], StdErr: std[2]}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi syscall.ProcessInformation
	// Suspended, so the engine is in the job before it can start anything of its own.
	err = syscall.CreateProcess(app, cmdline, nil, nil, true, createSuspended|createUnicodeEnvironment, envBlock(engineEnv()), nil, si, &pi)
	if err != nil {
		code := 126
		if os.IsNotExist(err) || err == syscall.ERROR_FILE_NOT_FOUND || err == syscall.ERROR_PATH_NOT_FOUND {
			code = 127
		}
		return missingEngine("cannot run the knowns engine at "+engine+": "+err.Error(), code)
	}
	defer syscall.CloseHandle(pi.Process)
	defer syscall.CloseHandle(pi.Thread)
	if job != 0 {
		pAssignProcessToJob.Call(uintptr(job), uintptr(pi.Process))
	}
	pResumeThread.Call(uintptr(pi.Thread))
	if _, err := syscall.WaitForSingleObject(pi.Process, syscall.INFINITE); err != nil {
		return missingEngine("waiting for the knowns engine failed: "+err.Error(), 1)
	}
	var code uint32
	if err := syscall.GetExitCodeProcess(pi.Process, &code); err != nil {
		return 1
	}
	return int(code)
}
