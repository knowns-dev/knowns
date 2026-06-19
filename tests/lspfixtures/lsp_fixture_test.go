package lspfixtures

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	aspnetWorkshopRepo   = "https://github.com/dotnet-presentations/aspnetcore-app-workshop.git"
	aspnetWorkshopCommit = "3b00fd4ed1ae85c725d12ac6f03cae82cf8d16cc"
	aspnetProjectSubdir  = "src/ConferencePlanner"
	csharpProbeFile      = "BackEnd/Endpoints/SpeakerEndpoints.cs"
	csharpProbeSymbol    = "MapSpeakerEndpoints"
	csharpEditFile       = "BackEnd/Endpoints/SearchEndpoints.cs"
	csharpEditSymbol     = "MapSearchEndpoints"
	csharpSymbolWait     = 3 * time.Minute
)

func TestLSPFixture_ASPNETCoreWebAPI(t *testing.T) {
	if os.Getenv("TEST_LSP_FIXTURES") != "1" {
		t.Skip("set TEST_LSP_FIXTURES=1 to run external LSP fixture smoke tests")
	}
	requireTool(t, "git")
	requireTool(t, "dotnet")
	requireTool(t, "csharp-ls")

	env := testEnv(t)
	binary := knownsBinary(t)
	projectDir := cloneASPNetFixture(t)
	initKnownsProject(t, binary, projectDir, env)
	restoreDotnetProject(t, projectDir, env)
	var csharpLogPath string

	t.Run("cli runtime status", func(t *testing.T) {
		statuses := runKnownsJSON[[]languageStatus](t, binary, projectDir, env, 90*time.Second, "lsp", "list", "--json")
		csharp := requireLanguage(t, statuses, "csharp")
		if csharp.Status == "" || csharp.InstallState == "" {
			t.Fatalf("csharp status missing runtime state: %+v", csharp)
		}
		if csharp.Backend == "" {
			t.Fatalf("expected csharp backend in status: %+v", csharp)
		}
		if csharp.LogPath == "" {
			t.Fatalf("expected csharp log path in status: %+v", csharp)
		}
		csharpLogPath = csharp.LogPath
	})

	t.Run("mcp code tools", func(t *testing.T) {
		client := startMCP(t, binary, projectDir, env)
		client.initialize(t)
		client.setProject(t, projectDir)

		client.callToolUntilRawContains(t, csharpSymbolWait, csharpProbeSymbol, "code", map[string]any{
			"action": "symbols",
			"path":   csharpProbeFile,
			"depth":  2,
		}, func() string {
			return readFailureFile("csharp-ls log", csharpLogPath, 4000)
		})

		definition := client.callTool(t, "code", map[string]any{
			"action": "definition",
			"path":   csharpProbeFile,
			"query":  csharpProbeSymbol,
		})
		if file, _ := definition.object["file"].(string); !strings.HasSuffix(file, filepath.ToSlash(csharpProbeFile)) {
			t.Fatalf("definition returned unexpected file: %s\nraw: %s", file, definition.raw)
		}

		references := client.callTool(t, "code", map[string]any{
			"action": "references",
			"path":   csharpProbeFile,
			"query":  csharpProbeSymbol,
		})
		if len(references.array) == 0 {
			t.Fatalf("expected references for %s, got: %s", csharpProbeSymbol, references.raw)
		}

		diagnostics := client.callTool(t, "code", map[string]any{
			"action": "diagnostics",
			"path":   csharpProbeFile,
		})
		if diagnostics.array == nil {
			t.Fatalf("expected diagnostics array, got: %s", diagnostics.raw)
		}

		replacement := client.callTool(t, "code", map[string]any{
			"action": "replace_body",
			"path":   csharpEditFile,
			"symbol": csharpEditSymbol,
			"body": strings.Join([]string{
				"        public static void MapSearchEndpoints(this IEndpointRouteBuilder routes)",
				"        {",
				"            routes.MapGet(\"/api/Search/ping\", () => Results.Ok(\"pong\"));",
				"        }",
			}, "\n"),
		})
		if success, _ := replacement.object["success"].(bool); !success {
			t.Fatalf("replace_body bare symbol failed: %s", replacement.raw)
		}
		if lines, _ := replacement.object["lines_replaced"].(float64); lines == 0 {
			t.Fatalf("replace_body replaced no lines: %s", replacement.raw)
		}
		client.close()
		buildDotnetProject(t, projectDir, env)
	})

	t.Run("http lsp language api", func(t *testing.T) {
		port := freePort(t)
		cmd, stderr := startBrowser(t, binary, projectDir, port, env)
		t.Cleanup(func() { stopProcess(cmd) })

		var payload languageListResponse
		url := fmt.Sprintf("http://127.0.0.1:%d/api/lsp/languages", port)
		waitForJSON(t, url, 60*time.Second, &payload)
		csharp := requireLanguage(t, payload.Languages, "csharp")
		if csharp.Backend == "" {
			t.Fatalf("expected API csharp backend; stderr=%s payload=%+v", truncate(stderr.String(), 800), csharp)
		}
		if csharp.LogPath == "" {
			t.Fatalf("expected API csharp log path; payload=%+v", csharp)
		}
	})
}

type languageStatus struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	Status         string           `json:"status"`
	InstallState   string           `json:"install_state"`
	InstallStateV2 string           `json:"installState"`
	RunningState   string           `json:"running_state"`
	RunningStateV2 string           `json:"runningState"`
	ReadinessState string           `json:"readiness_state"`
	Backend        string           `json:"backend"`
	BackendSource  string           `json:"backend_source"`
	BackendSource2 string           `json:"backendSource"`
	LogPath        string           `json:"log_path"`
	LogPath2       string           `json:"logPath"`
	Attempts       []map[string]any `json:"attempts"`
}

type languageListResponse struct {
	Languages []languageStatus `json:"languages"`
}

func (s languageStatus) normalized() languageStatus {
	if s.InstallState == "" {
		s.InstallState = s.InstallStateV2
	}
	if s.RunningState == "" {
		s.RunningState = s.RunningStateV2
	}
	if s.BackendSource == "" {
		s.BackendSource = s.BackendSource2
	}
	if s.LogPath == "" {
		s.LogPath = s.LogPath2
	}
	return s
}

func requireLanguage(t *testing.T, statuses []languageStatus, id string) languageStatus {
	t.Helper()
	for _, status := range statuses {
		status = status.normalized()
		if status.ID == id {
			return status
		}
	}
	t.Fatalf("language %q not found in statuses: %+v", id, statuses)
	return languageStatus{}
}

func requireTool(t *testing.T, name string) {
	t.Helper()
	if _, err := exec.LookPath(name); err != nil {
		if os.Getenv("CI") == "" {
			t.Skipf("%s not found in PATH; install it to run LSP fixture smoke locally", name)
		}
		t.Fatalf("%s not found in PATH: %v", name, err)
	}
}

func testEnv(t *testing.T) []string {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(home, 0755); err != nil {
		t.Fatalf("create test home: %v", err)
	}
	env := append([]string{}, os.Environ()...)
	env = append(env,
		"NO_COLOR=1",
		"NO_UPDATE_CHECK=1",
		"KNOWNS_RUNTIME_INLINE=1",
		"HOME="+home,
		"USERPROFILE="+home,
		"DOTNET_CLI_HOME="+home,
		"DOTNET_NOLOGO=1",
		"DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1",
		"NUGET_PACKAGES="+filepath.Join(home, ".nuget", "packages"),
	)
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(home)
		if volume != "" {
			env = append(env, "HOMEDRIVE="+volume)
			env = append(env, "HOMEPATH="+strings.TrimPrefix(home, volume))
		}
	}
	return env
}

func knownsBinary(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("TEST_BINARY"); p != "" {
		abs, err := filepath.Abs(p)
		if err != nil {
			t.Fatalf("resolve TEST_BINARY: %v", err)
		}
		if _, err := os.Stat(abs); err != nil {
			t.Fatalf("TEST_BINARY not found at %s: %v", abs, err)
		}
		return abs
	}
	name := "knowns"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	abs, err := filepath.Abs(filepath.Join("..", "..", "bin", name))
	if err != nil {
		t.Fatalf("resolve default binary: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("knowns binary not found at %s; set TEST_BINARY or build bin/%s first", abs, name)
	}
	return abs
}

func cloneASPNetFixture(t *testing.T) string {
	t.Helper()
	repoDir := filepath.Join(t.TempDir(), "aspnetcore-app-workshop")
	runCmd(t, "", 180*time.Second, nil, "git", "init", repoDir)
	runCmd(t, repoDir, 30*time.Second, nil, "git", "remote", "add", "origin", aspnetWorkshopRepo)
	runCmd(t, repoDir, 180*time.Second, nil, "git", "fetch", "--depth=1", "--filter=blob:none", "origin", aspnetWorkshopCommit)
	runCmd(t, repoDir, 60*time.Second, nil, "git", "checkout", "--detach", "FETCH_HEAD")
	head := strings.TrimSpace(runCmd(t, repoDir, 30*time.Second, nil, "git", "rev-parse", "HEAD").stdout)
	if head != aspnetWorkshopCommit {
		t.Fatalf("fixture commit mismatch: got %s want %s", head, aspnetWorkshopCommit)
	}
	projectDir := filepath.Join(repoDir, filepath.FromSlash(aspnetProjectSubdir))
	if _, err := os.Stat(filepath.Join(projectDir, "ConferencePlanner.sln")); err != nil {
		t.Fatalf("fixture solution missing: %v", err)
	}
	return projectDir
}

func initKnownsProject(t *testing.T, binary, projectDir string, env []string) {
	t.Helper()
	result := runCmd(t, projectDir, 60*time.Second, env, binary, "init", "lsp-fixture-dotnet-webapi", "--no-wizard", "--no-open", "--git-ignored")
	if result.err != nil {
		t.Fatalf("knowns init failed: %v\nstdout: %s\nstderr: %s", result.err, result.stdout, result.stderr)
	}
}

func restoreDotnetProject(t *testing.T, projectDir string, env []string) {
	t.Helper()
	result := runCmd(t, projectDir, 240*time.Second, env, "dotnet", "restore", "ConferencePlanner.sln", "--nologo")
	if result.err != nil {
		t.Fatalf("dotnet restore failed: %v\nstdout: %s\nstderr: %s", result.err, truncate(result.stdout, 2000), truncate(result.stderr, 2000))
	}
}

func buildDotnetProject(t *testing.T, projectDir string, env []string) {
	t.Helper()
	result := runCmd(t, projectDir, 180*time.Second, env, "dotnet", "build", "ConferencePlanner.sln", "--no-restore", "--nologo")
	if result.err != nil {
		t.Fatalf("dotnet build failed after replace_body: %v\nstdout: %s\nstderr: %s", result.err, truncate(result.stdout, 3000), truncate(result.stderr, 3000))
	}
}

type cmdResult struct {
	stdout string
	stderr string
	err    error
}

func runCmd(t *testing.T, dir string, timeout time.Duration, env []string, name string, args ...string) cmdResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if env != nil {
		cmd.Env = env
	}
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		err = fmt.Errorf("command timed out after %s: %s %s", timeout, name, strings.Join(args, " "))
	}
	return cmdResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func runKnownsJSON[T any](t *testing.T, binary, dir string, env []string, timeout time.Duration, args ...string) T {
	t.Helper()
	result := runCmd(t, dir, timeout, env, binary, args...)
	if result.err != nil {
		t.Fatalf("knowns %s failed: %v\nstdout: %s\nstderr: %s", strings.Join(args, " "), result.err, result.stdout, result.stderr)
	}
	var out T
	if err := decodeFirstJSON([]byte(result.stdout), &out); err != nil {
		t.Fatalf("parse knowns JSON for %s: %v\nstdout: %s\nstderr: %s", strings.Join(args, " "), err, result.stdout, result.stderr)
	}
	return out
}

func decodeFirstJSON(data []byte, target any) error {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return errors.New("empty JSON input")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

type mcpClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
	nextID int
	mu     sync.Mutex
}

type toolPayload struct {
	raw    string
	object map[string]any
	array  []any
}

func startMCP(t *testing.T, binary, projectDir string, env []string) *mcpClient {
	t.Helper()
	cmd := exec.Command(binary, "mcp")
	cmd.Dir = projectDir
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("mcp stdin: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("mcp stdout: %v", err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start mcp: %v\nstderr: %s", err, stderr.String())
	}
	client := &mcpClient{cmd: cmd, stdin: stdin, reader: bufio.NewReader(stdout), nextID: 1}
	t.Cleanup(func() { client.close() })
	return client
}

func (c *mcpClient) initialize(t *testing.T) {
	t.Helper()
	resp := c.request(t, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "lsp-fixture-test", "version": "1.0.0"},
	})
	if resp["error"] != nil {
		t.Fatalf("mcp initialize error: %v", resp["error"])
	}
}

func (c *mcpClient) setProject(t *testing.T, projectDir string) {
	t.Helper()
	payload := c.callTool(t, "project", map[string]any{"action": "set", "projectRoot": projectDir})
	if success, _ := payload.object["success"].(bool); !success {
		t.Fatalf("project set failed: %s", payload.raw)
	}
}

func (c *mcpClient) callTool(t *testing.T, name string, args map[string]any) toolPayload {
	t.Helper()
	resp := c.request(t, "tools/call", map[string]any{"name": name, "arguments": args})
	if resp["error"] != nil {
		t.Fatalf("mcp tool %s error: %v", name, resp["error"])
	}
	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("mcp tool %s result has unexpected shape: %v", name, resp)
	}
	content, ok := result["content"].([]any)
	if !ok || len(content) == 0 {
		t.Fatalf("mcp tool %s returned no content: %v", name, result)
	}
	first, ok := content[0].(map[string]any)
	if !ok {
		t.Fatalf("mcp tool %s content has unexpected shape: %v", name, content[0])
	}
	raw, _ := first["text"].(string)
	payload := toolPayload{raw: raw}
	_ = json.Unmarshal([]byte(raw), &payload.object)
	_ = json.Unmarshal([]byte(raw), &payload.array)
	return payload
}

func (c *mcpClient) callToolUntilRawContains(t *testing.T, timeout time.Duration, want, name string, args map[string]any, diagnostics ...func() string) toolPayload {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var payload toolPayload
	for {
		payload = c.callTool(t, name, args)
		if strings.Contains(payload.raw, want) {
			return payload
		}
		if time.Now().After(deadline) {
			var details []string
			for _, diagnostic := range diagnostics {
				if diagnostic == nil {
					continue
				}
				if detail := strings.TrimSpace(diagnostic()); detail != "" {
					details = append(details, detail)
				}
			}
			if len(details) > 0 {
				t.Fatalf("expected %s to contain %q, got: %s\n%s", name, want, truncate(payload.raw, 1200), strings.Join(details, "\n"))
			}
			t.Fatalf("expected %s to contain %q, got: %s", name, want, truncate(payload.raw, 1200))
		}
		time.Sleep(time.Second)
	}
}

func (c *mcpClient) request(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	c.mu.Lock()
	id := c.nextID
	c.nextID++
	c.mu.Unlock()
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal mcp request: %v", err)
	}
	if _, err := c.stdin.Write(append(data, '\n')); err != nil {
		t.Fatalf("write mcp request: %v", err)
	}
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		line, err := c.reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read mcp response: %v", err)
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var resp map[string]any
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			continue
		}
		respID, _ := resp["id"].(float64)
		if int(respID) == id {
			return resp
		}
	}
	t.Fatalf("timeout waiting for mcp response to %s", method)
	return nil
}

func (c *mcpClient) close() {
	if c == nil || c.cmd == nil || c.cmd.Process == nil {
		return
	}
	_ = c.stdin.Close()
	stopProcess(c.cmd)
	c.cmd = nil
}

func startBrowser(t *testing.T, binary, projectDir string, port int, env []string) (*exec.Cmd, *strings.Builder) {
	t.Helper()
	cmd := exec.Command(binary, "browser", "--no-open", "--port", fmt.Sprintf("%d", port), "--project", projectDir)
	cmd.Dir = projectDir
	cmd.Env = env
	var stderr strings.Builder
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("start browser server: %v\nstderr: %s", err, stderr.String())
	}
	return cmd, &stderr
}

func stopProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(os.Interrupt)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = cmd.Process.Kill()
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("allocate free port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

func waitForJSON(t *testing.T, url string, timeout time.Duration, target any) {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil && resp != nil {
			body, readErr := io.ReadAll(resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK && readErr == nil {
				if err := json.Unmarshal(body, target); err == nil {
					return
				} else {
					lastErr = err
				}
			} else if readErr != nil {
				lastErr = readErr
			} else {
				lastErr = fmt.Errorf("status %d: %s", resp.StatusCode, truncate(string(body), 300))
			}
		} else if err != nil {
			lastErr = err
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s: %v", url, lastErr)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func readFailureFile(label, path string, max int) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Sprintf("%s unavailable at %s: %v", label, path, err)
	}
	return fmt.Sprintf("%s (%s):\n%s", label, path, truncate(string(data), max))
}
