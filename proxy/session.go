package main

import (
	"bufio"
	"io"
	"os"
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

	eof       bool
	finished  bool
	done      chan struct{}
	exitCode  int
	childUsed int
	lastCode  string
}

func newSession(c *config) *session {
	return &session{c: c, inflight: map[string]*reqInfo{}, done: make(chan struct{})}
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
		}
	}
	if s.cur == nil {
		b, err := startChild(s.c)
		if err != nil {
			io.WriteString(s.c.stderr, "knowns-proxy: cannot start the in-process server: "+err.Error()+"\n")
			return 1
		}
		s.cur = b
		s.childUsed++
		go s.pump(b)
	}
	if !s.c.disableProxy && s.cur.kind == "child" && retryableCode(s.lastCode) {
		go s.retryLoop()
	}
	go s.readStdin()
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur != nil {
		s.cur.close()
	}
	if s.candidate != nil {
		s.candidate.close()
	}
	return s.exitCode
}

func (s *session) readStdin() {
	br := bufio.NewReaderSize(s.c.stdin, 64<<10)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			if line[len(line)-1] != '\n' {
				line = append(line, '\n')
			}
			s.handleIn(line)
		}
		if err != nil {
			break
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eof = true
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
	if len(strings.TrimSpace(string(line))) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.finished {
		return
	}
	f, _ := topLevel(line, "id", "method", "params")
	method := unquote(f["method"])
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
		ro, isProj := classify(method, f["params"])
		s.inflight[id] = &reqInfo{rawID: string(f["id"]), line: line, method: method, params: append([]byte(nil), f["params"]...), readOnly: ro, isProject: isProj}
		s.order = append(s.order, id)
	}
	if s.cur == nil {
		return // a switch is impossible; the request stays in flight and gets an error below
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
			s.finishLocked(0)
			return
		}
		s.maybeSwitchBack()
	}
}

func (s *session) removeOrder(key string) {
	for i, k := range s.order {
		if k == key {
			s.order = append(s.order[:i], s.order[i+1:]...)
			return
		}
	}
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
	s.lastCode = code
	if b.kind == "daemon" {
		recordEvent("fallback", code, reason, b.session)
	}
	for attempt := 0; attempt < 3 && s.cur == nil; attempt++ {
		if s.childUsed >= 4 {
			break
		}
		nb, err := startChild(s.c)
		if err != nil {
			break
		}
		s.childUsed++
		if s.replay(nb) {
			s.cur = nb
			go s.pump(nb)
			break
		}
		nb.close()
	}
	if s.cur == nil {
		for _, key := range s.order {
			s.emit(s.errorResponse(s.inflight[key].rawID))
		}
		s.inflight = map[string]*reqInfo{}
		s.order = nil
		io.WriteString(s.c.stderr, "knowns-proxy: no server left to talk to\n")
		s.finishLocked(1)
		return
	}
	if !s.c.disableProxy && s.cur.kind == "child" {
		go s.retryLoop()
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
	keep := s.order[:0]
	for _, key := range s.order {
		info := s.inflight[key]
		if info == nil {
			continue
		}
		if info.readOnly {
			if b.write(info.line) != nil {
				return false
			}
			keep = append(keep, key)
		} else {
			s.emit(s.errorResponse(s.inflight[key].rawID))
			delete(s.inflight, key)
		}
	}
	s.order = keep
	return true
}

// call sends a replay request and waits for its response (replay responses never reach the agent).
func (s *session) call(b *backend, id, method string, params []byte) bool {
	msg := `{"jsonrpc":"2.0","id":` + id + `,"method":"` + method + `","params":` + string(params) + "}\n"
	if b.write([]byte(msg)) != nil {
		return false
	}
	timeout := time.After(30 * time.Second)
	for {
		select {
		case line, ok := <-b.lines:
			if !ok {
				return false
			}
			f, _ := topLevel(line, "id", "method", "error")
			if idKey(f["id"]) == idKey([]byte(id)) && len(f["method"]) == 0 {
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

// retryLoop looks for the daemon again at a growing interval while the session runs in-process.
func (s *session) retryLoop() {
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
		if s.finished || s.cur == nil || s.cur.kind != "child" {
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

var _ = os.Getpid
