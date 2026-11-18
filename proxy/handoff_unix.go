//go:build !windows

package main

import (
	"os"
	"syscall"
)

// handoff replaces this process with the engine: no second process, no extra memory, the same pid,
// signals and terminal. It returns only when the exec failed.
func handoff(engine string, args []string) int {
	argv0 := os.Args[0]
	if argv0 == "" {
		argv0 = engine
	}
	err := syscall.Exec(engine, append([]string{argv0}, args...), engineEnv())
	code := 126
	if os.IsNotExist(err) {
		code = 127
	}
	return missingEngine("cannot run the knowns engine at "+engine+": "+err.Error(), code)
}
