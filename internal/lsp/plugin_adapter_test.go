package lsp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("KNOWNS_FAKE_LSP_SERVER") == "1" {
		if err := runFakePluginLSPServer(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	os.Exit(m.Run())
}

func TestLoadPluginAdaptersParsesManifest(t *testing.T) {
	dir := t.TempDir()
	writePluginManifest(t, dir, "toy.json", `{
		"language_id": "toy",
		"backend_id": "toy-ls",
		"name": "Toy",
		"extensions": [".toy"],
		"binary_candidates": [{"name": "toy-lsp"}],
		"default_args": ["--stdio"],
		"prerequisites": [{"name": "Node.js", "check_cmd": "node --version", "install_hint": "Install Node"}],
		"install_guide": {"command": "npm install -g toy-lsp", "knowns_cmd": "knowns lsp install toy", "notes": "Requires Node"},
		"runtime_dependencies": [{"id": "toy-lsp", "version": "1.0.0", "source": "npm", "archive_type": "npm", "binary_name": "toy-lsp", "package_name": "toy-lsp"}],
		"initialization_options": {"diagnostics": true},
		"ignored_dirs": ["vendor"],
		"capabilities": {"implementation": false, "references": true}
	}`)

	result := LoadPluginAdapters(PluginAdapterLoadOptions{Dir: dir})
	if len(result.Errors) != 0 {
		t.Fatalf("LoadPluginAdapters errors = %v", result.Errors)
	}
	if len(result.Adapters) != 1 {
		t.Fatalf("LoadPluginAdapters adapters = %d, want 1", len(result.Adapters))
	}
	adapter := result.Adapters[0]
	if adapter.ID() != "toy" || adapter.Name() != "Toy" {
		t.Fatalf("adapter identity = %q/%q, want toy/Toy", adapter.ID(), adapter.Name())
	}
	if got := adapter.Extensions(); !reflect.DeepEqual(got, []string{".toy"}) {
		t.Fatalf("Extensions() = %#v, want .toy", got)
	}
	if got := adapter.Binaries(); len(got) != 1 || got[0].Name != "toy-lsp" || !reflect.DeepEqual(got[0].Args, []string{"--stdio"}) {
		t.Fatalf("Binaries() = %#v, want default args applied", got)
	}
	if !adapter.CanInstall() || len(adapter.RuntimeDeps()) != 1 {
		t.Fatalf("runtime dependencies not exposed")
	}
	if got := adapter.InitializationOptions(nil); got["diagnostics"] != true {
		t.Fatalf("InitializationOptions() = %#v, want diagnostics=true", got)
	}
	if !adapter.IsIgnoredDir("vendor") {
		t.Fatalf("IsIgnoredDir(vendor) = false, want true")
	}
	if adapter.SupportsImplementation() {
		t.Fatalf("SupportsImplementation() = true, want false from manifest capability")
	}
	if !adapter.SupportsReferences() {
		t.Fatalf("SupportsReferences() = false, want true")
	}
}

func TestLoadPluginAdaptersFailsOpenInvalidManifest(t *testing.T) {
	dir := t.TempDir()
	writePluginManifest(t, dir, "valid.json", `{"id":"ok","name":"OK","extensions":[".ok"],"binaries":[{"name":"ok-lsp"}]}`)
	writePluginManifest(t, dir, "invalid.json", `{"id":"bad","extensions":[".bad"],"binaries":[{"name":"bad-lsp"}]}`)

	result := LoadPluginAdapters(PluginAdapterLoadOptions{Dir: dir})
	if len(result.Adapters) != 1 || result.Adapters[0].ID() != "ok" {
		t.Fatalf("Adapters = %#v, want only valid manifest", result.Adapters)
	}
	if len(result.Errors) != 1 {
		t.Fatalf("Errors = %#v, want one invalid-manifest error", result.Errors)
	}
	if !strings.Contains(result.Errors[0].Path, "invalid.json") {
		t.Fatalf("invalid error path = %q, want invalid.json", result.Errors[0].Path)
	}
}

func TestManagerPluginAdapterExactIDOverrideTakesPrecedence(t *testing.T) {
	dir := t.TempDir()
	writePluginManifest(t, dir, "go.json", `{"id":"go","name":"Plugin Go","extensions":[".gox"],"binaries":[{"name":"custom-gopls"}]}`)
	manager := NewManager(t.TempDir(), Config{})
	if err := manager.RegisterAdapter(statusMockAdapter{id: "go", name: "Go", extensions: []string{".go"}, binaries: []BinaryCandidate{{Name: "gopls"}}}); err != nil {
		t.Fatalf("RegisterAdapter built-in = %v", err)
	}

	errs := manager.RegisterPluginAdapters(PluginAdapterLoadOptions{Dir: dir})
	if len(errs) != 0 {
		t.Fatalf("RegisterPluginAdapters errors = %v", errs)
	}
	if _, ok := manager.registry.ForPath("main.go"); ok {
		t.Fatalf("old .go extension still mapped after plugin exact-ID override")
	}
	lang, ok := manager.registry.ForPath("main.gox")
	if !ok || lang.ID != "go" || lang.Name != "Plugin Go" {
		t.Fatalf("ForPath(main.gox) = %#v %v, want plugin go", lang, ok)
	}
	manager.mu.Lock()
	adapter := manager.adapters["go"]
	manager.mu.Unlock()
	if adapter == nil || adapter.Name() != "Plugin Go" {
		t.Fatalf("manager adapter = %#v, want plugin override", adapter)
	}
}

func TestManagerPluginAdapterExtensionCollisionRejected(t *testing.T) {
	dir := t.TempDir()
	writePluginManifest(t, dir, "other.json", `{"id":"other","name":"Other","extensions":[".go"],"binaries":[{"name":"other-lsp"}]}`)
	manager := NewManager(t.TempDir(), Config{})
	if err := manager.RegisterAdapter(statusMockAdapter{id: "go", name: "Go", extensions: []string{".go"}, binaries: []BinaryCandidate{{Name: "gopls"}}}); err != nil {
		t.Fatalf("RegisterAdapter built-in = %v", err)
	}

	errs := manager.RegisterPluginAdapters(PluginAdapterLoadOptions{Dir: dir})
	if len(errs) != 1 || !errors.Is(errs[0].Err, ErrExtensionAlreadyRegistered) {
		t.Fatalf("RegisterPluginAdapters errors = %#v, want extension collision", errs)
	}
	manager.mu.Lock()
	adapter := manager.adapters["other"]
	manager.mu.Unlock()
	if adapter != nil {
		t.Fatalf("collision adapter registered unexpectedly: %#v", adapter)
	}
	lang, ok := manager.registry.ForPath("main.go")
	if !ok || lang.ID != "go" {
		t.Fatalf("collision changed .go owner to %#v %v", lang, ok)
	}
}

func TestPluginAdapterRuntimeStatusMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.toy"), []byte("toy"), 0o644); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	writePluginManifest(t, dir, "toy.json", `{
		"id":"toy",
		"name":"Toy",
		"extensions":[".toy"],
		"binaries":[{"name":"toy-lsp"}],
		"install_guide":{"knowns_cmd":"knowns lsp install toy"}
	}`)
	manager := NewManager(root, Config{})
	if errs := manager.RegisterPluginAdapters(PluginAdapterLoadOptions{Dir: dir}); len(errs) != 0 {
		t.Fatalf("RegisterPluginAdapters errors = %v", errs)
	}
	manager.SetDetector(&Detector{
		Registry: manager.registry,
		LookPath: func(name string) (string, error) {
			if name == "toy-lsp" {
				return filepath.Join(root, "bin", name), nil
			}
			return "", os.ErrNotExist
		},
		RunCheck:  func(context.Context, string, ...string) error { return nil },
		Installer: NewInstaller(t.TempDir()),
	})

	statuses := manager.RuntimeStatuses(context.Background())
	if len(statuses) != 1 {
		t.Fatalf("RuntimeStatuses() = %#v, want one plugin status", statuses)
	}
	status := statuses[0]
	if status.ID != "toy" || status.Name != "Toy" || !status.Detected {
		t.Fatalf("status identity/detection = %#v, want detected Toy", status)
	}
	if status.InstallState != RuntimeInstallInstalled || status.Source != RuntimeSourcePATH || status.Binary != "toy-lsp" {
		t.Fatalf("install/source/binary = %q/%q/%q, want installed/PATH/toy-lsp", status.InstallState, status.Source, status.Binary)
	}
	if status.InstallCmd != "knowns lsp install toy" {
		t.Fatalf("InstallCmd = %q, want plugin guide command", status.InstallCmd)
	}
	if status.LogPath != LanguageLogPath(root, "toy") {
		t.Fatalf("LogPath = %q, want shared language log path", status.LogPath)
	}
}

func TestPluginAdapterStartLanguageUsesManagerCommandConstruction(t *testing.T) {
	root := t.TempDir()
	binaryName, binaryDir := fakePluginLSPExecutable(t)
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("KNOWNS_FAKE_LSP_SERVER", "1")
	t.Setenv("KNOWNS_FAKE_LSP_ARGS_FILE", argsFile)
	t.Setenv("PATH", binaryDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	dir := t.TempDir()
	writePluginManifest(t, dir, "toy.json", fmt.Sprintf(`{
		"id":"toy",
		"name":"Toy",
		"extensions":[".toy"],
		"binaries":[{"name":%q}],
		"default_args":["--stdio","--plugin"]
	}`, binaryName))
	manager := NewManager(root, Config{})
	if errs := manager.RegisterPluginAdapters(PluginAdapterLoadOptions{Dir: dir}); len(errs) != 0 {
		t.Fatalf("RegisterPluginAdapters errors = %v", errs)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := manager.StartLanguage(ctx, "toy"); err != nil {
		t.Fatalf("StartLanguage returned error: %v", err)
	}
	defer func() { _ = manager.StopLanguage("toy") }()

	manager.mu.Lock()
	server := manager.servers["toy"]
	status := manager.status["toy"]
	manager.mu.Unlock()
	if server == nil {
		t.Fatalf("StartLanguage did not create a shared Server wrapper")
	}
	if server.Command.Name != binaryName || !reflect.DeepEqual(server.Command.Args, []string{"--stdio", "--plugin"}) {
		t.Fatalf("server command = %#v, want plugin binary and default args", server.Command)
	}
	if server.Command.LogPath != LanguageLogPath(root, "toy") {
		t.Fatalf("LogPath = %q, want shared log path", server.Command.LogPath)
	}
	if status != StatusRunning {
		t.Fatalf("status = %v, want running", status)
	}
	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read fake args file: %v", err)
	}
	if got := strings.Fields(string(data)); !reflect.DeepEqual(got, []string{"--stdio", "--plugin"}) {
		t.Fatalf("launched args = %#v, want default args", got)
	}
}

func writePluginManifest(t *testing.T, dir, name, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakePluginLSPExecutable(t *testing.T) (string, string) {
	t.Helper()
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "fake-plugin-lsp"
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

func runFakePluginLSPServer() error {
	if argsFile := os.Getenv("KNOWNS_FAKE_LSP_ARGS_FILE"); argsFile != "" {
		if err := os.WriteFile(argsFile, []byte(strings.Join(os.Args[1:], " ")), 0o644); err != nil {
			return err
		}
	}
	reader := bufio.NewReader(os.Stdin)
	for {
		message, err := readFakeLSPMessage(reader)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		var envelope struct {
			ID     *int64          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(message, &envelope); err != nil {
			return err
		}
		switch envelope.Method {
		case "initialize":
			if envelope.ID == nil {
				return fmt.Errorf("initialize request missing id")
			}
			if err := writeFakeLSPMessage(map[string]any{
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
				if err := writeFakeLSPMessage(map[string]any{"jsonrpc": "2.0", "id": *envelope.ID, "result": nil}); err != nil {
					return err
				}
			}
		case "exit":
			return nil
		}
	}
}

func readFakeLSPMessage(reader *bufio.Reader) ([]byte, error) {
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

func writeFakeLSPMessage(message any) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(os.Stdout, "Content-Length: %d\r\n\r\n%s", len(data), data)
	return err
}
