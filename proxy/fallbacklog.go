package main

import (
	"bytes"
	"encoding/json"
	"os"
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

func trimEvents(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	rows := bytes.Split(bytes.TrimRight(data, "\n"), []byte("\n"))
	if len(rows) > fallbackKeepRows {
		rows = rows[len(rows)-fallbackKeepRows:]
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, append(bytes.Join(rows, []byte("\n")), '\n'), 0o600) != nil {
		return
	}
	_ = os.Rename(tmp, path)
}
