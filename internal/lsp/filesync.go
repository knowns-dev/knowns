package lsp

import (
	"sync"
	"time"
)

const defaultFileSyncTTL = 30 * time.Second

type FileSync struct {
	mu    sync.Mutex
	files map[string]*fileEntry
	open  func(string) error
	close func(string) error
	ttl   time.Duration
}

type fileEntry struct {
	refs       int
	lastAccess time.Time
	timer      *time.Timer
}

func NewFileSync(open func(string) error, close func(string) error) *FileSync {
	return &FileSync{files: make(map[string]*fileEntry), open: open, close: close, ttl: defaultFileSyncTTL}
}

func (f *FileSync) SetTTL(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ttl = d
}

func (f *FileSync) Open(path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	now := time.Now()
	if entry := f.files[path]; entry != nil {
		entry.lastAccess = now
		entry.refs++
		if entry.timer != nil {
			entry.timer.Stop()
			entry.timer = nil
		}
		return nil
	}

	if f.open != nil {
		if err := f.open(path); err != nil {
			return err
		}
	}
	f.files[path] = &fileEntry{refs: 1, lastAccess: now}
	return nil
}

func (f *FileSync) Close(path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry := f.files[path]
	if entry == nil || entry.refs == 0 {
		return nil
	}
	entry.refs--
	entry.lastAccess = time.Now()
	if entry.refs > 0 {
		return nil
	}
	f.scheduleCloseLocked(path, entry)
	return nil
}

func (f *FileSync) CloseAll() error {
	f.mu.Lock()
	var paths []string
	for path, entry := range f.files {
		if entry.timer != nil {
			entry.timer.Stop()
			entry.timer = nil
		}
		paths = append(paths, path)
	}
	f.files = make(map[string]*fileEntry)
	closeFn := f.close
	f.mu.Unlock()

	if closeFn == nil {
		return nil
	}
	for _, path := range paths {
		if err := closeFn(path); err != nil {
			return err
		}
	}
	return nil
}

// Reset forgets synchronized documents without notifying a server that has
// already failed. The next healthy server session will send fresh didOpen
// notifications for subsequent file operations.
func (f *FileSync) Reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, entry := range f.files {
		if entry.timer != nil {
			entry.timer.Stop()
		}
	}
	f.files = make(map[string]*fileEntry)
}

func (f *FileSync) RefCount(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	if entry := f.files[path]; entry != nil {
		return entry.refs
	}
	return 0
}

func (f *FileSync) scheduleCloseLocked(path string, entry *fileEntry) {
	if entry.timer != nil {
		entry.timer.Stop()
	}
	ttl := f.ttl
	if ttl <= 0 {
		go f.closeIfIdle(path, entry.lastAccess)
		return
	}
	lastAccess := entry.lastAccess
	entry.timer = time.AfterFunc(ttl, func() {
		f.closeIfIdle(path, lastAccess)
	})
}

func (f *FileSync) closeIfIdle(path string, lastAccess time.Time) {
	f.mu.Lock()
	entry := f.files[path]
	if entry == nil || entry.refs != 0 || !entry.lastAccess.Equal(lastAccess) {
		f.mu.Unlock()
		return
	}
	delete(f.files, path)
	closeFn := f.close
	f.mu.Unlock()

	if closeFn != nil {
		_ = closeFn(path)
	}
}
