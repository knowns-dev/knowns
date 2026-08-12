package process

import (
	"context"
	"os/exec"
)

// CommandContext returns an exec.Cmd configured with the project's default
// child-process policy. On Windows, short-lived probes should not allocate
// visible console windows when invoked by long-running browser/daemon paths.
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	ApplyNoWindow(cmd)
	return cmd
}

// Command returns an exec.Cmd configured with the project's default
// child-process policy.
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	ApplyNoWindow(cmd)
	return cmd
}
