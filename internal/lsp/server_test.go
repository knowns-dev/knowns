package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
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
	if len(diagnostics) != 1 || diagnostics[0].Message != "fake diagnostic" {
		t.Fatalf("Diagnostics() = %#v, want cached fake diagnostic", diagnostics)
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

func runProtocolHelper() {
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
			testWriteMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": map[string]any{"capabilities": map[string]any{"documentSymbolProvider": true}}})
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
