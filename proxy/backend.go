package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

const maxFrame = 16 << 20

// backend is one place the agent's JSON-RPC goes: the daemon over a socket or pipe, or the
// in-process child. lines delivers complete lines (with the trailing newline) and is closed when
// the backend ends.
type backend struct {
	kind    string // "daemon" or "child"
	w       io.Writer
	lines   chan []byte
	closeFn func()
	session string

	mu  sync.Mutex
	bye string
}

func (b *backend) write(line []byte) error { _, err := b.w.Write(line); return err }
func (b *backend) close()                  { b.closeFn() }
func (b *backend) byeReason() string       { b.mu.Lock(); defer b.mu.Unlock(); return b.bye }

func isControl(line []byte) bool {
	head := line
	if len(head) > 64 {
		head = head[:64]
	}
	return bytes.Contains(head, []byte(`"knowns_mcp"`))
}

func readLoop(b *backend, br *bufio.Reader, wait func()) {
	defer close(b.lines)
	if wait != nil {
		defer wait()
	}
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] != '\n' {
				line = append(line, '\n')
			}
			if b.kind == "daemon" && isControl(line) {
				var c struct {
					Type   string `json:"type"`
					Reason string `json:"reason"`
				}
				if json.Unmarshal(line, &c) == nil && c.Type == "bye" {
					b.mu.Lock()
					b.bye = c.Reason
					b.mu.Unlock()
				}
			} else if len(bytes.TrimSpace(line)) > 0 {
				b.lines <- line
			}
		}
		if err != nil {
			return
		}
	}
}

// ---- the in-process child (D2, D8) ----

func findKnowns() string {
	if v := os.Getenv("KNOWNS_PROXY_KNOWNS_BIN"); v != "" {
		return v
	}
	name := "knowns"
	if isWindows {
		name = "knowns.exe"
	}
	if self, err := os.Executable(); err == nil {
		p := self[:len(self)-len(baseName(self))] + name
		if p != self {
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				return p
			}
		}
	}
	if p, err := exec.LookPath("knowns"); err == nil {
		return p
	}
	return ""
}

func baseName(p string) string {
	i := strings.LastIndexAny(p, `/\`)
	return p[i+1:]
}

func envWithout(key string, add ...string) []string {
	var out []string
	for _, e := range os.Environ() {
		if len(e) > len(key) && strings.EqualFold(e[:len(key)+1], key+"=") {
			continue
		}
		out = append(out, e)
	}
	return append(out, add...)
}

func startChild(c *config) (*backend, error) {
	bin := findKnowns()
	if bin == "" {
		return nil, errors.New("cannot find the knowns binary next to the proxy or on PATH")
	}
	args := []string{"mcp", "--stdio"}
	if c.project != "" {
		args = append(args, "--project", c.project)
	}
	cmd := exec.Command(bin, args...)
	cmd.Env = envWithout("KNOWNS_MCP_PROXY", "KNOWNS_MCP_PROXY=0")
	cmd.Dir = c.cwd
	cmd.SysProcAttr = childAttr()
	cmd.Stderr = c.stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	b := &backend{kind: "child", w: stdin, lines: make(chan []byte, 64)}
	var once sync.Once
	b.closeFn = func() {
		once.Do(func() {
			stdin.Close()
			t := time.AfterFunc(3*time.Second, func() { _ = cmd.Process.Kill() })
			go func() { _ = cmd.Wait(); t.Stop() }()
		})
	}
	go readLoop(b, bufio.NewReaderSize(stdout, 64<<10), nil)
	return b, nil
}

// ---- the daemon ----

type descriptor struct {
	ProxyProtocol int    `json:"proxy_protocol"`
	Version       string `json:"version"`
	Kind          string `json:"kind"`
	Address       string `json:"address"`
	Token         string `json:"token"`
	Pid           int    `json:"pid"`
}

func readDescriptor() *descriptor {
	data, err := os.ReadFile(descriptorPath())
	if err != nil {
		return nil
	}
	var d descriptor
	if json.Unmarshal(data, &d) != nil || d.Address == "" || d.Token == "" {
		return nil
	}
	return &d
}

func startDaemon() error {
	bin := findKnowns()
	if bin == "" {
		return errors.New("cannot find the knowns binary")
	}
	files, closeFiles := daemonFiles()
	defer closeFiles()
	p, err := os.StartProcess(bin, []string{bin, "__runtime", "run"}, &os.ProcAttr{
		Dir:   os.TempDir(),
		Env:   envWithout("KNOWNS_MCP_PROXY"),
		Files: files,
		Sys:   daemonAttr(),
	})
	if err != nil {
		return err
	}
	return p.Release()
}

type daemonError struct {
	code       string
	retryAfter time.Duration
}

func (e *daemonError) Error() string { return "daemon refused the session: " + e.code }

func (e *daemonError) retryable() bool { return e.retryAfter > 0 }

// handshake dials d and performs hello/welcome. It returns a daemonError for a typed refusal.
func handshake(c *config, d *descriptor) (*backend, error) {
	conn, err := dial(d.Kind, d.Address)
	if err != nil {
		return nil, &daemonError{code: "no_daemon"}
	}
	hello, _ := json.Marshal(map[string]any{
		"knowns_mcp": 1, "type": "hello", "version": version, "token": d.Token,
		"pid": os.Getpid(), "cwd": c.cwd, "project": c.project,
		"client": map[string]string{"name": "knowns-proxy", "version": version},
	})
	if _, err := conn.Write(append(hello, '\n')); err != nil {
		conn.Close()
		return nil, &daemonError{code: "no_daemon"}
	}
	br := bufio.NewReaderSize(conn, 64<<10)
	type res struct {
		line []byte
		err  error
	}
	ch := make(chan res, 1)
	go func() { l, e := br.ReadBytes('\n'); ch <- res{l, e} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(5 * time.Second):
		conn.Close()
		return nil, &daemonError{code: "hello_timeout", retryAfter: time.Millisecond}
	}
	if r.err != nil && len(r.line) == 0 {
		conn.Close()
		return nil, &daemonError{code: "no_daemon"}
	}
	var f struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Session string `json:"session"`
		Retry   int    `json:"retry_after_ms"`
	}
	if json.Unmarshal(r.line, &f) != nil {
		conn.Close()
		return nil, &daemonError{code: "bad_welcome"}
	}
	if f.Type == "welcome" {
		b := &backend{kind: "daemon", w: conn, lines: make(chan []byte, 64), session: f.Session}
		var once sync.Once
		b.closeFn = func() { once.Do(func() { conn.Close() }) }
		go readLoop(b, br, nil)
		return b, nil
	}
	conn.Close()
	return nil, &daemonError{code: f.Code, retryAfter: time.Duration(f.Retry) * time.Millisecond}
}

// dialDaemon finds or (when start is set) starts the daemon of this version and opens a session.
// On failure it returns the reason code for the fallback record.
func dialDaemon(c *config, start bool) (*backend, string) {
	deadline := time.Now().Add(5 * time.Second)
	started := false
	for attempt := 1; attempt <= 3; attempt++ {
		d := readDescriptor()
		var b *backend
		var err error
		if d != nil {
			b, err = handshake(c, d)
		}
		if b != nil {
			return b, ""
		}
		var de *daemonError
		if d == nil {
			de = &daemonError{code: "no_daemon"}
		} else {
			if !errors.As(err, &de) {
				de = &daemonError{code: "no_daemon"}
			}
		}
		if de.code == "no_daemon" {
			if !start || started {
				return nil, "no_daemon"
			}
			started = true
			if err := startDaemon(); err != nil {
				return nil, "no_daemon"
			}
			until := time.Now().Add(10 * time.Second)
			for time.Now().Before(until) {
				time.Sleep(100 * time.Millisecond)
				if d = readDescriptor(); d != nil {
					if b, err = handshake(c, d); b != nil {
						return b, ""
					}
					if !errors.As(err, &de) || de.code != "no_daemon" {
						break
					}
				}
			}
			if de == nil || de.code == "no_daemon" {
				return nil, "no_daemon"
			}
		}
		if !de.retryable() || attempt == 3 || time.Now().Add(de.retryAfter).After(deadline) {
			return nil, de.code
		}
		time.Sleep(de.retryAfter)
	}
	return nil, "no_daemon"
}

func retryableCode(code string) bool {
	switch code {
	case "no_daemon", "dropped", "busy", "shutting_down", "hello_timeout":
		return true
	}
	return strings.HasPrefix(code, "bye_")
}

var _ = strconv.Itoa
