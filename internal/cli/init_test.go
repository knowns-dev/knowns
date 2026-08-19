package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimeinstall"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"gopkg.in/yaml.v3"
)

func TestApplyLocalONNXInitCapabilityForMacOSIntel(t *testing.T) {
	unsupported := search.LocalONNXCapabilityForPlatform("darwin", "amd64", "")

	local := initConfig{EnableSemantic: true, EmbeddingSource: "local"}
	if changed := applyLocalONNXInitCapabilityFor(&local, unsupported); !changed {
		t.Fatal("local semantic init should be changed on macOS Intel")
	}
	if local.EnableSemantic {
		t.Fatal("local semantic init should fall back to keyword/BM25 search")
	}

	ollama := initConfig{EnableSemantic: true, EmbeddingSource: "ollama"}
	if changed := applyLocalONNXInitCapabilityFor(&ollama, unsupported); changed {
		t.Fatal("Ollama semantic init should remain enabled")
	}
	if !ollama.EnableSemantic {
		t.Fatal("Ollama semantic init was unexpectedly disabled")
	}

	customRuntime := search.LocalONNXCapabilityForPlatform("darwin", "amd64", "/opt/onnx/libonnxruntime.dylib")
	custom := initConfig{EnableSemantic: true, EmbeddingSource: "local"}
	if changed := applyLocalONNXInitCapabilityFor(&custom, customRuntime); changed {
		t.Fatal("explicit compatible ONNX runtime should keep local semantic init enabled")
	}
	if !custom.EnableSemantic {
		t.Fatal("custom local ONNX semantic init was unexpectedly disabled")
	}
}

func TestLocalONNXUnsupportedForCapability(t *testing.T) {
	unsupported := search.LocalONNXCapabilityForPlatform("darwin", "amd64", "")
	supported := search.LocalONNXCapabilityForPlatform("darwin", "amd64", "/opt/onnx/libonnxruntime.dylib")

	tests := []struct {
		name       string
		settings   *models.SemanticSearchSettings
		capability search.LocalONNXCapability
		want       bool
	}{
		{name: "default provider uses local ONNX", capability: unsupported, want: true},
		{name: "explicit local provider", settings: &models.SemanticSearchSettings{Provider: "local"}, capability: unsupported, want: true},
		{name: "Ollama remains available", settings: &models.SemanticSearchSettings{Provider: "ollama"}, capability: unsupported},
		{name: "API remains available", settings: &models.SemanticSearchSettings{Provider: "api"}, capability: unsupported},
		{name: "custom local runtime re-enables ONNX", settings: &models.SemanticSearchSettings{Provider: "local"}, capability: supported},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := localONNXUnsupportedForCapability(test.settings, test.capability); got != test.want {
				t.Fatalf("localONNXUnsupportedForCapability() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestCreateOpenCodeConfigQuietCreatesConfig(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	projectRoot := t.TempDir()

	if err := createOpenCodeConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createOpenCodeConfigQuiet returned error: %v", err)
	}

	config := readJSONFile(t, filepath.Join(projectRoot, "opencode.json"))

	if got := config["$schema"]; got != "https://opencode.ai/config.json" {
		t.Fatalf("expected OpenCode schema, got %#v", got)
	}

	mcp := getMap(t, config, "mcp")
	knowns := getMap(t, mcp, "knowns")
	if got := knowns["type"]; got != "local" {
		t.Fatalf("expected knowns MCP type local, got %#v", got)
	}
	if got := knowns["enabled"]; got != true {
		t.Fatalf("expected knowns MCP enabled true, got %#v", got)
	}

	command, ok := knowns["command"].([]any)
	if !ok {
		t.Fatalf("expected knowns command to be []any, got %T", knowns["command"])
	}
	if len(command) != 3 {
		t.Fatalf("expected 3 command parts, got %d", len(command))
	}
	expected := []string{"knowns", "mcp", "--stdio"}
	for i, want := range expected {
		if command[i] != want {
			t.Fatalf("expected command[%d] = %q, got %#v", i, want, command[i])
		}
	}
}

func TestRunInitStopsWhenTerminalTooNarrow(t *testing.T) {
	t.Setenv("KNOWN_LSP_AUTO_INSTALL", "0")
	projectRoot := t.TempDir()
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer func() { _ = os.Chdir(oldWD) }()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	terminalWidthFn = func() int { return 50 }
	isTTYFn = func() bool { return true }
	execLookPath = func(name string) (string, error) {
		switch name {
		case "git", "knowns":
			return "/usr/local/bin/" + name, nil
		default:
			return "", os.ErrNotExist
		}
	}
	t.Cleanup(func() {
		terminalWidthFn = terminalWidth
		isTTYFn = isTTY
		execLookPath = defaultExecLookPath
	})

	cmd := initCmd
	cmd.SetArgs([]string{"e2e-test", "--no-open"})

	var stdout bytes.Buffer
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	done := make(chan struct{})
	go func() {
		_, _ = stdout.ReadFrom(r)
		close(done)
	}()

	if err := runInit(cmd, []string{"e2e-test"}); err != nil {
		w.Close()
		<-done
		t.Fatalf("runInit returned error: %v", err)
	}
	_ = w.Close()
	<-done

	if !strings.Contains(stdout.String(), "Terminal is too small for the interactive setup wizard") {
		t.Fatalf("expected narrow-terminal warning, got:\n%s", stdout.String())
	}
	if !strings.Contains(stdout.String(), "knowns init --no-wizard") {
		t.Fatalf("expected no-wizard guidance, got:\n%s", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".knowns", "config.json")); !os.IsNotExist(err) {
		t.Fatalf("expected init to stop without config creation, got err: %v", err)
	}
}

func TestRunInitNoWizardUsesGlobalDefaults(t *testing.T) {
	t.Setenv("KNOWN_LSP_AUTO_INSTALL", "0")
	home := t.TempDir()
	projectRoot := t.TempDir()
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer func() { _ = os.Chdir(oldWD) }()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	oldHome := os.Getenv("HOME")
	oldUserProfile := os.Getenv("USERPROFILE")
	if err := os.Setenv("HOME", home); err != nil {
		t.Fatalf("set HOME: %v", err)
	}
	if err := os.Setenv("USERPROFILE", home); err != nil {
		t.Fatalf("set USERPROFILE: %v", err)
	}
	t.Cleanup(func() {
		_ = os.Setenv("HOME", oldHome)
		_ = os.Setenv("USERPROFILE", oldUserProfile)
	})

	settingsPath := filepath.Join(home, ".knowns", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		t.Fatalf("mkdir settings dir: %v", err)
	}
	writeJSONFile(t, settingsPath, map[string]any{
		"projectDefaults": map[string]any{
			"projectName": "global-default-project",
			"settings": map[string]any{
				"gitTrackingMode": "git-ignored",
				"platforms":       []string{"codex", "agents"},
				"enableChatUI":    false,
				"taskLifecycle": map[string]any{
					"autoArchive": false,
				},
			},
		},
	})

	execLookPath = func(string) (string, error) { return "", os.ErrNotExist }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })
	setInitBoolFlag(t, "no-wizard", true)
	setInitBoolFlag(t, "no-open", true)
	setInitBoolFlag(t, "git-tracked", false)
	setInitBoolFlag(t, "git-ignored", false)
	setInitBoolFlag(t, "force", false)

	if err := runInit(initCmd, nil); err != nil {
		t.Fatalf("runInit returned error: %v", err)
	}

	config := readJSONFile(t, filepath.Join(projectRoot, ".knowns", "config.json"))
	if got := config["name"]; got != "global-default-project" {
		t.Fatalf("expected global project name, got %#v", got)
	}
	settings := getMap(t, config, "settings")
	if got := settings["gitTrackingMode"]; got != "git-ignored" {
		t.Fatalf("expected global gitTrackingMode, got %#v", got)
	}
	if got := settings["enableChatUI"]; got != false {
		t.Fatalf("expected global enableChatUI false, got %#v", got)
	}
	taskLifecycle := getMap(t, settings, "taskLifecycle")
	if got := taskLifecycle["autoArchive"]; got != false {
		t.Fatalf("expected global autoArchive false, got %#v", got)
	}
	if got := taskLifecycle["excludeDoneFromDefaultRetrieval"]; got != true {
		t.Fatalf("expected partial global lifecycle to inherit excludeDone=true, got %#v", got)
	}
	if got := taskLifecycle["archiveAfter"]; got != "30d" {
		t.Fatalf("expected partial global lifecycle to inherit archiveAfter=30d, got %#v", got)
	}
	platforms, ok := settings["platforms"].([]any)
	if !ok || len(platforms) != 2 || platforms[0] != "codex" || platforms[1] != "agents" {
		t.Fatalf("expected global platforms, got %#v", settings["platforms"])
	}
	assertContains(t, readTextFile(t, filepath.Join(projectRoot, "AGENTS.md")), "Compatibility entrypoint")
	if _, err := os.Stat(filepath.Join(projectRoot, "KNOWNS.md")); !os.IsNotExist(err) {
		t.Fatalf("expected init not to create KNOWNS.md, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("expected CLAUDE.md not to be created when global defaults select codex+agents, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".codex", "config.toml")); !os.IsNotExist(err) {
		t.Fatalf("expected init not to create project Codex config, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".mcp.json")); !os.IsNotExist(err) {
		t.Fatalf("expected init not to create project MCP config, got err=%v", err)
	}
}

func TestLifecycleSeedForForcedInitPreservesExistingProject(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("existing"); err != nil {
		t.Fatalf("Init existing project: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load existing project: %v", err)
	}
	project.Settings.TaskLifecycle.AutoArchive = false
	project.Settings.TaskLifecycle.ArchiveAfter = "7d"
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save existing project: %v", err)
	}

	globalLifecycle := models.DefaultTaskLifecycleSettings()
	globalLifecycle.ArchiveAfter = "1d"
	defaults := &storage.ProjectDefaults{Settings: models.ProjectSettings{TaskLifecycle: &globalLifecycle}}
	seed := lifecycleSeedForInit(root, true, defaults)
	if seed == nil || seed.AutoArchive || seed.ArchiveAfter != "7d" {
		t.Fatalf("forced-init lifecycle seed = %#v, want existing project settings", seed)
	}
}

func TestSettingsCommandSurface(t *testing.T) {
	if settingsCmd.Flags().Lookup("global") == nil {
		t.Fatalf("expected settings --global flag to be registered")
	}
	for _, child := range configCmd.Commands() {
		if child.Name() == "toggle" {
			t.Fatalf("knowns config toggle must not be registered")
		}
	}
}

func setInitBoolFlag(t *testing.T, name string, value bool) {
	t.Helper()
	flag := initCmd.Flags().Lookup(name)
	if flag == nil {
		t.Fatalf("missing init flag %q", name)
	}
	old := flag.Value.String()
	if err := initCmd.Flags().Set(name, strconv.FormatBool(value)); err != nil {
		t.Fatalf("set flag %s: %v", name, err)
	}
	t.Cleanup(func() { _ = initCmd.Flags().Set(name, old) })
}

func TestCreateMCPJsonFileQuietUsesNpxKnowns(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	projectRoot := t.TempDir()

	if err := createMCPJsonFileQuiet(projectRoot, false); err != nil {
		t.Fatalf("createMCPJsonFileQuiet returned error: %v", err)
	}

	config := readJSONFile(t, filepath.Join(projectRoot, ".mcp.json"))
	mcpServers := getMap(t, config, "mcpServers")
	knowns := getMap(t, mcpServers, "knowns")

	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected command knowns, got %#v", got)
	}

	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected args to be []any, got %T", knowns["args"])
	}
	expected := []string{"mcp", "--stdio"}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d", len(expected), len(args))
	}
	for i, want := range expected {
		if args[i] != want {
			t.Fatalf("expected args[%d] = %q, got %#v", i, want, args[i])
		}
	}
}

func TestCreateOpenCodeConfigQuietMergesExistingConfig(t *testing.T) {
	projectRoot := t.TempDir()
	configPath := filepath.Join(projectRoot, "opencode.json")

	existing := map[string]any{
		"model": "anthropic/claude-sonnet-4-5",
		"tools": map[string]any{
			"bash": "ask",
		},
		"mcp": map[string]any{
			"context7": map[string]any{
				"type": "remote",
				"url":  "https://mcp.context7.com/mcp",
			},
		},
	}

	writeJSONFile(t, configPath, existing)

	if err := createOpenCodeConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createOpenCodeConfigQuiet returned error: %v", err)
	}

	config := readJSONFile(t, configPath)
	if got := config["model"]; got != existing["model"] {
		t.Fatalf("expected existing model to be preserved, got %#v", got)
	}

	tools := getMap(t, config, "tools")
	if got := tools["bash"]; got != "ask" {
		t.Fatalf("expected existing tools to be preserved, got %#v", got)
	}

	mcp := getMap(t, config, "mcp")
	if _, ok := mcp["context7"]; !ok {
		t.Fatalf("expected existing MCP entry to be preserved")
	}
	if _, ok := mcp["knowns"]; !ok {
		t.Fatalf("expected knowns MCP entry to be added")
	}
}

func TestCreateCursorMCPConfigQuietCreatesConfig(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	projectRoot := t.TempDir()

	if err := createCursorMCPConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createCursorMCPConfigQuiet returned error: %v", err)
	}

	config := readJSONFile(t, filepath.Join(projectRoot, ".cursor", "mcp.json"))
	mcpServers := getMap(t, config, "mcpServers")
	knowns := getMap(t, mcpServers, "knowns")

	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected command knowns, got %#v", got)
	}

	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected args to be []any, got %T", knowns["args"])
	}
	expected := []string{"mcp", "--stdio"}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d", len(expected), len(args))
	}
	for i, want := range expected {
		if args[i] != want {
			t.Fatalf("expected args[%d] = %q, got %#v", i, want, args[i])
		}
	}
}

func TestCreateCodexMCPConfigQuietCreatesConfig(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	projectRoot := t.TempDir()

	if err := createCodexMCPConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createCodexMCPConfigQuiet returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(projectRoot, ".codex", "config.toml"))
	assertContains(t, content, "[mcp_servers.knowns]")
	assertContains(t, content, `command = "knowns"`)
	assertContains(t, content, `args = ["mcp", "--stdio"]`)
}

func TestCreateCodexMCPConfigQuietMergesExistingConfig(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	projectRoot := t.TempDir()
	configDir := filepath.Join(projectRoot, ".codex")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatalf("mkdir .codex: %v", err)
	}
	configPath := filepath.Join(configDir, "config.toml")
	seed := strings.Join([]string{
		"model = \"gpt-5.4\"",
		"",
		"[features]",
		"codex_hooks = true",
	}, "\n") + "\n"
	if err := os.WriteFile(configPath, []byte(seed), 0644); err != nil {
		t.Fatalf("seed config.toml: %v", err)
	}

	if err := createCodexMCPConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createCodexMCPConfigQuiet returned error: %v", err)
	}

	content := readTextFile(t, configPath)
	assertContains(t, content, `model = "gpt-5.4"`)
	assertContains(t, content, `[features]`)
	assertNotContains(t, content, `hooks = true`)
	assertNotContains(t, content, `codex_hooks`)
	assertContains(t, content, `[mcp_servers.knowns]`)
	assertContains(t, content, `args = ["mcp", "--stdio"]`)
}

func TestCreateAntigravityRulesQuietCreatesRuleFile(t *testing.T) {
	projectRoot := t.TempDir()

	if err := createAntigravityRulesQuiet(projectRoot, false); err != nil {
		t.Fatalf("createAntigravityRulesQuiet returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(projectRoot, ".agents", "rules", "knowns.md"))
	assertContains(t, content, "trigger: always_on")
	assertContains(t, content, "Start with Knowns MCP `initial`")
	assertContains(t, content, "Prefer Knowns MCP tools")
	assertContains(t, content, "`knowns`")
}

func TestCreateAntigravityMCPConfigQuietUsesAbsoluteProjectPath(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	home := t.TempDir()
	osUserHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() {
		execLookPath = defaultExecLookPath
		osUserHomeDir = os.UserHomeDir
	})

	projectRoot := t.TempDir()

	if err := createAntigravityMCPConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createAntigravityMCPConfigQuiet returned error: %v", err)
	}

	config := readJSONFile(t, filepath.Join(home, ".gemini", "antigravity", "mcp_config.json"))
	mcpServers := getMap(t, config, "mcpServers")
	knowns := getMap(t, mcpServers, "knowns")

	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected command knowns, got %#v", got)
	}

	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected args to be []any, got %T", knowns["args"])
	}
	expected := []string{"mcp", "--stdio", "--project", projectRoot}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d", len(expected), len(args))
	}
	for i, want := range expected {
		if args[i] != want {
			t.Fatalf("expected args[%d] = %q, got %#v", i, want, args[i])
		}
	}
}

func TestCreateHermesMCPConfigQuietUsesAbsoluteProjectPathAndSkills(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	home := t.TempDir()
	osUserHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() {
		execLookPath = defaultExecLookPath
		osUserHomeDir = os.UserHomeDir
	})

	projectRoot := t.TempDir()

	if err := createHermesMCPConfigQuiet(projectRoot); err != nil {
		t.Fatalf("createHermesMCPConfigQuiet returned error: %v", err)
	}

	config := readYAMLFile(t, filepath.Join(home, ".hermes", "config.yaml"))
	mcpServers := getMap(t, config, "mcp_servers")
	knowns := getMap(t, mcpServers, "knowns")

	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected command knowns, got %#v", got)
	}

	args := anyStringSlice(knowns["args"])
	expected := []string{"mcp", "--stdio", "--project", projectRoot}
	if !sameStrings(args, expected) {
		t.Fatalf("expected args %v, got %v", expected, args)
	}

	skills := getMap(t, config, "skills")
	externalDirs := anyStringSlice(skills["external_dirs"])
	expectedSkillDir := filepath.Join(projectRoot, ".agents", "skills")
	if !sameStrings(externalDirs, []string{expectedSkillDir}) {
		t.Fatalf("expected external_dirs %v, got %v", []string{expectedSkillDir}, externalDirs)
	}
}

func TestSetupGlobalHermesMCPUsesGlobalSkillsWithoutProject(t *testing.T) {
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	t.Cleanup(func() { execLookPath = defaultExecLookPath })

	home := t.TempDir()
	if err := setupGlobalHermesMCP(home); err != nil {
		t.Fatalf("setupGlobalHermesMCP returned error: %v", err)
	}

	config := readYAMLFile(t, filepath.Join(home, ".hermes", "config.yaml"))
	mcpServers := getMap(t, config, "mcp_servers")
	knowns := getMap(t, mcpServers, "knowns")
	args := anyStringSlice(knowns["args"])
	expected := []string{"mcp", "--stdio"}
	if !sameStrings(args, expected) {
		t.Fatalf("expected args %v, got %v", expected, args)
	}

	skills := getMap(t, config, "skills")
	externalDirs := anyStringSlice(skills["external_dirs"])
	expectedSkillDir := filepath.Join(home, ".agents", "skills")
	if !sameStrings(externalDirs, []string{expectedSkillDir}) {
		t.Fatalf("expected external_dirs %v, got %v", []string{expectedSkillDir}, externalDirs)
	}
}

func TestRunSyncPlatformConfigsSkipsWhenPlatformsUnset(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	osUserHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() {
		execLookPath = defaultExecLookPath
		osUserHomeDir = os.UserHomeDir
	})

	if err := runSyncPlatformConfigs(projectRoot, true, nil); err != nil {
		t.Fatalf("runSyncPlatformConfigs returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, ".cursor", "mcp.json")); !os.IsNotExist(err) {
		t.Fatalf("expected .cursor/mcp.json not to be created, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".agents", "rules", "knowns.md")); !os.IsNotExist(err) {
		t.Fatalf("expected .agents/rules/knowns.md not to be created, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".gemini", "antigravity", "mcp_config.json")); !os.IsNotExist(err) {
		t.Fatalf("expected antigravity MCP config not to be created, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(home, ".hermes", "config.yaml")); !os.IsNotExist(err) {
		t.Fatalf("expected hermes MCP config not to be created, got err=%v", err)
	}
}

func TestRunSyncPlatformConfigsCreatesCursorHermesAndAntigravityArtifacts(t *testing.T) {
	projectRoot := t.TempDir()
	home := t.TempDir()
	execLookPath = func(string) (string, error) { return "/usr/local/bin/knowns", nil }
	osUserHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() {
		execLookPath = defaultExecLookPath
		osUserHomeDir = os.UserHomeDir
	})

	platforms := []string{"cursor", "hermes", "antigravity"}
	if err := runSyncPlatformConfigs(projectRoot, true, platforms); err != nil {
		t.Fatalf("runSyncPlatformConfigs returned error: %v", err)
	}

	_ = readJSONFile(t, filepath.Join(projectRoot, ".cursor", "mcp.json"))
	hermesConfig := readYAMLFile(t, filepath.Join(home, ".hermes", "config.yaml"))
	hermesKnowns := getMap(t, getMap(t, hermesConfig, "mcp_servers"), "knowns")
	if got := anyStringSlice(hermesKnowns["args"]); !sameStrings(got, []string{"mcp", "--stdio", "--project", projectRoot}) {
		t.Fatalf("unexpected hermes args: %v", got)
	}
	assertContains(t, readTextFile(t, filepath.Join(projectRoot, ".agents", "rules", "knowns.md")), "trigger: always_on")
	config := readJSONFile(t, filepath.Join(home, ".gemini", "antigravity", "mcp_config.json"))
	mcpServers := getMap(t, config, "mcpServers")
	knowns := getMap(t, mcpServers, "knowns")
	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected args to be []any, got %T", knowns["args"])
	}
	expected := []string{"mcp", "--stdio", "--project", projectRoot}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d", len(expected), len(args))
	}
	for i, want := range expected {
		if args[i] != want {
			t.Fatalf("expected args[%d] = %q, got %#v", i, want, args[i])
		}
	}
}

func TestResolveSyncPlatformTargets(t *testing.T) {
	tests := []struct {
		name      string
		platform  string
		config    []string
		want      []string
		wantError bool
	}{
		{name: "config defaults", platform: "", config: []string{"cursor"}, want: []string{"cursor"}},
		{name: "codex override", platform: "codex", config: []string{"agents"}, want: []string{"codex"}},
		{name: "cursor override", platform: "cursor", config: []string{"agents"}, want: []string{"cursor"}},
		{name: "hermes override", platform: "hermes", config: []string{"agents"}, want: []string{"hermes"}},
		{name: "antigravity override", platform: "antigravity", config: nil, want: []string{"antigravity"}},
		{name: "instruction-only platform returns none", platform: "claude", config: []string{"claude-code"}, want: nil},
		{name: "unknown platform errors", platform: "unknown", config: nil, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveSyncPlatformTargets(tt.platform, tt.config)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveSyncPlatformTargets returned error: %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("expected %d targets, got %d (%v)", len(tt.want), len(got), got)
			}
			for i, want := range tt.want {
				if got[i] != want {
					t.Fatalf("expected target[%d] = %q, got %q", i, want, got[i])
				}
			}
		})
	}
}

func TestResolveSyncPlatformSelection(t *testing.T) {
	tests := []struct {
		name      string
		platform  string
		config    []string
		want      []string
		wantError bool
	}{
		{name: "config defaults", platform: "", config: []string{"codex", "agents"}, want: []string{"codex", "agents"}},
		{name: "claude alias", platform: "claude", config: nil, want: []string{"claude-code"}},
		{name: "codex target", platform: "codex", config: []string{"agents"}, want: []string{"codex"}},
		{name: "hermes target", platform: "hermes", config: []string{"agents"}, want: []string{"hermes"}},
		{name: "all target", platform: "all", config: nil, want: allPlatformIDs},
		{name: "unknown platform errors", platform: "unknown", config: nil, wantError: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := resolveSyncPlatformSelection(tt.platform, tt.config)
			if tt.wantError {
				if err == nil {
					t.Fatalf("expected error, got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveSyncPlatformSelection returned error: %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("expected %d targets, got %d (%v)", len(tt.want), len(got), got)
			}
			for i, want := range tt.want {
				if got[i] != want {
					t.Fatalf("expected target[%d] = %q, got %q", i, want, got[i])
				}
			}
		})
	}
}

func TestRunSyncInstructionsCreatesAgentsForCodexConfig(t *testing.T) {
	projectRoot := t.TempDir()

	if err := runSyncInstructions(projectRoot, "", true, []string{"codex"}); err != nil {
		t.Fatalf("runSyncInstructions returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, "AGENTS.md")); err != nil {
		t.Fatalf("expected AGENTS.md to be created for codex config: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("expected CLAUDE.md not to be created for codex-only sync, got err=%v", err)
	}
}

func TestRunSyncInstructionsCreatesAgentsForCodexPlatform(t *testing.T) {
	projectRoot := t.TempDir()

	if err := runSyncInstructions(projectRoot, "codex", true, nil); err != nil {
		t.Fatalf("runSyncInstructions returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, "AGENTS.md")); err != nil {
		t.Fatalf("expected AGENTS.md to be created for --platform codex: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("expected CLAUDE.md not to be created for --platform codex, got err=%v", err)
	}
}

func TestRunSyncInstructionsCreatesAgentsForHermesPlatform(t *testing.T) {
	projectRoot := t.TempDir()

	if err := runSyncInstructions(projectRoot, "hermes", true, nil); err != nil {
		t.Fatalf("runSyncInstructions returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, "AGENTS.md")); err != nil {
		t.Fatalf("expected AGENTS.md to be created for --platform hermes: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("expected CLAUDE.md not to be created for --platform hermes, got err=%v", err)
	}
}

func TestSyncAntigravityMCPConfigUpdatesCommandAndProject(t *testing.T) {
	home := t.TempDir()
	osUserHomeDir = func() (string, error) { return home, nil }
	t.Cleanup(func() { osUserHomeDir = os.UserHomeDir })

	projectRoot := t.TempDir()
	configPath := filepath.Join(home, ".gemini", "antigravity", "mcp_config.json")
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		t.Fatalf("mkdir antigravity dir: %v", err)
	}
	writeJSONFile(t, configPath, map[string]any{
		"mcpServers": map[string]any{
			"knowns": map[string]any{
				"command": "npx",
				"args":    []string{"-y", "knowns", "mcp", "--stdio"},
			},
		},
	})

	updated, err := syncAntigravityMCPConfig(projectRoot, "knowns", []string{"mcp", "--stdio"})
	if err != nil {
		t.Fatalf("syncAntigravityMCPConfig returned error: %v", err)
	}
	if updated != 1 {
		t.Fatalf("expected updated=1, got %d", updated)
	}

	config := readJSONFile(t, configPath)
	mcpServers := getMap(t, config, "mcpServers")
	knowns := getMap(t, mcpServers, "knowns")
	if got := knowns["command"]; got != "knowns" {
		t.Fatalf("expected command knowns, got %#v", got)
	}
	args, ok := knowns["args"].([]any)
	if !ok {
		t.Fatalf("expected args to be []any, got %T", knowns["args"])
	}
	expected := []string{"mcp", "--stdio", "--project", projectRoot}
	if len(args) != len(expected) {
		t.Fatalf("expected %d args, got %d", len(expected), len(args))
	}
	for i, want := range expected {
		if args[i] != want {
			t.Fatalf("expected args[%d] = %q, got %#v", i, want, args[i])
		}
	}
}

func TestSyncCodexMCPConfigUpdatesCommand(t *testing.T) {
	projectRoot := t.TempDir()
	configDir := filepath.Join(projectRoot, ".codex")
	if err := os.MkdirAll(configDir, 0755); err != nil {
		t.Fatalf("mkdir .codex: %v", err)
	}
	configPath := filepath.Join(configDir, "config.toml")
	seed := strings.Join([]string{
		"[mcp_servers.knowns]",
		`command = "npx"`,
		`args = ["-y", "knowns", "mcp", "--stdio"]`,
	}, "\n") + "\n"
	if err := os.WriteFile(configPath, []byte(seed), 0644); err != nil {
		t.Fatalf("seed config.toml: %v", err)
	}

	updated, err := syncCodexMCPConfig(projectRoot, "knowns", []string{"mcp", "--stdio"})
	if err != nil {
		t.Fatalf("syncCodexMCPConfig returned error: %v", err)
	}
	if updated != 1 {
		t.Fatalf("expected updated=1, got %d", updated)
	}

	content := readTextFile(t, configPath)
	assertContains(t, content, `command = "knowns"`)
	assertContains(t, content, `args = ["mcp", "--stdio"]`)
	assertNotContains(t, content, `command = "npx"`)
}

func TestCreateInstructionFilesQuietIncludesOpenCode(t *testing.T) {
	projectRoot := t.TempDir()

	if err := createInstructionFilesQuiet(projectRoot, false); err != nil {
		t.Fatalf("createInstructionFilesQuiet returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, "OPENCODE.md")); err != nil {
		t.Fatalf("expected OPENCODE.md to be created: %v", err)
	}
}

func TestCreateInstructionFilesForCodexCreatesAgentsShimOnly(t *testing.T) {
	projectRoot := t.TempDir()

	if err := createInstructionFilesForPlatforms(projectRoot, false, []string{"codex"}); err != nil {
		t.Fatalf("createInstructionFilesForPlatforms returned error: %v", err)
	}

	assertContains(t, readTextFile(t, filepath.Join(projectRoot, "AGENTS.md")), "Compatibility entrypoint")
	if _, err := os.Stat(filepath.Join(projectRoot, "KNOWNS.md")); !os.IsNotExist(err) {
		t.Fatalf("expected KNOWNS.md not to be created, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(projectRoot, "CLAUDE.md")); !os.IsNotExist(err) {
		t.Fatalf("expected CLAUDE.md not to be created for codex-only instructions, got err=%v", err)
	}
}

func TestCreateInstructionFilesQuietDoesNotCreateKnownsMd(t *testing.T) {
	projectRoot := t.TempDir()

	if err := createInstructionFilesQuiet(projectRoot, false); err != nil {
		t.Fatalf("createInstructionFilesQuiet returned error: %v", err)
	}

	if _, err := os.Stat(filepath.Join(projectRoot, "KNOWNS.md")); !os.IsNotExist(err) {
		t.Fatalf("expected KNOWNS.md not to be created, got err=%v", err)
	}
}

func TestResolveWizardEmbeddingSourcePreservesProvider(t *testing.T) {
	ollama := &models.Project{}
	ollama.Settings.SemanticSearch = &models.SemanticSearchSettings{Provider: "ollama", Model: "qwen3-embedding:0.6b"}

	if got := resolveWizardEmbeddingSource(nil, ollama); got != "ollama" {
		t.Fatalf("expected existing project provider to win, got %q", got)
	}

	globalAPI := &storage.ProjectDefaults{}
	globalAPI.Settings.SemanticSearch = &models.SemanticSearchSettings{Provider: "api"}
	if got := resolveWizardEmbeddingSource(globalAPI, nil); got != "api" {
		t.Fatalf("expected global default provider, got %q", got)
	}
	if got := resolveWizardEmbeddingSource(globalAPI, ollama); got != "ollama" {
		t.Fatalf("expected project provider to override global default, got %q", got)
	}

	empty := &models.Project{}
	empty.Settings.SemanticSearch = &models.SemanticSearchSettings{Model: "gte-small"}
	if got := resolveWizardEmbeddingSource(nil, empty); got != "" {
		t.Fatalf("expected empty provider to stay empty so the local default applies, got %q", got)
	}
}

func TestResolveWizardChatUIPreservesToggle(t *testing.T) {
	if got := resolveWizardChatUI(nil, nil); !got {
		t.Fatalf("expected Chat UI to default to enabled, got %v", got)
	}

	disabled := false
	project := &models.Project{}
	project.Settings.EnableChatUI = &disabled
	if got := resolveWizardChatUI(nil, project); got {
		t.Fatalf("expected existing disabled Chat UI to be preserved, got %v", got)
	}

	globalDisabled := &storage.ProjectDefaults{}
	globalDisabled.Settings.EnableChatUI = &disabled
	if got := resolveWizardChatUI(globalDisabled, nil); got {
		t.Fatalf("expected global default to disable Chat UI, got %v", got)
	}

	enabled := true
	enabledProject := &models.Project{}
	enabledProject.Settings.EnableChatUI = &enabled
	if got := resolveWizardChatUI(globalDisabled, enabledProject); !got {
		t.Fatalf("expected project setting to override global default, got %v", got)
	}

	unset := &models.Project{}
	if got := resolveWizardChatUI(nil, unset); !got {
		t.Fatalf("expected unset project toggle to keep the enabled default, got %v", got)
	}
}

func TestRunInitProceedsAtWizardMinWidth(t *testing.T) {
	t.Setenv("KNOWN_LSP_AUTO_INSTALL", "0")
	home := t.TempDir()
	projectRoot := t.TempDir()
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer func() { _ = os.Chdir(oldWD) }()
	if err := os.Chdir(projectRoot); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	terminalWidthFn = func() int { return wizardMinWidth }
	isTTYFn = func() bool { return true }
	t.Cleanup(func() {
		terminalWidthFn = terminalWidth
		isTTYFn = isTTY
	})

	cmd := initCmd
	cmd.SetArgs([]string{"narrow-ok", "--no-open"})

	var stdout bytes.Buffer
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	done := make(chan struct{})
	go func() {
		_, _ = stdout.ReadFrom(r)
		close(done)
	}()

	if err := runInit(cmd, []string{"narrow-ok"}); err != nil {
		w.Close()
		<-done
		t.Fatalf("runInit returned error: %v", err)
	}
	_ = w.Close()
	<-done

	if strings.Contains(stdout.String(), "Terminal is too small") {
		t.Fatalf("expected init to proceed at %d columns, got:\n%s", wizardMinWidth, stdout.String())
	}
	if _, err := os.Stat(filepath.Join(projectRoot, ".knowns", "config.json")); err != nil {
		t.Fatalf("expected init to create config at %d columns: %v", wizardMinWidth, err)
	}
}

func TestRenderCompatibilityInstructionContentUsesMCPBootstrap(t *testing.T) {
	content := renderCompatibilityInstructionContent("AGENTS.md", "Generic AI", "/tmp/example-project")

	assertContains(t, content, "Start with Knowns MCP `initial`")
	assertNotContains(t, content, "KNOWNS.md")
	assertContains(t, content, "- Proactively capture durable memory when scope and durability are clear.")
}

func TestPlatformLabelUsesUnifiedRuntimeArtifactSummary(t *testing.T) {
	label := platformLabel("opencode")
	if !strings.Contains(label, "plugin") {
		t.Fatalf("expected OpenCode label to include plugin artifact summary, got %q", label)
	}
	label = platformLabel("codex")
	if !strings.Contains(label, ".codex/config.toml") {
		t.Fatalf("expected Codex label to include config artifact summary, got %q", label)
	}
}

func TestRuntimeInstallHelpersExposeAvailabilitySummary(t *testing.T) {
	opts := runtimeinstall.Options{
		HomeDir:        t.TempDir(),
		ExecutablePath: "/usr/local/bin/knowns",
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return "/usr/local/bin/claude", nil
			}
			return "", os.ErrNotExist
		},
	}
	if got := runtimeinstall.RuntimeAvailabilitySummary("claude-code", opts); got != "available" {
		t.Fatalf("RuntimeAvailabilitySummary = %q, want available", got)
	}
	if got := runtimeinstall.RuntimePickerDescription("opencode", opts); !strings.Contains(strings.ToLower(got), "install") {
		t.Fatalf("expected install-oriented OpenCode description, got %q", got)
	}
}

func TestWriteKnownsGitignoreGitIgnoredTracksKnowledgeSections(t *testing.T) {
	dir := t.TempDir()
	rootGitignorePath := filepath.Join(dir, ".gitignore")

	if err := os.WriteFile(rootGitignorePath, []byte("bin/\n"), 0644); err != nil {
		t.Fatalf("seed .gitignore: %v", err)
	}

	if err := writeKnownsGitignore(dir, "git-ignored", nil); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	// Root .gitignore should be unchanged (no legacy block to remove).
	rootContent := readTextFile(t, rootGitignorePath)
	if rootContent != "bin/\n" {
		t.Fatalf("root .gitignore modified unexpectedly:\n%s", rootContent)
	}

	// .knowns/.gitignore should ignore everything except tracked dirs.
	knownsGitignore := filepath.Join(dir, ".knowns", ".gitignore")
	content := readTextFile(t, knownsGitignore)
	assertContains(t, content, "*")
	assertContains(t, content, "!docs/")
	assertContains(t, content, "!docs/**")
	assertContains(t, content, "!templates/")
	assertContains(t, content, "!templates/**")
	assertContains(t, content, "!tasks/")
	assertContains(t, content, "!tasks/**")
	assertContains(t, content, "!tombstones/")
	assertContains(t, content, "!tombstones/tasks/")
	assertContains(t, content, "!tombstones/tasks/**")
	assertContains(t, content, "!decisions/")
	assertContains(t, content, "!decisions/**")
	assertContains(t, content, "!config.json")
	assertNotContains(t, content, "!memories/")
}

func TestWriteKnownsGitignoreGitTrackedRemovesManagedBlock(t *testing.T) {
	dir := t.TempDir()
	rootGitignorePath := filepath.Join(dir, ".gitignore")
	seed := strings.Join([]string{
		"bin/",
		knownsGitignoreBegin,
		".knowns/*",
		"!.knowns/docs/**",
		knownsGitignoreEnd,
		"tmp/",
	}, "\n") + "\n"

	if err := os.WriteFile(rootGitignorePath, []byte(seed), 0644); err != nil {
		t.Fatalf("seed .gitignore: %v", err)
	}

	if err := writeKnownsGitignore(dir, "git-tracked", nil); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	// Legacy block should be removed from root .gitignore.
	rootContent := readTextFile(t, rootGitignorePath)
	if want := "bin/\ntmp/\n"; rootContent != want {
		t.Fatalf("unexpected root .gitignore content:\nwant:\n%s\n got:\n%s", want, rootContent)
	}

	// .knowns/.gitignore should contain runtime/cache ignores.
	knownsGitignore := filepath.Join(dir, ".knowns", ".gitignore")
	content := readTextFile(t, knownsGitignore)
	assertContains(t, content, ".search/")
	assertContains(t, content, "runtime/")
	assertContains(t, content, ".server-port")
}

func TestWriteKnownsGitignoreNoneLeavesGitignoreUnmanaged(t *testing.T) {
	dir := t.TempDir()
	gitignorePath := filepath.Join(dir, ".gitignore")
	seed := strings.Join([]string{
		"bin/",
		knownsGitignoreBegin,
		".knowns/*",
		"!.knowns/docs/**",
		knownsGitignoreEnd,
	}, "\n") + "\n"

	if err := os.WriteFile(gitignorePath, []byte(seed), 0644); err != nil {
		t.Fatalf("seed .gitignore: %v", err)
	}

	if err := writeKnownsGitignore(dir, "none", nil); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	content := readTextFile(t, gitignorePath)
	if want := "bin/\n"; content != want {
		t.Fatalf("unexpected .gitignore content:\nwant:\n%s\n got:\n%s", want, content)
	}
}

func readJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file %s: %v", path, err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal file %s: %v", path, err)
	}

	return result
}

func readYAMLFile(t *testing.T, path string) map[string]any {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file %s: %v", path, err)
	}

	var result map[string]any
	if err := yaml.Unmarshal(data, &result); err != nil {
		t.Fatalf("unmarshal file %s: %v", path, err)
	}

	return result
}

func writeJSONFile(t *testing.T, path string, value map[string]any) {
	t.Helper()

	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}

	if err := os.WriteFile(path, append(data, '\n'), 0644); err != nil {
		t.Fatalf("write file %s: %v", path, err)
	}
}

func getMap(t *testing.T, value map[string]any, key string) map[string]any {
	t.Helper()

	result, ok := value[key].(map[string]any)
	if !ok {
		t.Fatalf("expected %q to be map[string]any, got %T", key, value[key])
	}

	return result
}

func readTextFile(t *testing.T, path string) string {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read file %s: %v", path, err)
	}

	return string(data)
}

func assertContains(t *testing.T, content, want string) {
	t.Helper()

	if !strings.Contains(content, want) {
		t.Fatalf("expected content to contain %q, got:\n%s", want, content)
	}
}

func TestWriteKnownsGitignoreTrackedWithExplicitDisabled(t *testing.T) {
	dir := t.TempDir()

	trackDocs := false
	trackMemories := true
	trackDecisions := false
	tracking := &models.GitTracking{
		Docs:      &trackDocs,
		Memories:  &trackMemories,
		Decisions: &trackDecisions,
	}

	if err := writeKnownsGitignore(dir, "git-tracked", tracking); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))

	assertContains(t, content, "docs/")
	assertContains(t, content, "decisions/")
	assertNotContains(t, content, "memories/")
	assertNotContains(t, content, "tasks/")
	assertNotContains(t, content, "templates/")
}

func TestWriteKnownsGitignoreIgnoredWithDisabledDocs(t *testing.T) {
	dir := t.TempDir()

	trackDocs := false
	tracking := &models.GitTracking{
		Docs: &trackDocs,
	}

	if err := writeKnownsGitignore(dir, "git-ignored", tracking); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))

	assertNotContains(t, content, "!docs/")
	assertContains(t, content, "!tasks/")
	assertContains(t, content, "!templates/")
	assertContains(t, content, "!decisions/")
}

func TestWriteKnownsGitignoreTaskToggleControlsTaskTombstones(t *testing.T) {
	dir := t.TempDir()
	trackTasks := false
	tracking := &models.GitTracking{Tasks: &trackTasks}

	if err := writeKnownsGitignore(dir, "git-ignored", tracking); err != nil {
		t.Fatalf("writeKnownsGitignore git-ignored: %v", err)
	}
	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))
	assertNotContains(t, content, "!tasks/")
	assertNotContains(t, content, "!tombstones/")
	assertNotContains(t, content, "!tombstones/tasks/")

	if err := writeKnownsGitignore(dir, "git-tracked", tracking); err != nil {
		t.Fatalf("writeKnownsGitignore git-tracked: %v", err)
	}
	content = readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))
	assertContains(t, content, "tasks/")
	assertContains(t, content, "tombstones/tasks/")
}

func TestWriteKnownsGitignoreIgnoredWithDisabledDecisions(t *testing.T) {
	dir := t.TempDir()

	trackDecisions := false
	tracking := &models.GitTracking{
		Decisions: &trackDecisions,
	}

	if err := writeKnownsGitignore(dir, "git-ignored", tracking); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))

	assertNotContains(t, content, "!decisions/")
	assertContains(t, content, "!tasks/")
	assertContains(t, content, "!templates/")
	assertContains(t, content, "!docs/")
}

func TestWriteKnownsGitignoreTrackedMemoriesDisabledByDefault(t *testing.T) {
	dir := t.TempDir()

	if err := writeKnownsGitignore(dir, "git-tracked", nil); err != nil {
		t.Fatalf("writeKnownsGitignore returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))

	assertContains(t, content, "memories/")
	assertNotContains(t, content, "decisions/")
	assertNotContains(t, content, "tasks/")
	assertNotContains(t, content, "docs/")
	assertNotContains(t, content, "templates/")
}

func TestSyncGitIntegrationPreservesSectionToggles(t *testing.T) {
	dir := t.TempDir()
	trackDecisions := false
	trackMemories := true
	cfg := &models.Project{
		Settings: models.ProjectSettings{
			GitTrackingMode: "git-ignored",
			GitTracking: &models.GitTracking{
				Decisions: &trackDecisions,
				Memories:  &trackMemories,
			},
		},
	}

	if err := syncGitIntegration(dir, cfg); err != nil {
		t.Fatalf("syncGitIntegration returned error: %v", err)
	}

	content := readTextFile(t, filepath.Join(dir, ".knowns", ".gitignore"))

	assertNotContains(t, content, "!decisions/")
	assertContains(t, content, "!memories/")
	assertContains(t, content, "!tasks/")
	assertContains(t, content, "!docs/")
	assertContains(t, content, "!templates/")
}

func assertNotContains(t *testing.T, content, want string) {
	t.Helper()

	if strings.Contains(content, want) {
		t.Fatalf("expected content not to contain %q, got:\n%s", want, content)
	}
}

func TestBuildSemanticSettingsDeclaresQdrantBackendAndMode(t *testing.T) {
	// Local builtin model.
	ss := buildSemanticSettings(initConfig{EnableSemantic: true, SemanticModel: "gte-small", EmbeddingSource: "local"})
	if ss == nil {
		t.Fatal("semantic settings = nil for semantic-enabled init")
	}
	if !ss.Enabled || ss.Provider != "local" || ss.Model != "gte-small" {
		t.Fatalf("semantic settings = %#v", ss)
	}
	assertVectorStoreDeclaration(t, ss.VectorStore)

	// API provider.
	ss = buildSemanticSettings(initConfig{EnableSemantic: true, SemanticModel: "openai-embedding", EmbeddingSource: "api"})
	if ss == nil || ss.Provider != "api" || ss.Model != "openai-embedding" {
		t.Fatalf("api semantic settings = %#v", ss)
	}
	assertVectorStoreDeclaration(t, ss.VectorStore)

	// Ollama provider.
	ss = buildSemanticSettings(initConfig{EnableSemantic: true, SemanticModel: "qwen3-embedding:0.6b", EmbeddingSource: "ollama"})
	if ss == nil || ss.Provider != "ollama" {
		t.Fatalf("ollama semantic settings = %#v", ss)
	}
	assertVectorStoreDeclaration(t, ss.VectorStore)

	// Semantic disabled -> nil.
	if ss := buildSemanticSettings(initConfig{EnableSemantic: false, SemanticModel: "gte-small"}); ss != nil {
		t.Fatalf("semantic settings = %#v, want nil when disabled", ss)
	}
	// No model -> nil.
	if ss := buildSemanticSettings(initConfig{EnableSemantic: true, SemanticModel: ""}); ss != nil {
		t.Fatalf("semantic settings = %#v, want nil without model", ss)
	}
}

func TestInitConfigWritesQdrantVectorStoreMetadataOnly(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("vector-defaults"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	project.Settings.SemanticSearch = buildSemanticSettings(initConfig{
		EnableSemantic:  true,
		SemanticModel:   "gte-small",
		EmbeddingSource: "local",
	})
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save: %v", err)
	}

	reloaded, err := store.Config.Load()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.Settings.SemanticSearch == nil || reloaded.Settings.SemanticSearch.VectorStore == nil {
		t.Fatalf("persisted config missing vectorStore: %#v", reloaded.Settings.SemanticSearch)
	}
	assertVectorStoreDeclaration(t, reloaded.Settings.SemanticSearch.VectorStore)

	// No vector/embedding data may be written under project .knowns.
	searchDir := filepath.Join(root, ".search")
	entries, err := os.ReadDir(searchDir)
	if err != nil {
		t.Fatalf("read .search dir: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if name == "index.db" || name == "embeddings.bin" || name == "index.json" || strings.Contains(name, "qdrant-data") {
			t.Fatalf("vector data %q found under project .knowns after init", name)
		}
	}
}

// assertVectorStoreDeclaration checks the declaration init writes: backend and
// mode only. managedRoot, install, and retention must stay unwritten so they
// keep resolving from current defaults rather than being frozen at init time.
func assertVectorStoreDeclaration(t *testing.T, vs *models.SemanticVectorStoreSettings) {
	t.Helper()
	if vs == nil {
		t.Fatal("vectorStore = nil, want declared backend and mode")
	}
	if vs.Backend != models.SemanticVectorBackendQdrant {
		t.Fatalf("vectorStore.backend = %q, want qdrant", vs.Backend)
	}
	if vs.Mode != models.SemanticVectorStoreModeManaged {
		t.Fatalf("vectorStore.mode = %q, want managed", vs.Mode)
	}
	if vs.Install != "" {
		t.Fatalf("vectorStore.install = %q, want unset so the default resolves", vs.Install)
	}
	if vs.ManagedRoot != "" {
		t.Fatalf("vectorStore.managedRoot = %q, want unset so the default resolves", vs.ManagedRoot)
	}
	if vs.Retention != nil {
		t.Fatalf("vectorStore.retention = %#v, want unset so the default resolves", vs.Retention)
	}

	// The omitted fields must still resolve to the documented defaults.
	res := models.ResolveSemanticVectorStore(
		&models.SemanticSearchSettings{Enabled: true, VectorStore: vs}, nil, nil)
	if res.ManagedRoot != models.DefaultSemanticManagedRoot {
		t.Fatalf("resolved managedRoot = %q, want %q", res.ManagedRoot, models.DefaultSemanticManagedRoot)
	}
	if res.Install != models.SemanticVectorStoreInstallLazy {
		t.Fatalf("resolved install = %q, want lazy (no install/start at init)", res.Install)
	}
	if res.Retention.PreviousGenerations == nil ||
		*res.Retention.PreviousGenerations != models.DefaultSemanticVectorRetentionGenerations ||
		res.Retention.PreviousGenerationTTL != models.DefaultSemanticVectorRetentionTTL {
		t.Fatalf("resolved retention = %#v, want defaults", res.Retention)
	}
}
