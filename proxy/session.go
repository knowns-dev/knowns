package main

import (
	"bufio"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"
)

type config struct {
	stdin        io.Reader
	stdout       io.Writer
	stderr       io.Writer
	project      string
	cwd          string
	disableProxy bool
}

const (
	replayInitID    = `"kn-replay-init"`
	replayProjectID = `"kn-replay-project"`
	lostMessage     = "The shared Knowns engine connection was lost while this call was running, so it may or may not have been applied. Check the current state, then retry."
	closeFrame      = `{"knowns_mcp":1,"type":"close"}` + "\n"
)

type session struct {
	c  *config
	mu sync.Mutex

	cur       *backend
	candidate *backend // a daemon session ready to switch back to, waiting for a quiet moment
	inflight  map[string]*reqInfo
	order     []string

	initParams      []byte
	initializedSeen bool
	projectParams   []byte

	eof        bool
	finished   bool
	done       chan struct{}
	exitCode   int
	quickDeath int  // consecutive children that died within 2 s of starting
	retrying   bool // a retryLoop is running (single flight)
	lastCode   string
}

func newSession(c *config) *session {
	return &session{c: c, inflight: map[string]*reqInfo{}, done: make(chan struct{})}
}

func (s *session) note(msg string) {
	io.WriteString(s.c.stderr, "knowns-proxy: "+msg+"\n")
}

// run serves one agent session and returns the process exit code.
func (s *session) run() int {
	if !s.c.disableProxy {
		if b, code := dialDaemon(s.c, true); b != nil {
			s.cur = b
			go s.pump(b)
		} else {
			s.lastCode = code
			recordEvent("fallback", code, "daemon not reachable at startup", "")
			s.note("shared engine unavailable (" + code + "), running in-process")
		}
	}
	if s.cur == nil {
		b, err := startChild(s.c)
		if err != nil {
			s.note("cannot start the in-process server: " + err.Error())
			return 1
		}
		s.cur = b
		go s.pump(b)
	}
	s.mu.Lock()
	if !s.c.disableProxy && s.cur.kind == "child" && retryableCode(s.lastCode) {
		s.startRetryLocked()
	}
	s.mu.Unlock()
	go s.readStdin()
	<-s.done
	s.mu.Lock()
	cur, cand := s.cur, s.candidate
	if cur != nil {
		cur.close()
	}
	if cand != nil {
		cand.close()
	}
	s.mu.Unlock()
	// Give a child time to leave on its own (stdin is closed) before the process exits, so the
	// 3 s kill timer is not defeated by os.Exit.
	if cur != nil && cur.exited != nil {
		select {
		case <-cur.exited:
		case <-time.After(4 * time.Second):
		}
	}
	return s.exitCode
}

func (s *session) readStdin() {
	br := bufio.NewReaderSize(s.c.stdin, 64<<10)
	for {
		line, err := readLine(br)
		if err == errFrameTooLarge {
			s.note("a request larger than 16 MiB was refused; ending the session")
			s.mu.Lock()
			s.finishLocked(1)
			s.mu.Unlock()
			return
		}
		// A last line the agent never terminated is dropped, as `knowns mcp --stdio` drops it at EOF.
		if len(line) > 0 && line[len(line)-1] == '\n' {
			s.handleIn(line)
		}
		if err != nil {
			break
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eof = true
	// A clean end towards the daemon is a close frame, never a half-close: Bun closes the whole
	// socket when the peer shuts down its write side, which the daemon reads as an abrupt end. The
	// daemon finishes what it already received, answers, then closes; wait for that (30 s at most).
	if s.cur != nil && s.cur.kind == "daemon" {
		if s.cur.write([]byte(closeFrame)) == nil {
			time.AfterFunc(30*time.Second, func() { s.mu.Lock(); s.finishLocked(0); s.mu.Unlock() })
			return
		}
	}
	if len(s.inflight) == 0 {
		s.finishLocked(0)
		return
	}
	time.AfterFunc(30*time.Second, func() { s.mu.Lock(); s.finishLocked(0); s.mu.Unlock() })
}

func (s *session) finishLocked(code int) {
	if s.finished {
		return
	}
	s.finished = true
	s.exitCode = code
	close(s.done)
}

func (s *session) handleIn(line []byte) {
	trimmed := strings.TrimSpace(string(line))
	if trimmed == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished {
		return
	}
	if trimmed[0] == '[' {
		// MCP has no batches, so the engine decides what to answer, and the proxy keeps the answer
		// identical to the in-process one. The ids inside cannot be tracked: a batch lost with the
		// connection is not replayed and not reported.
		if s.cur != nil {
			if err := s.cur.write(line); err != nil {
				s.dropLocked(s.cur, "dropped", "write to "+s.cur.kind+" failed")
			}
		}
		return
	}
	f, _, dup := scanObject(line, "id", "method", "params")
	method := unquote(f["method"])
	if m := f["method"]; len(m) == 0 || m[0] != '"' {
		method = "" // not a JSON string: the engine answers it itself, there is nothing to track
	}
	id := idKey(f["id"])
	s.maybeSwitchBack()
	switch method {
	case "initialize":
		if id != "" {
			s.initParams = append([]byte(nil), f["params"]...)
		}
	case "notifications/initialized":
		s.initializedSeen = true
	}
	if id != "" && method != "" {
		ro, isProj := classify(method, f["params"], dup)
		if _, dup := s.inflight[id]; dup {
			s.removeOrder(id) // a reused id is one pending call: the newer request replaces the older
		}
		s.inflight[id] = &reqInfo{rawID: string(f["id"]), line: line, method: method, params: append([]byte(nil), f["params"]...), readOnly: ro, isProject: isProj}
		s.order = append(s.order, id)
	}
	if s.cur == nil {
		return
	}
	if err := s.cur.write(line); err != nil {
		s.dropLocked(s.cur, "dropped", "write to "+s.cur.kind+" failed")
	}
}

func (s *session) emit(line []byte) {
	_, _ = s.c.stdout.Write(line)
}

func (s *session) errorResponse(idRaw string) []byte {
	return []byte(`{"jsonrpc":"2.0","id":` + idRaw + `,"error":{"code":-32603,"message":` + strconv.Quote(lostMessage) + `}}` + "\n")
}

// pump delivers a backend's output to the agent until it ends.
func (s *session) pump(b *backend) {
	for line := range b.lines {
		s.mu.Lock()
		if s.cur != b {
			s.mu.Unlock()
			go func() {
				for range b.lines { // let readLoop finish instead of blocking on a full channel
				}
			}()
			return
		}
		s.handleOut(line)
		s.mu.Unlock()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != b || s.finished {
		return
	}
	if s.eof && len(s.inflight) == 0 {
		s.finishLocked(0)
		return
	}
	code, reason := "dropped", b.kind+" connection ended"
	if r := b.byeReason(); r != "" {
		code, reason = "bye_"+r, "daemon said bye: "+r
	}
	s.dropLocked(b, code, reason)
}

func (s *session) handleOut(line []byte) {
	f, ok := topLevel(line, "id", "method", "result", "error")
	if ok && len(f["id"]) > 0 && len(f["method"]) == 0 {
		key := idKey(f["id"])
		if info, found := s.inflight[key]; found {
			delete(s.inflight, key)
			s.removeOrder(key)
			if info.isProject && len(f["error"]) == 0 && !strings.Contains(string(f["result"]), `"isError":true`) {
				s.projectParams = info.params
			}
		}
	}
	s.emit(line)
	if len(s.inflight) == 0 {
		if s.eof {
			if s.cur == nil || s.cur.kind != "daemon" {
				s.finishLocked(0)
			}
			return
		}
		s.maybeSwitchBack()
	}
}

func (s *session) removeOrder(key string) {
	for i, k := range s.order {
		if k == key {
			s.order = append(s.order[:i:i], s.order[i+1:]...)
			return
		}
	}
}

// answerLost errors every in-flight call and forgets it.
func (s *session) answerLost() {
	for _, key := range s.order {
		if info := s.inflight[key]; info != nil {
			s.emit(s.errorResponse(info.rawID))
		}
	}
	s.inflight = map[string]*reqInfo{}
	s.order = nil
}

// dropLocked handles the loss of backend b: record it, move to the in-process child, replay the
// session and settle what was in flight (reads are resent, anything that may write is answered
// with an error and never sent twice).
func (s *session) dropLocked(b *backend, code, reason string) {
	if s.cur != b {
		return
	}
	s.cur = nil
	b.close()
	// Answers the backend had already delivered are not lost with it.
	deadline := time.After(300 * time.Millisecond)
drain:
	for {
		select {
		case line, ok := <-b.lines:
			if !ok {
				break drain
			}
			s.handleOut(line)
		case <-deadline:
			go func() {
				for range b.lines {
				}
			}()
			break drain
		}
	}
	s.lastCode = code
	if b.kind == "daemon" {
		recordEvent("fallback", code, reason, b.session)
		s.note("lost the shared engine (" + code + "), continuing in-process")
	}
	if s.finished {
		return
	}
	if s.eof {
		// The agent is gone: only reads are worth resending, and a child is not worth starting for
		// writes that can only be answered with an error.
		anyRead := false
		for _, info := range s.inflight {
			anyRead = anyRead || info.readOnly
		}
		if !anyRead {
			s.answerLost()
			s.finishLocked(0)
			return
		}
	}
	if b.kind == "child" {
		if time.Since(b.started) < 2*time.Second {
			s.quickDeath++
		} else {
			s.quickDeath = 0
		}
	}
	for fails := 0; s.cur == nil && fails < 3 && s.quickDeath < 3; {
		nb, err := startChild(s.c)
		if err != nil {
			fails++
			continue
		}
		if s.replay(nb) {
			s.cur = nb
			go s.pump(nb)
			break
		}
		nb.close()
		fails++
	}
	if s.cur == nil {
		s.answerLost()
		s.note("no server left to talk to")
		s.finishLocked(1)
		return
	}
	if !s.c.disableProxy && s.cur.kind == "child" {
		s.startRetryLocked()
	}
}

// replay prepares a fresh backend: initialize, initialized and the last successful project
// selection, then resends the in-flight reads and answers the in-flight writes with an error.
func (s *session) replay(b *backend) bool {
	hasInitInflight := false
	for _, info := range s.inflight {
		if info.method == "initialize" {
			hasInitInflight = true
		}
	}
	if len(s.initParams) > 0 && !hasInitInflight {
		if !s.call(b, replayInitID, "initialize", s.initParams) {
			return false
		}
		if s.initializedSeen {
			if b.write([]byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`+"\n")) != nil {
				return false
			}
		}
		if s.projectParams != nil && !s.call(b, replayProjectID, "tools/call", s.projectParams) {
			return false
		}
	}
	// Resend reads first; only when the whole batch went out are writes answered and forgotten.
	var resent []string
	for _, key := range s.order {
		info := s.inflight[key]
		if info != nil && info.readOnly {
			if b.write(info.line) != nil {
				return false
			}
			resent = append(resent, key)
		}
	}
	for _, key := range s.order {
		if info := s.inflight[key]; info != nil && !info.readOnly {
			s.emit(s.errorResponse(info.rawID))
			delete(s.inflight, key)
		}
	}
	s.order = resent
	return true
}

// call sends a replay request and waits for its response (replay responses never reach the agent).
func (s *session) call(b *backend, id, method string, params []byte) bool {
	msg := `{"jsonrpc":"2.0","id":` + id + `,"method":"` + method + `","params":` + string(params) + "}\n"
	if b.write([]byte(msg)) != nil {
		return false
	}
	timeout := time.After(30 * time.Second)
	want := idKey([]byte(id))
	for {
		select {
		case line, ok := <-b.lines:
			if !ok {
				return false
			}
			f, _ := topLevel(line, "id", "method", "error")
			if idKey(f["id"]) == want && len(f["method"]) == 0 {
				return len(f["error"]) == 0
			}
		case <-timeout:
			return false
		}
	}
}

// maybeSwitchBack moves the session from the child back to a waiting daemon session, only while
// nothing is in flight.
func (s *session) maybeSwitchBack() {
	if s.candidate == nil || s.cur == nil || s.cur.kind != "child" || len(s.inflight) > 0 || s.finished {
		return
	}
	cand := s.candidate
	s.candidate = nil
	select {
	case _, ok := <-cand.lines:
		if !ok {
			return
		}
	default:
	}
	if !s.replay(cand) {
		cand.close()
		return
	}
	old := s.cur
	s.cur = cand
	old.close()
	go s.pump(cand)
	recordEvent("recovered", "", "session moved back to the daemon", cand.session)
}

// startRetryLocked starts the daemon retry loop unless one is already running.
func (s *session) startRetryLocked() {
	if s.retrying {
		return
	}
	s.retrying = true
	go s.retryLoop()
}

// retryLoop looks for the daemon again at a growing interval while the session runs in-process.
func (s *session) retryLoop() {
	defer func() { s.mu.Lock(); s.retrying = false; s.mu.Unlock() }()
	delays := []time.Duration{10 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	for i := 0; ; i++ {
		d := delays[len(delays)-1]
		if i < len(delays) {
			d = delays[i]
		}
		select {
		case <-s.done:
			return
		case <-time.After(d):
		}
		s.mu.Lock()
		stop := s.finished || s.cur == nil || s.cur.kind != "child" || s.candidate != nil
		s.mu.Unlock()
		if stop {
			return
		}
		b, code := dialDaemon(s.c, true)
		if b == nil {
			if !retryableCode(code) {
				return
			}
			continue
		}
		s.mu.Lock()
		if s.finished || s.cur == nil || s.cur.kind != "child" || s.candidate != nil {
			s.mu.Unlock()
			b.close()
			return
		}
		s.candidate = b
		s.maybeSwitchBack()
		s.mu.Unlock()
		return
	}
}
