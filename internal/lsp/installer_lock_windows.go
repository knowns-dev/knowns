//go:build windows

package lsp

import (
	"context"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func lockFileContext(ctx context.Context, file *os.File) (bool, error) {
	waited := false
	for {
		var overlapped windows.Overlapped
		err := windows.LockFileEx(
			windows.Handle(file.Fd()),
			windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
			0,
			1,
			0,
			&overlapped,
		)
		if err == nil {
			return waited, nil
		}
		if !errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
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
	var overlapped windows.Overlapped
	return windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped)
}
