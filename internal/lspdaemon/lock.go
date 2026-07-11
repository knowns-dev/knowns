package lspdaemon

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const (
	defaultLockTimeout  = 3 * time.Second
	defaultLockStaleAge = 10 * time.Second
	defaultLockPoll     = 50 * time.Millisecond
)

// LockOptions controls package-local daemon lock acquisition.
type LockOptions struct {
	Timeout      time.Duration
	StaleAge     time.Duration
	PollInterval time.Duration
}

// Lock is a held daemon lock.
type Lock struct {
	path string
	once sync.Once
}

// AcquireProjectLock acquires the project-scoped daemon lock.
func AcquireProjectLock(paths Paths, opts LockOptions) (*Lock, error) {
	return AcquireLock(paths.LockPath, opts)
}

// AcquireLock creates an exclusive lock file and removes stale locks following
// runtimequeue's bounded stale-file behavior.
func AcquireLock(path string, opts LockOptions) (*Lock, error) {
	opts = normalizeLockOptions(opts)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(opts.Timeout)
	for {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			if _, err := file.WriteString(strconv.Itoa(os.Getpid())); err != nil {
				_ = file.Close()
				_ = os.Remove(path)
				return nil, err
			}
			if err := file.Close(); err != nil {
				_ = os.Remove(path)
				return nil, err
			}
			_ = os.Chmod(path, 0o600)
			return &Lock{path: path}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > opts.StaleAge {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out waiting for lock %s", path)
		}
		time.Sleep(opts.PollInterval)
	}
}

// Release removes the held lock file.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	var err error
	l.once.Do(func() {
		err = os.Remove(l.path)
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
	})
	return err
}

func normalizeLockOptions(opts LockOptions) LockOptions {
	if opts.Timeout <= 0 {
		opts.Timeout = defaultLockTimeout
	}
	if opts.StaleAge <= 0 {
		opts.StaleAge = defaultLockStaleAge
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = defaultLockPoll
	}
	return opts
}
