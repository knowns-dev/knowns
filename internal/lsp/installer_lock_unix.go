//go:build !windows

package lsp

import (
	"context"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func lockFileContext(ctx context.Context, file *os.File) (bool, error) {
	waited := false
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return waited, nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return waited, err
		}
		waited = true
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return waited, ctx.Err()
		case <-timer.C:
		}
	}
}

func unlockFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
