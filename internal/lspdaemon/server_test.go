package lspdaemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/lsp"
)

func TestMain(m *testing.M) {
	if os.Getenv("KNOWNS_LSPDAEMON_FAKE_LSP") == "1" {
		if err := runFakeDaemonLSPServer(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

func TestDaemonAdminStartStopStatus(t *testing.T) {
	isolateHome(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.fake"), []byte("package fake"), 0o644); err != nil {
		t.Fatal(err)
	}
	binaryName, binaryDir := fakeDaemonLSPExecutable(t)
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("KNOWNS_LSPDAEMON_FAKE_LSP", "1")

	manager := lsp.NewManager(root, lsp.Config{})
	if err := manager.RegisterAdapter(daemonMockAdapter{id: "fake", name: "Fake", extensions: []string{".fake"}, binary: binaryName}); err != nil {
		t.Fatal(err)
	}
	identity, err := IdentifyProject(root)
	if err != nil {
		t.Fatal(err)
	}
	paths := PathsForIdentity(identity)
	token, err := EnsureToken(paths)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{identity: identity, paths: paths, token: token, manager: manager}
	handshake := Handshake{ProjectRoot: identity.Root, Token: token}

	start := server.dispatch(context.Background(), Request{Handshake: handshake, Operation: OperationStartLanguage, Language: "fake"})
	if err := start.err(); err != nil {
		t.Fatalf("start fake language: %v", err)
	}
	status := findStatus(start.Statuses, "fake")
	if status == nil || status.Owner != "daemon" || status.RunningState != lsp.RuntimeRunningRunning {
		t.Fatalf("start status = %#v", status)
	}

	stop := server.dispatch(context.Background(), Request{Handshake: handshake, Operation: OperationStopLanguage, Language: "fake"})
	if err := stop.err(); err != nil {
		t.Fatalf("stop fake language: %v", err)
	}
	status = findStatus(stop.Statuses, "fake")
	if status == nil || status.Owner != "daemon" || status.RunningState == lsp.RuntimeRunningRunning {
		t.Fatalf("stop status = %#v", status)
	}
}

func findStatus(statuses []lsp.LanguageRuntimeStatus, id string) *lsp.LanguageRuntimeStatus {
	for i := range statuses {
		if statuses[i].ID == id {
			return &statuses[i]
		}
	}
	return nil
}

type daemonMockAdapter struct {
	id         string
	name       string
	extensions []string
	binary     string
}

func (a daemonMockAdapter) ID() string           { return a.id }
func (a daemonMockAdapter) Name() string         { return a.name }
func (a daemonMockAdapter) Extensions() []string { return a.extensions }
func (a daemonMockAdapter) Binaries() []lsp.BinaryCandidate {
	return []lsp.BinaryCandidate{{Name: a.binary}}
}
func (a daemonMockAdapter) Prerequisites() []lsp.Prerequisite                      { return nil }
func (a daemonMockAdapter) CheckPrerequisites(context.Context) error               { return nil }
func (a daemonMockAdapter) InstallGuide() lsp.InstallGuide                         { return lsp.InstallGuide{} }
func (a daemonMockAdapter) CanInstall() bool                                       { return false }
func (a daemonMockAdapter) RuntimeDeps() []lsp.RuntimeDependency                   { return nil }
func (a daemonMockAdapter) Install(context.Context, string) (string, error)        { return "", nil }
func (a daemonMockAdapter) InstalledPath() (string, bool)                          { return "", false }
func (a daemonMockAdapter) DefaultArgs() []string                                  { return nil }
func (a daemonMockAdapter) InitializeParams(string, map[string]any) map[string]any { return nil }
func (a daemonMockAdapter) InitializationOptions(map[string]any) map[string]any    { return nil }
func (a daemonMockAdapter) IsIgnoredDir(string) bool                               { return false }
func (a daemonMockAdapter) NormalizeSymbolName(name string) string                 { return name }
func (a daemonMockAdapter) SupportsReferences() bool                               { return true }
func (a daemonMockAdapter) SupportsImplementation() bool                           { return true }

func fakeDaemonLSPExecutable(t *testing.T) (string, string) {
	t.Helper()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "fake-daemon-lsp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	target := filepath.Join(dir, name)
	in, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	return name, dir
}

func runFakeDaemonLSPServer() error {
	reader := bufio.NewReader(os.Stdin)
	for {
		message, err := readFakeDaemonLSPMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		var envelope struct {
			ID     *int64 `json:"id"`
			Method string `json:"method"`
		}
		if err := json.Unmarshal(message, &envelope); err != nil {
			return err
		}
		switch envelope.Method {
		case "initialize":
			if envelope.ID == nil {
				return fmt.Errorf("initialize request missing id")
			}
			if err := writeFakeDaemonLSPMessage(map[string]any{
				"jsonrpc": "2.0",
				"id":      *envelope.ID,
				"result": map[string]any{
					"capabilities": map[string]any{},
				},
			}); err != nil {
				return err
			}
		case "shutdown":
			if envelope.ID != nil {
				if err := writeFakeDaemonLSPMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil}); err != nil {
					return err
				}
			}
		case "exit":
			return nil
		}
	}
}

func readFakeDaemonLSPMessage(reader *bufio.Reader) ([]byte, error) {
	var length int
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimRight(line, "\r\n")
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
	message := make([]byte, length)
	_, err := io.ReadFull(reader, message)
	return message, err
}

func writeFakeDaemonLSPMessage(message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(data), data)
	return err
}
