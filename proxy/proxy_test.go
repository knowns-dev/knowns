package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// With GO_FAKE_KNOWNS=1 the test binary is a stand-in for `knowns mcp --stdio`: it answers
// initialize and tools/call with "child:<name>" and logs every line it receives to FAKE_LOG.
func TestMain(m *testing.M) {
	if os.Getenv("GO_FAKE_KNOWNS") == "1" {
		fakeChild()
		return
	}
	os.Exit(m.Run())
}

func fakeChild() {
	logf, _ := os.OpenFile(os.Getenv("FAKE_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	br := bufio.NewReader(os.Stdin)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			logf.Write(line)
			f, _ := topLevel(line, "id", "method", "params")
			if len(f["id"]) > 0 {
				res := `{"ok":true}`
				if unquote(f["method"]) == "tools/call" {
					g, _ := topLevel(f["params"], "name")
					res = `{"content":[{"type":"text","text":"child:` + unquote(g["name"]) + `"}]}`
				}
				os.Stdout.WriteString(`{"jsonrpc":"2.0","id":` + string(f["id"]) + `,"result":` + res + "}\n")
			}
		}
		if err != nil {
			return
		}
	}
}

type env struct {
	t       *testing.T
	root    string
	fakeLog string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	root, err := os.MkdirTemp("/tmp", "kp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	t.Setenv("KNOWNS_RUNTIME_ROOT", filepath.Join(root, "rt"))
	t.Setenv("GO_FAKE_KNOWNS", "1")
	exe, _ := os.Executable()
	t.Setenv("KNOWNS_PROXY_KNOWNS_BIN", exe)
	e := &env{t: t, root: root, fakeLog: filepath.Join(root, "child.log")}
	t.Setenv("FAKE_LOG", e.fakeLog)
	version = "9.9.9-test"
	return e
}

func (e *env) childLog() string { b, _ := os.ReadFile(e.fakeLog); return string(b) }

func (e *env) events() []map[string]any {
	data, _ := os.ReadFile(fallbackLogPath())
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		out = append(out, m)
	}
	return out
}

// fakeDaemon speaks the handshake contract on a unix socket and publishes the descriptor.
type fakeDaemon struct {
	ln    net.Listener
	token string
	mu    sync.Mutex
	hello []map[string]any
	// handler runs after a successful welcome; it owns the connection.
	handler func(c net.Conn, br *bufio.Reader)
	refuse  func(n int) (code string, retryMs int) // refuse the nth hello
	nHello  int
}

func (e *env) startDaemon(handler func(net.Conn, *bufio.Reader)) *fakeDaemon {
	if runtime.GOOS == "windows" {
		e.t.Skip("fake daemon speaks a unix socket")
	}
	os.MkdirAll(mcpDir(), 0o700)
	addr := filepath.Join(e.root, "d.sock")
	ln, err := net.Listen("unix", addr)
	if err != nil {
		e.t.Fatal(err)
	}
	d := &fakeDaemon{ln: ln, token: strings.Repeat("ab", 32), handler: handler}
	desc, _ := json.Marshal(map[string]any{"proxy_protocol": 1, "version": version, "kind": "unix_socket", "address": addr, "token": d.token, "pid": os.Getpid()})
	os.WriteFile(descriptorPath(), desc, 0o600)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go d.serve(c)
		}
	}()
	e.t.Cleanup(func() { ln.Close() })
	return d
}

func (d *fakeDaemon) serve(c net.Conn) {
	br := bufio.NewReader(c)
	line, err := br.ReadBytes('\n')
	if err != nil {
		c.Close()
		return
	}
	var h map[string]any
	json.Unmarshal(line, &h)
	d.mu.Lock()
	d.hello = append(d.hello, h)
	d.nHello++
	n := d.nHello
	d.mu.Unlock()
	if h["token"] != d.token {
		c.Write([]byte(`{"knowns_mcp":1,"type":"error","code":"unauthorized"}` + "\n"))
		c.Close()
		return
	}
	if d.refuse != nil {
		if code, ms := d.refuse(n); code != "" {
			msg := map[string]any{"knowns_mcp": 1, "type": "error", "code": code}
			if ms > 0 {
				msg["retry_after_ms"] = ms
			}
			b, _ := json.Marshal(msg)
			c.Write(append(b, '\n'))
			c.Close()
			return
		}
	}
	c.Write([]byte(`{"knowns_mcp":1,"type":"welcome","version":"` + version + `","session":"s-test","daemon_pid":1,"max_frame_bytes":16777216}` + "\n"))
	d.handler(c, br)
}

// echoHandler answers every request with "daemon:<name>".
func echoHandler(c net.Conn, br *bufio.Reader) {
	defer c.Close()
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			f, _ := topLevel(line, "id", "method", "params")
			if len(f["id"]) > 0 {
				res := `{"ok":true}`
				if unquote(f["method"]) == "tools/call" {
					g, _ := topLevel(f["params"], "name")
					res = `{"content":[{"type":"text","text":"daemon:` + unquote(g["name"]) + `"}]}`
				}
				c.Write([]byte(`{"jsonrpc":"2.0","id":` + string(f["id"]) + `,"result":` + res + "}\n"))
			}
		}
		if err != nil {
			return
		}
	}
}

type harness struct {
	in   *io.PipeWriter
	out  *bufio.Reader
	done chan int
}

func start(t *testing.T, project string) *harness {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	cwd, _ := os.Getwd()
	c := &config{stdin: inR, stdout: outW, stderr: io.Discard, cwd: cwd, project: project}
	h := &harness{in: inW, out: bufio.NewReader(outR), done: make(chan int, 1)}
	go func() { h.done <- newSession(c).run(); outW.Close() }()
	t.Cleanup(func() { inW.Close() })
	return h
}

func (h *harness) send(s string) { io.WriteString(h.in, s+"\n") }
func (h *harness) recv(t *testing.T) string {
	t.Helper()
	ch := make(chan string, 1)
	go func() { l, _ := h.out.ReadString('\n'); ch <- strings.TrimSpace(l) }()
	select {
	case l := <-ch:
		return l
	case <-time.After(20 * time.Second):
		t.Fatal("timed out waiting for the proxy")
		return ""
	}
}

const initReq = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"t","version":"1"}}}`

func call(id int, name, args string) string {
	return `{"jsonrpc":"2.0","id":` + itoa(id) + `,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}
func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestForwardsThroughDaemonAndSendsHello(t *testing.T) {
	e := newEnv(t)
	d := e.startDaemon(echoHandler)
	h := start(t, "/work/proj")
	h.send(initReq)
	if got := h.recv(t); !strings.Contains(got, `"id":1`) {
		t.Fatalf("initialize response: %s", got)
	}
	h.send(call(2, "tasks", `{"action":"list"}`))
	if got := h.recv(t); !strings.Contains(got, "daemon:tasks") {
		t.Fatalf("not served by the daemon: %s", got)
	}
	d.mu.Lock()
	hello := d.hello[0]
	d.mu.Unlock()
	if hello["version"] != "9.9.9-test" || hello["token"] != d.token || hello["project"] != "/work/proj" {
		t.Fatalf("bad hello: %v", hello)
	}
	if cwd, _ := hello["cwd"].(string); !filepath.IsAbs(cwd) {
		t.Fatalf("cwd must be absolute: %v", hello["cwd"])
	}
	if len(e.events()) != 0 {
		t.Fatalf("no fallback expected: %v", e.events())
	}
	h.in.Close()
	if code := <-h.done; code != 0 {
		t.Fatalf("exit %d", code)
	}
}

func TestStdinEOFClosesTheConnection(t *testing.T) {
	e := newEnv(t)
	closed := make(chan struct{})
	e.startDaemon(func(c net.Conn, br *bufio.Reader) {
		line, _ := br.ReadBytes('\n')
		_ = line
		c.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}` + "\n"))
		io.Copy(io.Discard, br)
		close(closed)
	})
	h := start(t, "")
	h.send(initReq)
	h.recv(t)
	h.in.Close()
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("the daemon never saw the connection close, so the lease would stay held")
	}
}

func TestNoDaemonFallsBackToChild(t *testing.T) {
	e := newEnv(t)
	t.Setenv("KNOWNS_PROXY_KNOWNS_BIN", "") // no daemon can be started: only the child path below
	exe, _ := os.Executable()
	// startDaemon runs the same binary with "__runtime run"; under GO_FAKE_KNOWNS it is a fake child
	// that exits when its stdin closes and never writes a descriptor, so the poll ends with no_daemon.
	t.Setenv("KNOWNS_PROXY_KNOWNS_BIN", exe)
	start := time.Now()
	h := start2(t)
	h.send(initReq)
	h.send(call(2, "tasks", `{"action":"list"}`))
	h.recv(t)
	if got := h.recv(t); !strings.Contains(got, "child:tasks") {
		t.Fatalf("not served by the child: %s", got)
	}
	if time.Since(start) > 30*time.Second {
		t.Fatal("startup took too long")
	}
	ev := e.events()
	if len(ev) != 1 || ev[0]["code"] != "no_daemon" || ev[0]["kind"] != "fallback" {
		t.Fatalf("fallback record: %v", ev)
	}
	for _, m := range ev {
		if _, has := m["token"]; has {
			t.Fatal("token in fallback record")
		}
	}
}

func start2(t *testing.T) *harness { return start(t, "") }

func TestKillSwitchGoesStraightToChild(t *testing.T) {
	e := newEnv(t)
	e.startDaemon(echoHandler)
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	cwd, _ := os.Getwd()
	c := &config{stdin: inR, stdout: outW, stderr: io.Discard, cwd: cwd, disableProxy: true}
	h := &harness{in: inW, out: bufio.NewReader(outR), done: make(chan int, 1)}
	go func() { h.done <- newSession(c).run(); outW.Close() }()
	h.send(call(1, "tasks", `{"action":"list"}`))
	if got := h.recv(t); !strings.Contains(got, "child:tasks") {
		t.Fatalf("expected the child: %s", got)
	}
	if len(e.events()) != 0 {
		t.Fatal("KNOWNS_MCP_PROXY=0 is not a fallback")
	}
	inW.Close()
}

func TestVersionMismatchIsFatalAndRecorded(t *testing.T) {
	e := newEnv(t)
	d := e.startDaemon(echoHandler)
	d.refuse = func(int) (string, int) { return "version_mismatch", 0 }
	h := start(t, "")
	h.send(call(1, "docs", `{"action":"get"}`))
	if got := h.recv(t); !strings.Contains(got, "child:docs") {
		t.Fatalf("expected the child: %s", got)
	}
	ev := e.events()
	if len(ev) != 1 || ev[0]["code"] != "version_mismatch" {
		t.Fatalf("record: %v", ev)
	}
	d.mu.Lock()
	n := d.nHello
	d.mu.Unlock()
	if n != 1 {
		t.Fatalf("a fatal error must not be retried, hellos=%d", n)
	}
}

func TestBusyIsRetriedThenSucceeds(t *testing.T) {
	e := newEnv(t)
	d := e.startDaemon(echoHandler)
	d.refuse = func(n int) (string, int) {
		if n < 3 {
			return "busy", 50
		}
		return "", 0
	}
	h := start(t, "")
	h.send(call(1, "tasks", `{"action":"list"}`))
	if got := h.recv(t); !strings.Contains(got, "daemon:tasks") {
		t.Fatalf("expected the daemon after retries: %s", got)
	}
	if len(e.events()) != 0 {
		t.Fatalf("events: %v", e.events())
	}
}

// The daemon dies with a read and a write in flight: the read is answered by the child, the write
// gets an error, and the write is never delivered to the child.
func TestMidSessionDropReplaysReadsAndNeverResendsWrites(t *testing.T) {
	e := newEnv(t)
	gate := make(chan struct{})
	e.startDaemon(func(c net.Conn, br *bufio.Reader) {
		// answer initialize and the project call, then hold everything else until the kill
		for {
			line, err := br.ReadBytes('\n')
			if err != nil {
				return
			}
			f, _ := topLevel(line, "id", "method", "params")
			if unquote(f["method"]) == "initialize" || strings.Contains(string(line), `"project"`) {
				c.Write([]byte(`{"jsonrpc":"2.0","id":` + string(f["id"]) + `,"result":{"ok":true}}` + "\n"))
				continue
			}
			if string(f["id"]) == "5" { // the third request that is held
				<-gate
				c.Close()
				return
			}
		}
	})
	h := start(t, "")
	h.send(initReq)
	h.recv(t)
	h.send(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	h.send(call(2, "project", `{"action":"set","projectRoot":"/work/p2"}`))
	h.recv(t)
	h.send(call(3, "tasks", `{"action":"list"}`))
	h.send(call(4, "tasks", `{"action":"update","taskId":"X-1","status":"done"}`))
	h.send(call(5, "tasks", `{"action":"get","taskId":"X-1"}`))
	time.Sleep(200 * time.Millisecond)
	close(gate)

	got := map[string]string{}
	for i := 0; i < 3; i++ {
		l := h.recv(t)
		var m struct {
			ID json.RawMessage `json:"id"`
		}
		json.Unmarshal([]byte(l), &m)
		got[string(m.ID)] = l
	}
	if !strings.Contains(got["3"], "child:tasks") || !strings.Contains(got["5"], "child:tasks") {
		t.Fatalf("reads must be answered by the child: %v", got)
	}
	if !strings.Contains(got["4"], `"error"`) {
		t.Fatalf("the in-flight write must get an error: %v", got)
	}
	log := e.childLog()
	if strings.Contains(log, `"update"`) {
		t.Fatalf("a write was sent twice (it reached the child): %s", log)
	}
	if !strings.Contains(log, "kn-replay-init") || !strings.Contains(log, `"initialized"`) && !strings.Contains(log, "notifications/initialized") {
		t.Fatalf("initialize and initialized were not replayed: %s", log)
	}
	if !strings.Contains(log, "kn-replay-project") || !strings.Contains(log, "/work/p2") {
		t.Fatalf("the project selection was not replayed: %s", log)
	}
	ev := e.events()
	if len(ev) == 0 || ev[0]["kind"] != "fallback" || ev[0]["code"] != "dropped" {
		t.Fatalf("record: %v", ev)
	}
	// the session keeps working
	h.send(call(6, "docs", `{"action":"list"}`))
	if l := h.recv(t); !strings.Contains(l, "child:docs") {
		t.Fatalf("session broken after the switch: %s", l)
	}
}

func TestClassify(t *testing.T) {
	cases := []struct {
		name, args string
		ro         bool
	}{
		{"tasks", `{"action":"list"}`, true},
		{"tasks", `{"action":"update"}`, false},
		{"tasks", `{"action":"create"}`, false},
		{"docs", `{"action":"get"}`, true},
		{"docs", `{"action":"update"}`, false},
		{"code", `{"action":"references"}`, true},
		{"code", `{"action":"rename"}`, false},
		{"search", `{"action":"search"}`, true},
		{"validate", `{"fix":true}`, false},
		{"validate", `{}`, true},
		{"time", `{"action":"start"}`, false},
		{"unknown_tool", `{}`, false},
	}
	for _, c := range cases {
		ro, _ := classify("tools/call", []byte(`{"name":"`+c.name+`","arguments":`+c.args+`}`))
		if ro != c.ro {
			t.Errorf("%s %s: readOnly=%v want %v", c.name, c.args, ro, c.ro)
		}
	}
	if ro, _ := classify("tools/list", nil); !ro {
		t.Error("tools/list is read-only")
	}
}

func TestTopLevelScanner(t *testing.T) {
	line := []byte(`{"jsonrpc":"2.0","params":{"id":99,"s":"a\"}b"},"id":"x y","method":"m"}`)
	f, ok := topLevel(line, "id", "method", "params")
	if !ok || string(f["id"]) != `"x y"` || string(f["method"]) != `"m"` || !strings.HasPrefix(string(f["params"]), `{"id":99`) {
		t.Fatalf("%v %q", ok, f)
	}
}

func TestIDsMatchByParsedValue(t *testing.T) {
	if idKey([]byte("1")) != idKey([]byte("1.0")) || idKey([]byte("1")) != idKey([]byte("1e0")) {
		t.Fatal("numeric ids must match by value")
	}
	if idKey([]byte("1")) == idKey([]byte(`"1"`)) {
		t.Fatal("a number never matches the string with the same digits")
	}
	if idKey([]byte(`"ab"`)) != idKey([]byte(`"ab"`)) {
		t.Fatal("string escapes must match by value")
	}
	// end to end: the daemon echoes 1 for a request sent with 1.0, and the call still clears
	e := newEnv(t)
	e.startDaemon(func(c net.Conn, br *bufio.Reader) {
		defer c.Close()
		for {
			if _, err := br.ReadBytes('\n'); err != nil {
				return
			}
			c.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{}}` + "\n"))
		}
	})
	h := start(t, "")
	h.send(`{"jsonrpc":"2.0","id":1.0,"method":"tools/list"}`)
	h.recv(t)
	h.in.Close()
	select {
	case <-h.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the in-flight call was never cleared, so the proxy waits out its 30 s drain")
	}
}
