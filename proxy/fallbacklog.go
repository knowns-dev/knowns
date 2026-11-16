package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const (
	fallbackTrimAt   = 64 << 10
	fallbackKeepRows = 50
)

// recordEvent appends one line to <runtime root>/mcp/proxy-fallback.jsonl, which `knowns doctor`
// reads. kind is "fallback" (the session moved to the in-process child) or "recovered". The line
// never carries the descriptor token. Best effort: a failure to write is never fatal.
func recordEvent(kind, code, reason, session string) {
	line, err := json.Marshal(map[string]any{
		"at": time.Now().UTC().Format(time.RFC3339), "pid": os.Getpid(), "version": version,
		"kind": kind, "code": code, "reason": reason, "session": session,
	})
	if err != nil {
		return
	}
	dir := mcpDir()
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	path := fallbackLogPath()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.Write(append(line, '\n'))
	st, serr := f.Stat()
	f.Close()
	if serr == nil && st.Size() > fallbackTrimAt {
		trimEvents(path)
	}
}

// trimEvents keeps the last rows. Trimmers take a lock file (created exclusively, stale after 10 s)
// and write through a temp file of their own, so two proxies never share a temp path. A row appended
// between the read and the rename can be lost; the log is advisory, so that is accepted.
func trimEvents(path string) {
	lock := path + ".lock"
	lf, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if st, serr := os.Stat(lock); serr == nil && time.Since(st.ModTime()) > 10*time.Second {
			_ = os.Remove(lock)
		}
		return
	}
	lf.Close()
	defer os.Remove(lock)
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	rows := bytes.Split(bytes.TrimRight(data, "\n"), []byte("\n"))
	if len(rows) > fallbackKeepRows {
		rows = rows[len(rows)-fallbackKeepRows:]
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "proxy-fallback-*.tmp")
	if err != nil {
		return
	}
	_, werr := tmp.Write(append(bytes.Join(rows, []byte("\n")), '\n'))
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), path) != nil {
		os.Remove(tmp.Name())
	}
}
