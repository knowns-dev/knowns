//go:build !windows

package storage

import (
	"context"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func lockTaskLifecycleFile(ctx context.Context, file *os.File) error {
	for {
		err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			return err
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func unlockTaskLifecycleFile(file *os.File) error {
	return unix.Flock(int(file.Fd()), unix.LOCK_UN)
}
