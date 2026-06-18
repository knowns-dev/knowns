package runtimeinstall

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallClaudeMergesExistingSettingsAndStatus(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		t.Fatalf("mkdir claude: %v", err)
	}
	settings := `{
  "theme": "dark",
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "/tmp/existing.sh"}]}]
  }
}`
	if err := os.WriteFile(filepath.Join(claudeDir, claudeSettings), []byte(settings), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	opts := Options{
		HomeDir:        home,
		ExecutablePath: "/usr/local/bin/knowns",
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return "/usr/local/bin/claude", nil
			}
			return "", os.ErrNotExist
		},
	}
	if err := Install("claude-code", opts); err != nil {
		t.Fatalf("install claude: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(claudeDir, claudeSettings))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	text := string(body)
	if !strings.Contains(text, `"theme": "dark"`) {
		t.Fatalf("expected existing setting preserved, got:\n%s", text)
	}
	if !strings.Contains(text, `"UserPromptSubmit"`) {
		t.Fatalf("expected UserPromptSubmit hook added, got:\n%s", text)
	}
	status, err := StatusFor("claude-code", opts)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Installed || status.State != StateInstalled {
		t.Fatalf("unexpected status: %+v", status)
	}
	if !strings.Contains(strings.Join(status.Details, "\n"), "UserPromptSubmit prompt-aware hook installed") {
		t.Fatalf("expected prompt-aware status detail, got: %+v", status.Details)
	}
}

func TestInstallClaudeWindowsQuotesExecutableForBashHooks(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		t.Fatalf("mkdir claude: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, claudeSettings), []byte(`{"hooks":{}}`), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	exePath := `C:\Users\Admin\.knowns\bin\knowns.exe`
	opts := Options{
		HomeDir:        home,
		ExecutablePath: exePath,
		GOOS:           "windows",
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return `C:\Users\Admin\AppData\Local\Programs\Claude\claude.exe`, nil
			}
			return "", os.ErrNotExist
		},
	}
	if err := Install("claude-code", opts); err != nil {
		t.Fatalf("install claude windows: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(claudeDir, claudeSettings))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	text := string(body)
	expectedExe := strings.ReplaceAll(exePath, `\`, "/")
	if !strings.Contains(text, expectedExe) {
		t.Fatalf("expected slash-normalized executable path, got:\n%s", text)
	}
	if !strings.Contains(text, "runtime-memory hook --runtime claude-code --event user-prompt-submit") {
		t.Fatalf("expected runtime-memory hook args, got:\n%s", text)
	}
}

func TestInstallClaudeWindowsWritesExactPromptSubmitHookJSON(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0755); err != nil {
		t.Fatalf("mkdir claude: %v", err)
	}
	if err := os.WriteFile(filepath.Join(claudeDir, claudeSettings), []byte(`{"hooks":{}}`), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	exePath := `C:\Users\Admin\.knowns\bin\knowns.exe`
	opts := Options{
		HomeDir:        home,
		ExecutablePath: exePath,
		GOOS:           "windows",
		LookPath: func(name string) (string, error) {
			if name == "claude" {
				return `C:\Users\Admin\AppData\Local\Programs\Claude\claude.exe`, nil
			}
			return "", os.ErrNotExist
		},
	}
	if err := Install("claude-code", opts); err != nil {
		t.Fatalf("install claude windows: %v", err)
	}

	body, err := os.ReadFile(filepath.Join(claudeDir, claudeSettings))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}

	var settings map[string]any
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatalf("unmarshal settings: %v\n%s", err, string(body))
	}
	hooks, ok := settings["hooks"].(map[string]any)
	if !ok {
		t.Fatalf("expected hooks object, got: %#v", settings["hooks"])
	}
	if _, ok := hooks["SessionStart"]; ok {
		t.Fatalf("expected no SessionStart managed hook for prompt-aware Claude, got: %#v", hooks["SessionStart"])
	}
	userPromptSubmit, ok := hooks["UserPromptSubmit"].([]any)
	if !ok || len(userPromptSubmit) != 1 {
		t.Fatalf("expected one UserPromptSubmit hook group, got: %#v", hooks["UserPromptSubmit"])
	}
	group, ok := userPromptSubmit[0].(map[string]any)
	if !ok {
		t.Fatalf("expected UserPromptSubmit group object, got: %#v", userPromptSubmit[0])
	}
	groupHooks, ok := group["hooks"].([]any)
	if !ok || len(groupHooks) != 1 {
		t.Fatalf("expected one hook entry, got: %#v", group["hooks"])
	}
	hook, ok := groupHooks[0].(map[string]any)
	if !ok {
		t.Fatalf("expected hook object, got: %#v", groupHooks[0])
	}

	expectedCommand := strings.ReplaceAll(exePath, `\`, "/") + " runtime-memory hook --runtime claude-code --event user-prompt-submit"
	if got := hook["command"]; got != expectedCommand {
		t.Fatalf("unexpected command\nwant: %q\n got: %q", expectedCommand, got)
	}
	if got := hook["type"]; got != "command" {
		t.Fatalf("unexpected hook type: %#v", got)
	}
	if got := hook["statusMessage"]; got != managedStatus {
		t.Fatalf("unexpected statusMessage: %#v", got)
	}
}

func TestInstallCodexNormalizesDeprecatedFeatureAndUninstallRemovesManagedHookOnly(t *testing.T) {
	home := t.TempDir()
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0755); err != nil {
		t.Fatalf("mkdir codex: %v", err)
	}
	seedConfig := strings.Join([]string{
		"model = \"gpt-5.4\"",
		"",
		"[features]",
		"codex_hooks = true",
	}, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(codexDir, codexConfig), []byte(seedConfig), 0644); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	hooks := `{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/tmp/existing-hook.sh"}]},
      {"hooks": [{"type": "command", "command": "/tmp/old-knowns runtime-memory hook --runtime codex --event session-start", "statusMessage": "Knowns runtime memory"}]}
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(codexDir, codexHooksFile), []byte(hooks), 0644); err != nil {
		t.Fatalf("seed hooks: %v", err)
	}

	opts := Options{
		HomeDir:        home,
		ExecutablePath: "/usr/local/bin/knowns",
		LookPath: func(name string) (string, error) {
			if name == "codex" {
				return "/usr/local/bin/codex", nil
			}
			return "", os.ErrNotExist
		},
	}
	if err := Install("codex", opts); err != nil {
		t.Fatalf("install codex: %v", err)
	}
	configBody, err := os.ReadFile(filepath.Join(codexDir, codexConfig))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(configBody), "hooks = true") {
		t.Fatalf("expected hooks=true not to be added because hooks are enabled by default, got:\n%s", string(configBody))
	}
	if strings.Contains(string(configBody), "codex_hooks") {
		t.Fatalf("expected deprecated codex_hooks flag to be absent, got:\n%s", string(configBody))
	}
	hooksBody, err := os.ReadFile(filepath.Join(codexDir, codexHooksFile))
	if err != nil {
		t.Fatalf("read hooks after install: %v", err)
	}
	text := string(hooksBody)
	if !strings.Contains(text, `"UserPromptSubmit"`) {
		t.Fatalf("expected Codex UserPromptSubmit hook, got:\n%s", text)
	}
	if !strings.Contains(text, "runtime-memory hook --runtime codex --event user-prompt-submit") {
		t.Fatalf("expected Codex prompt-aware hook command, got:\n%s", text)
	}
	if !strings.Contains(text, "/tmp/existing-hook.sh") {
		t.Fatalf("expected unrelated SessionStart hook preserved after install, got:\n%s", text)
	}
	if strings.Contains(text, "/tmp/old-knowns") || strings.Contains(text, "--event session-start") {
		t.Fatalf("expected stale managed SessionStart hook removed after install, got:\n%s", text)
	}
	status, err := StatusFor("codex", opts)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Installed || status.State != StateInstalled {
		t.Fatalf("unexpected status: %+v", status)
	}
	if !strings.Contains(strings.Join(status.Details, "\n"), "UserPromptSubmit prompt-aware hook installed") {
		t.Fatalf("expected prompt-aware status detail, got: %+v", status.Details)
	}
	if err := Uninstall("codex", opts); err != nil {
		t.Fatalf("uninstall codex: %v", err)
	}
	configBody, err = os.ReadFile(filepath.Join(codexDir, codexConfig))
	if err != nil {
		t.Fatalf("read config after uninstall: %v", err)
	}
	if strings.Contains(string(configBody), "hooks = false") {
		t.Fatalf("expected uninstall not to disable all Codex hooks, got:\n%s", string(configBody))
	}
	if strings.Contains(string(configBody), "codex_hooks") {
		t.Fatalf("expected deprecated codex_hooks flag to remain absent after uninstall, got:\n%s", string(configBody))
	}
	hooksBody, err = os.ReadFile(filepath.Join(codexDir, codexHooksFile))
	if err != nil {
		t.Fatalf("read hooks after uninstall: %v", err)
	}
	text = string(hooksBody)
	if !strings.Contains(text, "/tmp/existing-hook.sh") {
		t.Fatalf("expected unrelated hook preserved, got:\n%s", text)
	}
	if strings.Contains(text, `"UserPromptSubmit"`) {
		t.Fatalf("expected legacy UserPromptSubmit hook removed, got:\n%s", text)
	}
	if strings.Contains(text, managedStatus) {
		t.Fatalf("expected managed hook removed, got:\n%s", text)
	}
}

func TestNormalizeCodexHooksFeaturePreservesDeprecatedDisableIntent(t *testing.T) {
	body := strings.Join([]string{
		"model = \"gpt-5.4\"",
		"",
		"[features]",
		"codex_hooks = false",
		"",
		"[mcp_servers.knowns]",
		"command = \"knowns\"",
	}, "\n") + "\n"

	normalized := normalizeCodexHooksFeature(body)
	if strings.Contains(normalized, "codex_hooks") {
		t.Fatalf("expected deprecated codex_hooks flag removed, got:\n%s", normalized)
	}
	if !strings.Contains(normalized, "hooks = false") {
		t.Fatalf("expected disabled hook intent preserved with canonical hooks=false, got:\n%s", normalized)
	}
}

func TestInstallOpenCodeCreatesPluginAndStatusInstalled(t *testing.T) {
	home := t.TempDir()
	opts := Options{
		HomeDir:        home,
		ExecutablePath: "/usr/local/bin/knowns",
		LookPath:       func(string) (string, error) { return "", os.ErrNotExist },
	}
	if err := Install("opencode", opts); err != nil {
		t.Fatalf("install opencode: %v", err)
	}
	pluginPath := filepath.Join(home, ".config", "opencode", "plugins", pluginFileName)
	plugin, err := os.ReadFile(pluginPath)
	if err != nil {
		t.Fatalf("read plugin: %v", err)
	}
	if !strings.Contains(string(plugin), "runtime-memory") {
		t.Fatalf("expected runtime-memory hook command in plugin, got:\n%s", string(plugin))
	}
	if !strings.Contains(string(plugin), "\"--event\", \"session.created\"") {
		t.Fatalf("expected session-created baseline event in plugin, got:\n%s", string(plugin))
	}
	if strings.Contains(string(plugin), "user-prompt-submit") {
		t.Fatalf("expected OpenCode to keep baseline plugin behavior, got:\n%s", string(plugin))
	}
	status, err := StatusFor("opencode", opts)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Installed || status.State != StateInstalled {
		t.Fatalf("unexpected status: %+v", status)
	}
	if !strings.Contains(strings.Join(status.Details, "\n"), "session-created baseline plugin installed") {
		t.Fatalf("expected baseline plugin status detail, got: %+v", status.Details)
	}
}

func TestInstallKiroCreatesWorkspaceIDEHook(t *testing.T) {
	home := t.TempDir()
	project := t.TempDir()
	if err := os.MkdirAll(filepath.Join(project, ".kiro"), 0755); err != nil {
		t.Fatalf("mkdir project .kiro: %v", err)
	}
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	defer func() { _ = os.Chdir(oldWD) }()
	if err := os.Chdir(project); err != nil {
		t.Fatalf("chdir project: %v", err)
	}

	opts := Options{
		HomeDir:        home,
		ExecutablePath: "/new/bin/knowns",
		LookPath: func(name string) (string, error) {
			if name == "kiro" {
				return "/usr/local/bin/kiro", nil
			}
			return "", os.ErrNotExist
		},
	}
	if err := Install("kiro", opts); err != nil {
		t.Fatalf("install kiro: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(project, ".kiro", "hooks", managedName+".kiro.hook"))
	if err != nil {
		t.Fatalf("read IDE hook: %v", err)
	}
	text := string(body)
	if !strings.Contains(text, `"type": "promptSubmit"`) {
		t.Fatalf("expected promptSubmit trigger, got:\n%s", text)
	}
	if !strings.Contains(text, `"type": "runCommand"`) {
		t.Fatalf("expected runCommand action, got:\n%s", text)
	}
	if !strings.Contains(text, "runtime-memory hook --runtime kiro --event promptsubmit") {
		t.Fatalf("expected runtime-memory hook command, got:\n%s", text)
	}
	status, err := StatusFor("kiro", opts)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.Installed || status.State != StateInstalled {
		t.Fatalf("unexpected status: %+v", status)
	}
	if !strings.Contains(strings.Join(status.Details, "\n"), "promptSubmit prompt-aware hook installed") {
		t.Fatalf("expected prompt-aware Kiro status detail, got: %+v", status.Details)
	}
}

func TestRuntimePickerLabelIncludesAvailabilityForSupportedRuntimes(t *testing.T) {
	opts := Options{
		HomeDir:        t.TempDir(),
		ExecutablePath: "/usr/local/bin/knowns",
		LookPath: func(name string) (string, error) {
			if name == "codex" {
				return "/usr/local/bin/codex", nil
			}
			return "", os.ErrNotExist
		},
	}
	label := RuntimePickerLabel("codex", opts)
	if !strings.Contains(label, "Available") {
		t.Fatalf("expected availability in label, got %q", label)
	}
	desc := RuntimePickerDescription("opencode", opts)
	if !strings.Contains(desc, "installs OpenCode") && !strings.Contains(strings.ToLower(desc), "installs opencode") {
		t.Fatalf("expected auto-install description, got %q", desc)
	}
}
