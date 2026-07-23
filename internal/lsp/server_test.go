package lsp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestServerStartTimeoutKillsUninitializedProcess(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "hang" {
		time.Sleep(time.Hour)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	srv := NewServer(t.TempDir(), ServerCommand{
		Language: "test",
		Name:     "hang-helper",
		Path:     os.Args[0],
		Args:     []string{"-test.run=TestServerStartTimeoutKillsUninitializedProcess"},
	})

	t.Setenv("KNOWNS_LSP_HELPER", "hang")

	started := time.Now()
	err := srv.Start(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Start() error = %v, want context deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Start() took %v, want timeout to interrupt initialize promptly", elapsed)
	}
	if srv.Alive() {
		t.Fatalf("server is still alive after startup timeout")
	}
}

func TestServerConcurrentQueryWaitsForStartupTransaction(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "concurrent-startup-hang" {
		if marker := os.Getenv("KNOWNS_LSP_HELPER_MARKER"); marker != "" {
			_ = os.WriteFile(marker, []byte("started"), 0o600)
		}
		time.Sleep(time.Hour)
		return
	}

	marker := filepath.Join(t.TempDir(), "helper-started")
	t.Setenv("KNOWNS_LSP_HELPER", "concurrent-startup-hang")
	t.Setenv("KNOWNS_LSP_HELPER_MARKER", marker)
	srv := NewServer(t.TempDir(), ServerCommand{
		Language: "go",
		Name:     "concurrent-startup-helper",
		Path:     os.Args[0],
		Args:     []string{"-test.run=TestServerConcurrentQueryWaitsForStartupTransaction"},
	})

	startCtx, cancelStart := context.WithCancel(context.Background())
	startErr := make(chan error, 1)
	go func() { startErr <- srv.Start(startCtx) }()

	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancelStart()
			t.Fatal("first Start did not enter initialization")
		}
		time.Sleep(time.Millisecond)
	}

	queryCtx, cancelQuery := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelQuery()
	queryErr := make(chan error, 1)
	go func() {
		_, err := srv.Definition(queryCtx, filepath.Join(srv.Root, "main.go"), 0, 0)
		queryErr <- err
	}()

	<-queryCtx.Done()
	cancelStart()
	if err := <-startErr; !errors.Is(err, context.Canceled) {
		t.Fatalf("first Start error = %v, want context canceled", err)
	}
	select {
	case err := <-queryErr:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("concurrent query error = %v, want its startup context deadline", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("concurrent query did not resume after startup transaction completed")
	}
}

func TestServerTerminalProtocolFailuresClearCapabilityState(t *testing.T) {
	validWrongResult := `{"jsonrpc":"2.0","id":1,"result":"not-an-integer"}`
	tests := []struct {
		name   string
		stream string
		result any
	}{
		{name: "read EOF", stream: ""},
		{name: "malformed envelope", stream: "Content-Length: 1\r\n\r\nx"},
		{name: "invalid result", stream: fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(validWrongResult), validWrongResult), result: new(int)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := NewServer(t.TempDir(), ServerCommand{Language: "go", Name: "broken-ls"})
			srv.mu.Lock()
			srv.running = true
			srv.initialized = true
			srv.capabilitiesKnown = true
			srv.advertisedCapabilities = []string{CapabilityDefinition}
			srv.reader = bufio.NewReader(strings.NewReader(tt.stream))
			err := srv.readResponseLocked(context.Background(), 1, tt.result)
			running, initialized := srv.running, srv.initialized
			snapshot := newCapabilitySnapshot(srv.capabilitiesKnown, srv.advertisedCapabilities, nil)
			srv.mu.Unlock()

			if err == nil {
				t.Fatal("readResponseLocked() error = nil")
			}
			if running || initialized || snapshot.Known || len(snapshot.Capabilities) != 0 {
				t.Fatalf("terminal protocol failure left stale state: running=%v initialized=%v snapshot=%#v", running, initialized, snapshot)
			}
		})
	}
}

type discardWriteCloser struct{}

func (discardWriteCloser) Write(p []byte) (int, error) { return len(p), nil }
func (discardWriteCloser) Close() error                { return nil }

type recordingLSPWriteCloser struct{ bytes.Buffer }

func (r *recordingLSPWriteCloser) Close() error { return nil }

func TestServerInitializeMergesAdapterParams(t *testing.T) {
	response := `{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}`
	reader := bufio.NewReader(strings.NewReader(fmt.Sprintf("Content-Length: %d\r\n\r\n%s", len(response), response)))
	writer := &recordingLSPWriteCloser{}
	srv := NewServer(t.TempDir(), ServerCommand{Language: "bash"})
	srv.setInitializeParams(map[string]any{
		"rootPath":              `C:\workspace\project`,
		"initializationOptions": map[string]any{"shellcheckPath": "shellcheck"},
		"processId":             -1,
		"capabilities":          map[string]any{"overridden": true},
	})
	srv.mu.Lock()
	srv.running = true
	srv.stdin = writer
	srv.reader = reader
	srv.mu.Unlock()

	if err := srv.initialize(context.Background()); err != nil {
		t.Fatal(err)
	}

	message, err := testReadMessage(bufio.NewReader(bytes.NewReader(writer.Bytes())))
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Method string `json:"method"`
		Params struct {
			ProcessID             int            `json:"processId"`
			RootURI               string         `json:"rootUri"`
			RootPath              string         `json:"rootPath"`
			InitializationOptions map[string]any `json:"initializationOptions"`
			Capabilities          struct {
				Window struct {
					WorkDoneProgress bool `json:"workDoneProgress"`
				} `json:"window"`
			} `json:"capabilities"`
		} `json:"params"`
	}
	if err := json.Unmarshal(message, &request); err != nil {
		t.Fatal(err)
	}
	if request.Method != "initialize" {
		t.Fatalf("method = %q, want initialize", request.Method)
	}
	if request.Params.RootPath != `C:\workspace\project` || request.Params.RootURI != "" {
		t.Fatalf("roots = rootPath %q, rootUri %q", request.Params.RootPath, request.Params.RootURI)
	}
	if request.Params.ProcessID != os.Getpid() {
		t.Fatalf("processId = %d, want %d", request.Params.ProcessID, os.Getpid())
	}
	if !request.Params.Capabilities.Window.WorkDoneProgress {
		t.Fatal("client capabilities were overwritten by adapter params")
	}
	if request.Params.InitializationOptions["shellcheckPath"] != "shellcheck" {
		t.Fatalf("initializationOptions = %#v", request.Params.InitializationOptions)
	}
}

type testDocumentSyncAdapterFunc func(string) DocumentSyncOptions

func (f testDocumentSyncAdapterFunc) DocumentSyncForPath(path string) DocumentSyncOptions {
	return f(path)
}

type testPathCapabilityAdapterFunc func(string, string, string) (PathCapabilityDecision, bool)

func (f testPathCapabilityAdapterFunc) PathCapabilityForAction(path, action, capability string) (PathCapabilityDecision, bool) {
	return f(path, action, capability)
}

func TestServerPathDocumentSyncLanguageIDsAndSuppression(t *testing.T) {
	dir := t.TempDir()
	paths := map[string]string{
		"main.tf":                "terraform",
		"production.tfvars":      "terraform-vars",
		"network.tf.json":        "",
		"production.tfvars.json": "",
	}
	for name := range paths {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	adapter := testDocumentSyncAdapterFunc(func(path string) DocumentSyncOptions {
		switch {
		case strings.HasSuffix(path, ".tfvars.json"):
			return DocumentSyncOptions{LanguageID: "terraform-vars", Suppress: true}
		case strings.HasSuffix(path, ".tf.json"):
			return DocumentSyncOptions{LanguageID: "terraform", Suppress: true}
		case strings.HasSuffix(path, ".tfvars"):
			return DocumentSyncOptions{LanguageID: "terraform-vars"}
		default:
			return DocumentSyncOptions{LanguageID: "terraform"}
		}
	})

	for name, wantLanguageID := range paths {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, name)
			writer := &recordingLSPWriteCloser{}
			srv := NewServer(dir, ServerCommand{Language: "terraform"})
			srv.setDocumentSyncAdapter("terraform", adapter)
			srv.mu.Lock()
			srv.running = true
			srv.initialized = true
			srv.stdin = writer
			srv.mu.Unlock()

			if err := srv.files.Open(path); err != nil {
				t.Fatal(err)
			}
			if refs := srv.files.RefCount(path); refs != 1 {
				t.Fatalf("FileSync refs = %d, want disk-indexed path retained", refs)
			}
			if wantLanguageID == "" {
				if err := srv.DidChange(context.Background(), path, "changed"); err != nil {
					t.Fatal(err)
				}
				if err := srv.files.CloseAll(); err != nil {
					t.Fatal(err)
				}
				if writer.Len() != 0 {
					t.Fatalf("suppressed JSON variant emitted document sync: %q", writer.String())
				}
				return
			}

			raw := writer.String()
			if !strings.Contains(raw, `"method":"textDocument/didOpen"`) || !strings.Contains(raw, `"languageId":"`+wantLanguageID+`"`) {
				t.Fatalf("didOpen payload = %q, want languageId %q", raw, wantLanguageID)
			}
			srv.files.Reset()
		})
	}
}

func TestServerPathCapabilityGateReturnsStructuredErrorBeforeStartOrRequest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "network.tf.json")
	if err := os.WriteFile(path, []byte(`{"resource": {}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	adapter := testPathCapabilityAdapterFunc(func(_ string, action, _ string) (PathCapabilityDecision, bool) {
		return PathCapabilityDecision{Explanation: "terraform-ls does not support Terraform JSON action " + action}, true
	})
	tests := []struct {
		action string
		query  func(*Server) error
	}{
		{action: "symbols", query: func(s *Server) error {
			_, err := s.DocumentSymbols(context.Background(), path)
			return err
		}},
		{action: "definition", query: func(s *Server) error {
			_, err := s.Definition(context.Background(), path, 0, 0)
			return err
		}},
		{action: "references", query: func(s *Server) error {
			_, err := s.References(context.Background(), path, 0, 0)
			return err
		}},
	}
	for _, tt := range tests {
		t.Run(tt.action, func(t *testing.T) {
			srv := NewServer(filepath.Dir(path), ServerCommand{
				Language: "terraform",
				Name:     "terraform-ls",
				Backend:  "terraform-ls",
				Path:     filepath.Join(t.TempDir(), "must-not-start"),
			})
			srv.setPathCapabilityAdapter(adapter)
			err := tt.query(srv)
			var runtimeErr *RuntimeError
			if !errors.As(err, &runtimeErr) {
				t.Fatalf("query error = %v, want RuntimeError", err)
			}
			if runtimeErr.Code != "unsupported_capability" || runtimeErr.Language != "terraform" || runtimeErr.Backend != "terraform-ls" || runtimeErr.Action != tt.action {
				t.Fatalf("RuntimeError = %#v", runtimeErr)
			}
			payload := runtimeErr.Payload()
			advertised, ok := payload["advertised_capabilities"].([]string)
			if !ok || len(advertised) != 0 || payload["explanation"] == "" {
				t.Fatalf("RuntimeError payload = %#v, want empty advertised capabilities and explanation", payload)
			}
			if srv.Alive() {
				t.Fatal("path capability gate started the server")
			}
		})
	}
}

func TestServerPathCapabilityGateDoesNotSendRequestToRunningServer(t *testing.T) {
	path := filepath.Join(t.TempDir(), "network.tf.json")
	writer := &recordingLSPWriteCloser{}
	srv := NewServer(filepath.Dir(path), ServerCommand{Language: "terraform", Name: "terraform-ls"})
	srv.setPathCapabilityAdapter(testPathCapabilityAdapterFunc(func(_ string, action, _ string) (PathCapabilityDecision, bool) {
		return PathCapabilityDecision{Explanation: "Terraform JSON does not support " + action}, true
	}))
	srv.mu.Lock()
	srv.running = true
	srv.initialized = true
	srv.capabilitiesKnown = true
	srv.advertisedCapabilities = []string{CapabilityDocumentSymbols, CapabilityDefinition, CapabilityReferences}
	srv.stdin = writer
	srv.mu.Unlock()

	_, err := srv.DocumentSymbols(context.Background(), path)
	var runtimeErr *RuntimeError
	if !errors.As(err, &runtimeErr) {
		t.Fatalf("DocumentSymbols() error = %v, want RuntimeError", err)
	}
	if len(runtimeErr.AdvertisedCapabilities) != 0 {
		t.Fatalf("path-advertised capabilities = %#v, want none", runtimeErr.AdvertisedCapabilities)
	}
	if writer.Len() != 0 {
		t.Fatalf("path capability gate sent protocol request: %q", writer.String())
	}
}

func TestServerTerminalProtocolFailureKillsProcessAndResetsSessionState(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "protocol-failure-process" {
		time.Sleep(time.Hour)
		return
	}

	cmd := exec.Command(os.Args[0], "-test.run=TestServerTerminalProtocolFailureKillsProcessAndResetsSessionState")
	cmd.Env = append(os.Environ(), "KNOWNS_LSP_HELPER=protocol-failure-process")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	srv := NewServer(t.TempDir(), ServerCommand{Language: "go", Name: "broken-ls"})
	stalePath := filepath.Join(srv.Root, "stale.go")
	if err := os.WriteFile(stalePath, []byte("package stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	srv.mu.Lock()
	srv.cmd = cmd
	srv.exited = exited
	srv.stdin = discardWriteCloser{}
	srv.reader = bufio.NewReader(strings.NewReader("Content-Length: 1\r\n\r\nx"))
	srv.running = true
	srv.initialized = true
	srv.capabilitiesKnown = true
	srv.advertisedCapabilities = []string{CapabilityDefinition}
	srv.diagnostics[fileURI(stalePath)] = []Diagnostic{{Message: "stale"}}
	srv.diagnosticResultIDs[fileURI(stalePath)] = "stale-result"
	srv.mu.Unlock()
	go srv.wait(cmd, exited)
	if err := srv.files.Open(stalePath); err != nil {
		t.Fatal(err)
	}

	var result int
	if err := srv.request(context.Background(), "workspace/symbol", map[string]any{"query": "Target"}, &result); err == nil {
		t.Fatal("request error = nil, want malformed protocol failure")
	}

	select {
	case <-exited:
	case <-time.After(3 * time.Second):
		t.Fatal("protocol-failed process was not killed and reaped")
	}
	if refs := srv.files.RefCount(stalePath); refs != 0 {
		t.Fatalf("FileSync refs = %d after protocol failure, want 0", refs)
	}
	srv.mu.Lock()
	defer srv.mu.Unlock()
	if srv.running || srv.initialized || srv.capabilitiesKnown || len(srv.diagnostics) != 0 || len(srv.diagnosticResultIDs) != 0 {
		t.Fatalf("protocol failure left stale state: running=%v initialized=%v known=%v diagnostics=%#v resultIDs=%#v", srv.running, srv.initialized, srv.capabilitiesKnown, srv.diagnostics, srv.diagnosticResultIDs)
	}
}

func TestCachePulledDiagnosticsClearsStaleResultID(t *testing.T) {
	srv := NewServer(t.TempDir(), ServerCommand{Language: "json"})
	path := filepath.Join(srv.Root, "settings.json")
	srv.cachePulledDiagnostics(path, "result-1", []Diagnostic{{Message: "first"}})
	if got := srv.cachedDiagnosticResultID(path); got != "result-1" {
		t.Fatalf("cached result ID = %q, want result-1", got)
	}

	srv.cachePulledDiagnostics(path, "", []Diagnostic{{Message: "fresh full report"}})
	if got := srv.cachedDiagnosticResultID(path); got != "" {
		t.Fatalf("cached result ID = %q after full report without resultId, want empty", got)
	}
}

func TestServerProtocolCoversInterleavedMessages(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "protocol" {
		runProtocolHelper()
		return
	}

	dir := t.TempDir()
	path := dir + string(os.PathSeparator) + "sample.go"
	if err := os.WriteFile(path, []byte("package main\n\nfunc Target() {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("KNOWNS_LSP_HELPER", "protocol")
	srv := NewServer(dir, ServerCommand{
		Language: "go",
		Name:     "protocol-helper",
		Path:     os.Args[0],
		Args:     []string{"-test.run=TestServerProtocolCoversInterleavedMessages"},
	})

	startCtx, cancelStart := context.WithTimeout(context.Background(), 3*time.Second)

	symbols, err := srv.DocumentSymbols(startCtx, path)
	if err != nil {
		cancelStart()
		t.Fatal(err)
	}
	cancelStart()
	if len(symbols) != 1 || symbols[0].Name != "Target" {
		t.Fatalf("DocumentSymbols() = %#v, want Target", symbols)
	}
	snapshot := srv.CapabilitySnapshot()
	if !snapshot.Known || !hasCapability(snapshot.Advertised, CapabilityDefinition) || !hasCapability(snapshot.Advertised, CapabilityReferences) {
		t.Fatalf("CapabilitySnapshot() = %#v, want initialize-advertised definition and references", snapshot)
	}
	time.Sleep(50 * time.Millisecond)
	if !srv.Alive() {
		t.Fatalf("server exited after successful startup context was canceled")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	readyCtx, readyCancel := context.WithTimeout(context.Background(), time.Second)
	defer readyCancel()
	srv.WaitReady(readyCtx)
	if readyCtx.Err() != nil {
		t.Fatalf("WaitReady() did not observe progress end")
	}

	diagnostics, err := srv.Diagnostics(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 1 || diagnostics[0].Message != "pulled diagnostic" {
		t.Fatalf("Diagnostics() = %#v, want full pulled diagnostic", diagnostics)
	}
	unchangedDiagnostics, err := srv.Diagnostics(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(unchangedDiagnostics) != 1 || unchangedDiagnostics[0].Message != "pulled diagnostic" {
		t.Fatalf("second Diagnostics() = %#v, want cached unchanged diagnostic", unchangedDiagnostics)
	}

	definition, err := srv.Definition(ctx, path, 2, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !sameFileURI(definition.URI, path) || definition.Range.Start.Line != 2 {
		t.Fatalf("Definition() = %#v, want location in %s", definition, path)
	}

	references, err := srv.References(ctx, path, 2, 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(references) != 1 || !sameFileURI(references[0].URI, path) {
		t.Fatalf("References() = %#v, want one local reference", references)
	}

	edit, err := srv.Rename(ctx, path, 2, 5, "RenamedTarget")
	if err != nil {
		t.Fatal(err)
	}
	changes := edit.AllChanges()
	if len(changes) != 1 || len(changes[FileURI(path)]) != 1 || changes[FileURI(path)][0].NewText != "RenamedTarget" {
		t.Fatalf("Rename() = %#v, want one edit for RenamedTarget", edit)
	}

	if err := srv.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestServerFirstUnsupportedRequestReturnsStructuredErrorWithoutProtocolCall(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "unsupported-capability" {
		runUnsupportedCapabilityHelper()
		return
	}

	dir := t.TempDir()
	path := dir + string(os.PathSeparator) + "sample.go"
	if err := os.WriteFile(path, []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KNOWNS_LSP_HELPER", "unsupported-capability")
	srv := NewServer(dir, ServerCommand{
		Language: "go",
		Name:     "limited-ls",
		Path:     os.Args[0],
		Args:     []string{"-test.run=TestServerFirstUnsupportedRequestReturnsStructuredErrorWithoutProtocolCall"},
	})
	srv.SetCapabilityProfile(CodeCapabilityProfile())

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := srv.Definition(ctx, path, 0, 0)
	var runtimeErr *RuntimeError
	if !errors.As(err, &runtimeErr) {
		t.Fatalf("Definition() error = %v, want RuntimeError", err)
	}
	if runtimeErr.Code != "unsupported_capability" || runtimeErr.Action != "definition" || runtimeErr.Language != "go" || runtimeErr.Backend != "limited-ls" {
		t.Fatalf("RuntimeError = %#v", runtimeErr)
	}
	if !reflect.DeepEqual(runtimeErr.AdvertisedCapabilities, []string{CapabilityDocumentSymbols}) {
		t.Fatalf("AdvertisedCapabilities = %#v", runtimeErr.AdvertisedCapabilities)
	}
	if err := srv.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	if snapshot := srv.CapabilitySnapshot(); snapshot.Known || len(snapshot.Capabilities) != 0 {
		t.Fatalf("stale capability snapshot after stop: %#v", snapshot)
	}
}

func TestServerDiagnosticsPumpsLegacyPublishAfterDidOpen(t *testing.T) {
	if os.Getenv("KNOWNS_LSP_HELPER") == "legacy-diagnostics" {
		runLegacyDiagnosticHelper()
		return
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"enabled":"invalid"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KNOWNS_LSP_HELPER", "legacy-diagnostics")
	srv := NewServer(dir, ServerCommand{
		Language: "json",
		Name:     "legacy-diagnostic-helper",
		Path:     os.Args[0],
		Args:     []string{"-test.run=TestServerDiagnosticsPumpsLegacyPublishAfterDidOpen"},
	})
	srv.SetCapabilityProfile(DocumentConfigCapabilityProfile())

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	diagnostics, err := srv.Diagnostics(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if len(diagnostics) != 1 || diagnostics[0].Message != "delayed legacy diagnostic" {
		t.Fatalf("Diagnostics() = %#v, want delayed legacy diagnostic", diagnostics)
	}
	if err := srv.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func runProtocolHelper() {
	reader := bufio.NewReader(os.Stdin)
	openedURI := ""
	diagnosticPulls := 0
	for {
		msg, err := testReadMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		var envelope struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if err := json.Unmarshal(msg, &envelope); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		switch envelope.Method {
		case "initialize":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": 101, "method": "workspace/configuration", "params": map[string]any{"items": []any{}}})
			assertProtocolResponse(reader, 101, []any{})
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": 102, "method": "window/workDoneProgress/create", "params": map[string]any{"token": "startup"}})
			assertProtocolResponse(reader, 102, nil)
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "method": "$/progress", "params": map[string]any{"token": "startup", "value": map[string]any{"kind": "begin"}}})
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{"capabilities": map[string]any{
				"documentSymbolProvider": true,
				"definitionProvider":     true,
				"diagnosticProvider":     map[string]any{"interFileDependencies": false, "workspaceDiagnostics": false},
				"referencesProvider":     map[string]any{},
				"renameProvider":         map[string]any{"prepareProvider": true},
			}}})
		case "textDocument/didOpen":
			var params struct {
				TextDocument struct {
					URI string `json:"uri"`
				} `json:"textDocument"`
			}
			_ = json.Unmarshal(envelope.Params, &params)
			openedURI = params.TextDocument.URI
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": map[string]any{
				"uri": openedURI,
				"diagnostics": []map[string]any{{
					"range":    map[string]any{"start": map[string]any{"line": 1, "character": 0}, "end": map[string]any{"line": 1, "character": 1}},
					"severity": 2,
					"message":  "fake diagnostic",
				}},
			}})
		case "textDocument/documentSymbol":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": 103, "method": "client/registerCapability", "params": map[string]any{"registrations": []any{}}})
			assertProtocolResponse(reader, 103, nil)
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "method": "$/progress", "params": map[string]any{"token": "startup", "value": map[string]any{"kind": "end"}}})
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": []map[string]any{{
				"name":           "Target",
				"kind":           12,
				"range":          map[string]any{"start": map[string]any{"line": 2, "character": 0}, "end": map[string]any{"line": 2, "character": 16}},
				"selectionRange": map[string]any{"start": map[string]any{"line": 2, "character": 5}, "end": map[string]any{"line": 2, "character": 11}},
			}}})
		case "textDocument/diagnostic":
			var params struct {
				PreviousResultID string `json:"previousResultId"`
			}
			_ = json.Unmarshal(envelope.Params, &params)
			if diagnosticPulls == 0 {
				if params.PreviousResultID != "" {
					fmt.Fprintf(os.Stderr, "first diagnostic previousResultId = %q, want empty\n", params.PreviousResultID)
					os.Exit(2)
				}
				testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
					"kind":     "full",
					"resultId": "diagnostics-1",
					"items": []map[string]any{{
						"range":    map[string]any{"start": map[string]any{"line": 1, "character": 0}, "end": map[string]any{"line": 1, "character": 1}},
						"severity": 2,
						"message":  "pulled diagnostic",
					}},
				}})
			} else {
				if params.PreviousResultID != "diagnostics-1" {
					fmt.Fprintf(os.Stderr, "diagnostic previousResultId = %q, want diagnostics-1\n", params.PreviousResultID)
					os.Exit(2)
				}
				testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
					"kind":     "unchanged",
					"resultId": "diagnostics-1",
				}})
			}
			diagnosticPulls++
		case "textDocument/definition":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
				"uri": openedURI,
				"range": map[string]any{
					"start": map[string]any{"line": 2, "character": 5},
					"end":   map[string]any{"line": 2, "character": 11},
				},
			}})
		case "textDocument/references":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": []map[string]any{{
				"uri": openedURI,
				"range": map[string]any{
					"start": map[string]any{"line": 2, "character": 5},
					"end":   map[string]any{"line": 2, "character": 11},
				},
			}}})
		case "textDocument/rename":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
				"changes": map[string]any{
					openedURI: []map[string]any{{
						"range": map[string]any{
							"start": map[string]any{"line": 2, "character": 5},
							"end":   map[string]any{"line": 2, "character": 11},
						},
						"newText": "RenamedTarget",
					}},
				},
			}})
		case "shutdown":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil})
		case "exit":
			return
		}
	}
}

func runUnsupportedCapabilityHelper() {
	reader := bufio.NewReader(os.Stdin)
	for {
		msg, err := testReadMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		var envelope struct {
			ID     *int64 `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(msg, &envelope); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		switch envelope.Method {
		case "initialize":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
				"capabilities": map[string]any{"documentSymbolProvider": true},
			}})
		case "initialized":
			// Notification; no response.
		case "textDocument/definition":
			fmt.Fprintln(os.Stderr, "unsupported definition request reached protocol")
			os.Exit(3)
		case "shutdown":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil})
		case "exit":
			return
		}
	}
}

func runLegacyDiagnosticHelper() {
	reader := bufio.NewReader(os.Stdin)
	openedURI := ""
	for {
		msg, err := testReadMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		var envelope struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(msg, &envelope); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		switch envelope.Method {
		case "initialize":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{
				"capabilities": map[string]any{"documentSymbolProvider": true},
			}})
		case "initialized", "textDocument/didClose":
			// Notifications; no response.
		case "textDocument/didOpen":
			var params struct {
				TextDocument struct {
					URI string `json:"uri"`
				} `json:"textDocument"`
			}
			_ = json.Unmarshal(envelope.Params, &params)
			openedURI = params.TextDocument.URI
		case "textDocument/documentSymbol":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": map[string]any{
				"uri": openedURI,
				"diagnostics": []map[string]any{{
					"range":    map[string]any{"start": map[string]any{"line": 0, "character": 0}, "end": map[string]any{"line": 0, "character": 1}},
					"severity": 1,
					"message":  "delayed legacy diagnostic",
				}},
			}})
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": []any{}})
		case "shutdown":
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil})
		case "exit":
			return
		}
	}
}

func assertProtocolResponse(reader *bufio.Reader, id int64, want any) {
	msg, err := testReadMessage(reader)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var envelope struct {
		ID     int64           `json:"id"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(msg, &envelope); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if envelope.ID != id {
		fmt.Fprintf(os.Stderr, "response id = %d, want %d\n", envelope.ID, id)
		os.Exit(2)
	}
	var got any
	if len(envelope.Result) > 0 && string(envelope.Result) != "null" {
		if err := json.Unmarshal(envelope.Result, &got); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
	if !reflect.DeepEqual(got, want) {
		fmt.Fprintf(os.Stderr, "response result = %#v, want %#v\n", got, want)
		os.Exit(2)
	}
}

func testReadMessage(reader *bufio.Reader) ([]byte, error) {
	var length int
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if strings.HasPrefix(strings.ToLower(line), "content-length:") {
			_, _ = fmt.Sscanf(line, "Content-Length: %d", &length)
		}
	}
	if length <= 0 {
		return nil, fmt.Errorf("missing content length")
	}
	buf := make([]byte, length)
	_, err := io.ReadFull(reader, buf)
	return buf, err
}

func testWriteMessage(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(data), data)
}
