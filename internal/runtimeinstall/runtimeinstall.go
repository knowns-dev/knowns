package runtimeinstall

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const (
	StateInstalled     = "installed"
	StateMissing       = "missing"
	StateDrifted       = "drifted"
	StateMisconfigured = "misconfigured"

	HookKindNative = "native-hooks"
	HookKindPlugin = "plugin"

	managedName      = "knowns-runtime-memory"
	managedStatus    = "Knowns runtime memory"
	pluginFileName   = "knowns-runtime-memory.js"
	kiroHooksFile    = "hooks.json"
	codexHooksFile   = "hooks.json"
	claudeSettings   = "settings.json"
	opencodeConfig   = "opencode.json"
	codexConfig      = "config.toml"
	kiroMCPConfig    = "mcp.json"
	defaultHookEvent = "user-prompt-submit"
)

func runtimeHookEvent(runtime string) string {
	switch strings.TrimSpace(strings.ToLower(runtime)) {
	case "claude-code", "codex":
		return defaultHookEvent
	case "kiro":
		return "promptsubmit"
	case "opencode":
		return "session.created"
	default:
		return defaultHookEvent
	}
}

func baselineHookEvent(runtime string) string {
	switch strings.TrimSpace(strings.ToLower(runtime)) {
	case "opencode":
		return "session.created"
	default:
		return "session-start"
	}
}

func nativePromptHookKey(runtime string) (string, bool) {
	switch strings.TrimSpace(strings.ToLower(runtime)) {
	case "claude-code", "codex":
		return "UserPromptSubmit", true
	default:
		return "", false
	}
}

type Options struct {
	HomeDir        string
	ExecutablePath string
	LookPath       func(string) (string, error)
	GOOS           string
}

type Status struct {
	Runtime     string   `json:"runtime"`
	DisplayName string   `json:"displayName"`
	HookKind    string   `json:"hookKind"`
	Available   bool     `json:"available"`
	Installed   bool     `json:"installed"`
	State       string   `json:"state"`
	Summary     string   `json:"summary"`
	Paths       []string `json:"paths,omitempty"`
	Details     []string `json:"details,omitempty"`
}

type runtimeSpec struct {
	Runtime     string
	DisplayName string
	HookKind    string
	Binary      string
	Artifact    string
}

func DefaultOptions() Options {
	home, _ := os.UserHomeDir()
	exe, err := os.Executable()
	if err != nil {
		exe = "knowns"
	}
	return Options{
		HomeDir:        home,
		ExecutablePath: exe,
		LookPath:       exec.LookPath,
		GOOS:           runtime.GOOS,
	}
}

func RuntimeNames() []string {
	return []string{"claude-code", "codex", "kiro", "opencode"}
}

func Install(runtimeName string, opts Options) error {
	spec, err := lookupSpec(runtimeName)
	if err != nil {
		return err
	}
	if err := validateInstallable(spec, opts); err != nil {
		return err
	}
	switch spec.Runtime {
	case "claude-code":
		return installClaude(spec, opts)
	case "codex":
		return installCodex(spec, opts)
	case "kiro":
		return installKiro(spec, opts)
	case "opencode":
		return installOpenCode(spec, opts)
	default:
		return fmt.Errorf("unsupported runtime %q", runtimeName)
	}
}

func Uninstall(runtimeName string, opts Options) error {
	spec, err := lookupSpec(runtimeName)
	if err != nil {
		return err
	}
	switch spec.Runtime {
	case "claude-code":
		if err := uninstallClaude(spec, opts); err != nil {
			return err
		}
	case "codex":
		if err := uninstallCodex(spec, opts); err != nil {
			return err
		}
	case "kiro":
		if err := uninstallKiro(spec, opts); err != nil {
			return err
		}
	case "opencode":
		if err := uninstallOpenCode(spec, opts); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unsupported runtime %q", runtimeName)
	}
	return nil
}

func StatusAll(opts Options) ([]Status, error) {
	statuses := make([]Status, 0, len(RuntimeNames()))
	for _, name := range RuntimeNames() {
		status, err := StatusFor(name, opts)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	return statuses, nil
}

func StatusFor(runtimeName string, opts Options) (Status, error) {
	spec, err := lookupSpec(runtimeName)
	if err != nil {
		return Status{}, err
	}
	status := Status{
		Runtime:     spec.Runtime,
		DisplayName: spec.DisplayName,
		HookKind:    spec.HookKind,
		Available:   runtimeAvailable(spec, opts),
		State:       StateMissing,
		Summary:     "not installed",
	}
	switch spec.Runtime {
	case "claude-code":
		populateClaudeStatus(&status, spec, opts)
	case "codex":
		populateCodexStatus(&status, spec, opts)
	case "kiro":
		populateKiroStatus(&status, spec, opts)
	case "opencode":
		populateOpenCodeStatus(&status, spec, opts)
	default:
		return Status{}, fmt.Errorf("unsupported runtime %q", runtimeName)
	}
	return status, nil
}

func RuntimePickerLabel(runtimeName string, opts Options) string {
	spec, err := lookupSpec(runtimeName)
	if err != nil {
		return runtimeName
	}
	parts := []string{spec.DisplayName, "(" + spec.Artifact}
	if runtimeAvailable(spec, opts) {
		parts = append(parts, "Available")
	}
	return strings.Join(parts, ", ") + ")"
}

func RuntimePickerDescription(runtimeName string, opts Options) string {
	spec, err := lookupSpec(runtimeName)
	if err != nil {
		return ""
	}
	switch spec.Runtime {
	case "claude-code":
		return "Installs global native memory hooks for Claude Code"
	case "codex":
		return "Installs global native memory hooks for Codex"
	case "kiro":
		return "Installs global native memory hooks for Kiro"
	case "opencode":
		if runtimeAvailable(spec, opts) {
			return "Installs global OpenCode memory plugin"
		}
		return "Installs OpenCode, then adds the global Knowns memory plugin"
	default:
		return ""
	}
}

func RuntimeAvailabilitySummary(runtimeName string, opts Options) string {
	status, err := StatusFor(runtimeName, opts)
	if err != nil {
		return "unavailable"
	}
	switch {
	case status.Installed:
		return "installed"
	case status.Available:
		return "available"
	default:
		return "unavailable"
	}
}

func CanAutoInstall(runtimeName string) bool {
	return runtimeName == "opencode"
}

func runtimeSpecs() []runtimeSpec {
	return []runtimeSpec{
		{Runtime: "claude-code", DisplayName: "Claude Code", HookKind: HookKindNative, Binary: "claude", Artifact: "CLAUDE.md, hooks, ..."},
		{Runtime: "codex", DisplayName: "Codex", HookKind: HookKindNative, Binary: "codex", Artifact: ".codex/config.toml, hooks, ..."},
		{Runtime: "kiro", DisplayName: "Kiro IDE", HookKind: HookKindNative, Binary: "kiro", Artifact: ".kiro/hooks/*.kiro.hook"},
		{Runtime: "opencode", DisplayName: "OpenCode", HookKind: HookKindPlugin, Binary: "opencode", Artifact: "plugin, config, ..."},
	}
}

func lookupSpec(runtimeName string) (runtimeSpec, error) {
	runtimeName = strings.TrimSpace(strings.ToLower(runtimeName))
	for _, spec := range runtimeSpecs() {
		if spec.Runtime == runtimeName {
			return spec, nil
		}
	}
	return runtimeSpec{}, fmt.Errorf("unsupported runtime %q", runtimeName)
}

func validateInstallable(spec runtimeSpec, opts Options) error {
	if strings.TrimSpace(opts.HomeDir) == "" {
		return fmt.Errorf("cannot resolve home directory for %s install", spec.DisplayName)
	}
	if spec.Runtime == "opencode" {
		return nil
	}
	if runtimeAvailable(spec, opts) {
		return nil
	}
	return fmt.Errorf("%s CLI is not available in PATH", spec.DisplayName)
}

func hookCommandPath(spec runtimeSpec, opts Options) string {
	return shellCommandString(hookCommandArgs(spec, opts), opts.GOOS)
}

func hookCommandArgs(spec runtimeSpec, opts Options) []string {
	return hookCommandArgsForEvent(spec, opts, runtimeHookEvent(spec.Runtime))
}

func baselineHookCommandPath(spec runtimeSpec, opts Options) string {
	return shellCommandString(hookCommandArgsForEvent(spec, opts, baselineHookEvent(spec.Runtime)), opts.GOOS)
}

func hookCommandArgsForEvent(spec runtimeSpec, opts Options, event string) []string {
	exe := opts.ExecutablePath
	if opts.LookPath != nil {
		if _, err := opts.LookPath("knowns"); err == nil {
			exe = "knowns"
		}
	}
	return []string{exe, "runtime-memory", "hook", "--runtime", spec.Runtime, "--event", event}
}

func legacyPromptCommandPath(spec runtimeSpec, opts Options) string {
	return shellCommandString([]string{opts.ExecutablePath, "runtime-memory", "hook", "--runtime", spec.Runtime, "--event", defaultHookEvent}, opts.GOOS)
}

func shellCommandString(args []string, goos string) string {
	parts := make([]string, 0, len(args))
	for i, arg := range args {
		if i == 0 {
			arg = shellExecutablePath(arg, goos)
		}
		parts = append(parts, arg)
	}
	return strings.Join(parts, " ")
}

func shellExecutablePath(path, goos string) string {
	if goos != "windows" {
		return path
	}
	// Claude for Windows runs command hooks through bash, so backslashes in a raw
	// Windows path are treated as escapes and collapse (e.g. C:\foo -> C:foo).
	return strings.ReplaceAll(path, `\`, "/")
}

const (
	readinessHookName = "check-readiness"
)

func kiroIDEHookPath() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, ".kiro", "hooks", managedName+".kiro.hook"), nil
}

func kiroReadinessHookPath() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, ".kiro", "hooks", readinessHookName+".kiro.hook"), nil
}

func installClaude(spec runtimeSpec, opts Options) error {
	path := filepath.Join(opts.HomeDir, ".claude", claudeSettings)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	config, err := readJSONMap(path)
	if err != nil {
		return fmt.Errorf("read Claude settings: %w", err)
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		hooks = map[string]any{}
	}
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	if legacy := removeCommandHookGroup(hooks[promptKey], legacyPromptCommandPath(spec, opts)); legacy == nil {
		delete(hooks, promptKey)
	} else {
		hooks[promptKey] = legacy
	}
	setOrDeleteHookGroups(hooks, "SessionStart", removeManagedHookGroups(hooks["SessionStart"], managedStatus))
	hooks[promptKey] = removeManagedHookGroups(hooks[promptKey], managedStatus)
	hooks[promptKey] = ensureCommandHookGroup(hooks[promptKey], hookCommandPath(spec, opts), managedStatus)
	config["hooks"] = hooks
	return writeJSONMap(path, config)
}

func uninstallClaude(spec runtimeSpec, opts Options) error {
	path := filepath.Join(opts.HomeDir, ".claude", claudeSettings)
	config, err := readJSONMap(path)
	if err != nil {
		return err
	}
	hooks, _ := config["hooks"].(map[string]any)
	if hooks == nil {
		return nil
	}
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	updated := removeCommandHookGroup(hooks[promptKey], hookCommandPath(spec, opts))
	updated = removeCommandHookGroup(updated, legacyPromptCommandPath(spec, opts))
	updated = removeManagedHookGroups(updated, managedStatus)
	setOrDeleteHookGroups(hooks, promptKey, updated)
	sessionStart := removeCommandHookGroup(hooks["SessionStart"], baselineHookCommandPath(spec, opts))
	sessionStart = removeManagedHookGroups(sessionStart, managedStatus)
	setOrDeleteHookGroups(hooks, "SessionStart", sessionStart)
	if len(hooks) == 0 {
		delete(config, "hooks")
	} else {
		config["hooks"] = hooks
	}
	return writeJSONMap(path, config)
}

func populateClaudeStatus(status *Status, spec runtimeSpec, opts Options) {
	status.Paths = []string{filepath.Join(opts.HomeDir, ".claude", claudeSettings)}
	config, err := readJSONMap(filepath.Join(opts.HomeDir, ".claude", claudeSettings))
	if err != nil {
		status.State = StateMissing
		status.Summary = "helper script installed, hook config missing"
		status.Details = append(status.Details, "Claude settings missing")
		return
	}
	hooks, _ := config["hooks"].(map[string]any)
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	if hooks == nil || !hasCommandHookGroup(hooks[promptKey], hookCommandPath(spec, opts)) {
		status.State = StateDrifted
		status.Summary = "helper script present, Claude prompt hook missing"
		status.Details = append(status.Details, promptKey+" prompt-aware hook not installed")
		return
	}
	status.Installed = true
	status.State = StateInstalled
	status.Summary = "installed"
	status.Details = append(status.Details, promptKey+" prompt-aware hook installed in ~/.claude/settings.json")
}

func installCodex(spec runtimeSpec, opts Options) error {
	configPath := filepath.Join(opts.HomeDir, ".codex", codexConfig)
	hooksPath := filepath.Join(opts.HomeDir, ".codex", codexHooksFile)
	if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
		return err
	}
	configBody, err := readTextIfExists(configPath)
	if err != nil {
		return err
	}
	configBody = normalizeCodexHooksFeature(configBody)
	configBody = SetCodexMCPServer(configBody, "knowns", []string{"mcp", "--stdio"})
	if err := os.WriteFile(configPath, []byte(configBody), 0644); err != nil {
		return err
	}
	hooks, err := readJSONMap(hooksPath)
	if err != nil {
		return err
	}
	hookRoot, _ := hooks["hooks"].(map[string]any)
	if hookRoot == nil {
		hookRoot = map[string]any{}
	}
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	if legacy := removeCommandHookGroup(hookRoot[promptKey], legacyPromptCommandPath(spec, opts)); legacy == nil {
		delete(hookRoot, promptKey)
	} else {
		hookRoot[promptKey] = legacy
	}
	setOrDeleteHookGroups(hookRoot, "SessionStart", removeManagedHookGroups(hookRoot["SessionStart"], managedStatus))
	hookRoot[promptKey] = removeManagedHookGroups(hookRoot[promptKey], managedStatus)
	hookRoot[promptKey] = ensureCommandHookGroup(hookRoot[promptKey], hookCommandPath(spec, opts), managedStatus)
	hooks["hooks"] = hookRoot
	return writeJSONMap(hooksPath, hooks)
}

func uninstallCodex(spec runtimeSpec, opts Options) error {
	configPath := filepath.Join(opts.HomeDir, ".codex", codexConfig)
	hooksPath := filepath.Join(opts.HomeDir, ".codex", codexHooksFile)
	if body, err := readTextIfExists(configPath); err == nil && body != "" {
		_ = os.WriteFile(configPath, []byte(normalizeCodexHooksFeature(body)), 0644)
	}
	hooks, err := readJSONMap(hooksPath)
	if err != nil {
		return err
	}
	hookRoot, _ := hooks["hooks"].(map[string]any)
	if hookRoot == nil {
		return nil
	}
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	updated := removeCommandHookGroup(hookRoot[promptKey], hookCommandPath(spec, opts))
	updated = removeCommandHookGroup(updated, legacyPromptCommandPath(spec, opts))
	updated = removeManagedHookGroups(updated, managedStatus)
	setOrDeleteHookGroups(hookRoot, promptKey, updated)
	sessionStart := removeCommandHookGroup(hookRoot["SessionStart"], baselineHookCommandPath(spec, opts))
	sessionStart = removeManagedHookGroups(sessionStart, managedStatus)
	setOrDeleteHookGroups(hookRoot, "SessionStart", sessionStart)
	if len(hookRoot) == 0 {
		delete(hooks, "hooks")
	} else {
		hooks["hooks"] = hookRoot
	}
	return writeJSONMap(hooksPath, hooks)
}

func populateCodexStatus(status *Status, spec runtimeSpec, opts Options) {
	configPath := filepath.Join(opts.HomeDir, ".codex", codexConfig)
	hooksPath := filepath.Join(opts.HomeDir, ".codex", codexHooksFile)
	status.Paths = []string{configPath, hooksPath}
	body, err := readTextIfExists(configPath)
	if err != nil {
		status.State = StateDrifted
		status.Summary = "Codex config missing"
		status.Details = append(status.Details, "~/.codex/config.toml not found")
		return
	}
	if strings.Contains(body, "hooks = false") || strings.Contains(body, "codex_hooks = false") {
		status.State = StateDrifted
		status.Summary = "Codex hooks disabled in config"
		status.Details = append(status.Details, "hooks feature disabled")
		return
	}
	hooks, err := readJSONMap(hooksPath)
	if err != nil {
		status.State = StateDrifted
		status.Summary = "Codex hooks file missing"
		status.Details = append(status.Details, "~/.codex/hooks.json not found")
		return
	}
	hookRoot, _ := hooks["hooks"].(map[string]any)
	promptKey, _ := nativePromptHookKey(spec.Runtime)
	if hookRoot == nil || !hasCommandHookGroup(hookRoot[promptKey], hookCommandPath(spec, opts)) {
		status.State = StateDrifted
		status.Summary = "Codex feature enabled, hook missing"
		status.Details = append(status.Details, promptKey+" prompt-aware hook not installed")
		return
	}
	status.Installed = true
	status.State = StateInstalled
	status.Summary = "installed"
	status.Details = append(status.Details, promptKey+" prompt-aware hook installed in ~/.codex/hooks.json")
}

func installKiro(spec runtimeSpec, opts Options) error {
	hookPath, err := kiroIDEHookPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(hookPath), 0755); err != nil {
		return err
	}

	// Prefer bare "knowns" command when it's available in PATH,
	// so the hook stays portable across machines.
	cmdPath := "knowns"
	if _, lookErr := opts.LookPath("knowns"); lookErr != nil {
		cmdPath = opts.ExecutablePath
	}

	config := map[string]any{
		"version":     "1.0.0",
		"enabled":     true,
		"name":        managedStatus,
		"description": "Inject bounded Knowns memory when a prompt is submitted.",
		"when": map[string]any{
			"type": "promptSubmit",
		},
		"then": map[string]any{
			"type":    "runCommand",
			"command": cmdPath + " runtime-memory hook --runtime " + spec.Runtime + " --event " + runtimeHookEvent(spec.Runtime),
		},
	}
	if err := writeJSONMap(hookPath, config); err != nil {
		return err
	}

	return nil
}

func uninstallKiro(spec runtimeSpec, opts Options) error {
	hookPath, err := kiroIDEHookPath()
	if err != nil {
		return err
	}
	if err := os.Remove(hookPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func populateKiroStatus(status *Status, spec runtimeSpec, opts Options) {
	hookPath, err := kiroIDEHookPath()
	if err != nil {
		status.State = StateDrifted
		status.Summary = "Kiro workspace hook path unavailable"
		status.Details = append(status.Details, err.Error())
		return
	}
	mcpPath := filepath.Join(opts.HomeDir, ".kiro", "settings", kiroMCPConfig)
	status.Paths = []string{hookPath, mcpPath}
	config, err := readJSONMap(hookPath)
	if err != nil {
		status.State = StateDrifted
		status.Summary = "Kiro IDE hook file missing"
		status.Details = append(status.Details, filepath.Base(hookPath)+" not found in workspace .kiro/hooks")
		return
	}
	when, _ := config["when"].(map[string]any)
	then, _ := config["then"].(map[string]any)
	cmd := stringValue(then["command"])
	expectedSuffix := "runtime-memory hook --runtime " + spec.Runtime + " --event " + runtimeHookEvent(spec.Runtime)
	if stringValue(when["type"]) == "promptSubmit" && strings.EqualFold(stringValue(then["type"]), "runCommand") && strings.HasSuffix(cmd, expectedSuffix) {
		status.Installed = true
		status.State = StateInstalled
		status.Summary = "installed"
		status.Details = append(status.Details, "promptSubmit prompt-aware hook installed in workspace .kiro/hooks/knowns-runtime-memory.kiro.hook")
		return
	}
	status.State = StateDrifted
	status.Summary = "Kiro hook config missing"
	status.Details = append(status.Details, "promptSubmit runCommand hook not installed")
}

func installOpenCode(spec runtimeSpec, opts Options) error {
	configPath := filepath.Join(opts.HomeDir, ".config", "opencode", opencodeConfig)
	pluginPath := filepath.Join(opts.HomeDir, ".config", "opencode", "plugins", pluginFileName)
	if err := os.MkdirAll(filepath.Dir(pluginPath), 0755); err != nil {
		return err
	}
	config, err := readJSONMap(configPath)
	if err != nil {
		return fmt.Errorf("read OpenCode config: %w", err)
	}
	config["$schema"] = "https://opencode.ai/config.json"

	// Ensure MCP config with correct format
	mcp, _ := config["mcp"].(map[string]any)
	if mcp == nil {
		mcp = make(map[string]any)
	}
	mcp["knowns"] = map[string]any{
		"type":    "local",
		"command": []string{"knowns", "mcp", "--stdio"},
		"enabled": true,
	}
	config["mcp"] = mcp

	if err := writeJSONMap(configPath, config); err != nil {
		return err
	}
	return os.WriteFile(pluginPath, []byte(renderOpenCodePlugin(opts)), 0644)
}

func uninstallOpenCode(spec runtimeSpec, opts Options) error {
	pluginPath := filepath.Join(opts.HomeDir, ".config", "opencode", "plugins", pluginFileName)
	if err := os.Remove(pluginPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func populateOpenCodeStatus(status *Status, spec runtimeSpec, opts Options) {
	configPath := filepath.Join(opts.HomeDir, ".config", "opencode", opencodeConfig)
	pluginPath := filepath.Join(opts.HomeDir, ".config", "opencode", "plugins", pluginFileName)
	status.Paths = []string{configPath, pluginPath}
	if !fileExists(pluginPath) {
		status.Details = append(status.Details, "global plugin file missing")
		return
	}
	status.Installed = true
	status.State = StateInstalled
	status.Summary = "installed"
	if fileExists(configPath) {
		status.Details = append(status.Details, "session-created baseline plugin installed in ~/.config/opencode/plugins")
	} else {
		status.Details = append(status.Details, "session-created baseline plugin installed; global OpenCode config not present")
	}
}

func renderOpenCodePlugin(opts Options) string {
	exe := escapeJSString(opts.ExecutablePath)
	return strings.Join([]string{
		"// managed-by: knowns",
		"import { execFileSync } from \"node:child_process\"",
		"import { appendFileSync, mkdirSync } from \"node:fs\"",
		"import { join } from \"node:path\"",
		"",
		"export const KnownsRuntimeMemoryPlugin = async ({ client }) => {",
		"  const injectedSessions = new Set()",
		"  const debugEnabled = process.env.KNOWNS_RUNTIME_DEBUG === \"1\"",
		"  const logPath = join(process.env.HOME || process.cwd(), \".knowns\", \"runtime\", \"opencode-runtime-memory.log\")",
		"  const log = (message, extra) => {",
		"    if (!debugEnabled) return",
		"    try {",
		"      mkdirSync(join(process.env.HOME || process.cwd(), \".knowns\", \"runtime\"), { recursive: true })",
		"      const suffix = extra ? ` ${JSON.stringify(extra)}` : \"\"",
		"      appendFileSync(logPath, `[${new Date().toISOString()}] ${message}${suffix}\\n`)",
		"    } catch (_) {",
		"    }",
		"  }",
		"  log(\"plugin initialized\")",
		"  await client.app.log({ body: { service: \"knowns-runtime-memory\", level: \"info\", message: \"OpenCode runtime memory plugin initialized\" } })",
		"  return {",
		"    event: async ({ event }) => {",
		"      log(\"event received\", { type: event?.type })",
		"      if (!event || event.type !== \"session.created\") return",
		"      try {",
		"        const props = event.properties || {}",
		"        const sessionID = props.sessionID || props.sessionId || props.id || props.session?.id",
		"        log(\"session.created parsed\", { sessionID })",
		"        if (!sessionID || injectedSessions.has(sessionID)) return",
		"        const cwd = props.cwd || process.cwd()",
		"        const result = execFileSync(\"" + exe + "\", [\"runtime-memory\", \"hook\", \"--runtime\", \"opencode\", \"--event\", \"session.created\"], {",
		"          cwd,",
		"          env: { ...process.env },",
		"        }).toString().trim()",
		"        log(\"knowns hook returned\", { resultLength: result.length })",
		"        if (!result) return",
		"        injectedSessions.add(sessionID)",
		"        await client.session.prompt({",
		"          path: { id: sessionID },",
		"          body: {",
		"            noReply: true,",
		"            parts: [{ type: \"text\", text: result }],",
		"          },",
		"        })",
		"        log(\"session baseline injected\", { sessionID })",
		"      } catch (error) {",
		"        log(\"injection failed\", { error: String(error) })",
		"        await client.app.log({ body: { service: \"knowns-runtime-memory\", level: \"warn\", message: \"OpenCode runtime memory injection failed\", extra: { error: String(error) } } })",
		"      }",
		"    },",
		"  }",
		"}",
		"",
	}, "\n")
}

func runtimeAvailable(spec runtimeSpec, opts Options) bool {
	if opts.LookPath == nil {
		return false
	}
	_, err := opts.LookPath(spec.Binary)
	return err == nil
}

func readJSONMap(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return map[string]any{}, nil
		}
		return nil, err
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return map[string]any{}, nil
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	return value, nil
}

func writeJSONMap(path string, value map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func setOrDeleteHookGroups(hooks map[string]any, key string, groups []any) {
	if groups == nil {
		delete(hooks, key)
		return
	}
	hooks[key] = groups
}

func ensureCommandHookGroup(existing any, commandPath, statusMessage string) []any {
	groups, _ := existing.([]any)
	group := map[string]any{
		"hooks": []any{
			map[string]any{
				"type":          "command",
				"command":       commandPath,
				"statusMessage": statusMessage,
			},
		},
	}
	if hasCommandHookGroup(existing, commandPath) {
		updated := make([]any, 0, len(groups))
		for _, raw := range groups {
			item, _ := raw.(map[string]any)
			if commandHookGroupMatches(item, commandPath) {
				updated = append(updated, group)
				continue
			}
			updated = append(updated, raw)
		}
		return updated
	}
	return append(groups, group)
}

func hasCommandHookGroup(existing any, commandPath string) bool {
	groups, _ := existing.([]any)
	for _, raw := range groups {
		group, _ := raw.(map[string]any)
		if commandHookGroupMatches(group, commandPath) {
			return true
		}
	}
	return false
}

func removeCommandHookGroup(existing any, commandPath string) []any {
	groups, _ := existing.([]any)
	if len(groups) == 0 {
		return nil
	}
	filtered := make([]any, 0, len(groups))
	for _, raw := range groups {
		group, _ := raw.(map[string]any)
		if commandHookGroupMatches(group, commandPath) {
			continue
		}
		filtered = append(filtered, raw)
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}

// removeManagedHookGroups removes all hook groups whose statusMessage matches,
// regardless of the command path. This cleans up stale hooks from older installs
// that used different executable paths (e.g. temp test binaries, absolute paths).
func removeManagedHookGroups(existing any, statusMessage string) []any {
	groups, _ := existing.([]any)
	if len(groups) == 0 {
		return nil
	}
	filtered := make([]any, 0, len(groups))
	for _, raw := range groups {
		group, _ := raw.(map[string]any)
		if hookGroupHasStatus(group, statusMessage) {
			continue
		}
		filtered = append(filtered, raw)
	}
	if len(filtered) == 0 {
		return nil
	}
	return filtered
}

func hookGroupHasStatus(group map[string]any, statusMessage string) bool {
	hooks, _ := group["hooks"].([]any)
	for _, raw := range hooks {
		hook, _ := raw.(map[string]any)
		if strings.TrimSpace(stringValue(hook["statusMessage"])) == statusMessage {
			return true
		}
	}
	return false
}

func commandHookGroupMatches(group map[string]any, commandPath string) bool {
	hooks, _ := group["hooks"].([]any)
	for _, raw := range hooks {
		hook, _ := raw.(map[string]any)
		if strings.TrimSpace(stringValue(hook["command"])) == commandPath {
			return true
		}
	}
	return false
}

func kiroHookCommand(entry map[string]any) string {
	if command := stringValue(entry["command"]); command != "" {
		return command
	}
	action, _ := entry["action"].(map[string]any)
	return stringValue(action["command"])
}

func normalizeCodexHooksFeature(body string) string {
	lines := strings.Split(body, "\n")
	featuresStart := -1
	featuresEnd := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[features]" {
			featuresStart = i
			featuresEnd = len(lines)
			for j := i + 1; j < len(lines); j++ {
				t := strings.TrimSpace(lines[j])
				if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
					featuresEnd = j
					break
				}
			}
			break
		}
	}
	if featuresStart == -1 {
		return body
	}

	hasHooks := false
	hasCodexHooks := false
	codexHooksDisabled := false
	featureLines := make([]string, 0, featuresEnd-featuresStart-1)
	for i := featuresStart + 1; i < featuresEnd; i++ {
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, "hooks =") {
			hasHooks = true
		}
		if strings.HasPrefix(trimmed, "codex_hooks =") {
			hasCodexHooks = true
			codexHooksDisabled = strings.EqualFold(strings.TrimSpace(strings.TrimPrefix(trimmed, "codex_hooks =")), "false")
			continue
		}
		featureLines = append(featureLines, lines[i])
	}

	if !hasCodexHooks {
		return body
	}
	if codexHooksDisabled && !hasHooks {
		featureLines = append(featureLines, "hooks = false")
	}

	result := make([]string, 0, len(lines))
	result = append(result, lines[:featuresStart+1]...)
	result = append(result, featureLines...)
	result = append(result, lines[featuresEnd:]...)
	return strings.Join(result, "\n")
}

func SetCodexMCPServer(body, command string, args []string) string {
	body = normalizeCodexHooksFeature(body)
	lines := strings.Split(body, "\n")
	sectionStart := -1
	sectionEnd := len(lines)
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[mcp_servers.knowns]" {
			sectionStart = i
			for j := i + 1; j < len(lines); j++ {
				t := strings.TrimSpace(lines[j])
				if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
					sectionEnd = j
					break
				}
			}
			break
		}
	}

	newSection := []string{
		"[mcp_servers.knowns]",
		fmt.Sprintf("command = %q", command),
		fmt.Sprintf("args = [%s]", joinQuotedTOML(args)),
	}

	if sectionStart == -1 {
		body = strings.TrimRight(body, "\n")
		if body != "" {
			body += "\n\n"
		}
		return body + strings.Join(newSection, "\n") + "\n"
	}

	replacement := append([]string{}, lines[:sectionStart]...)
	replacement = append(replacement, newSection...)
	replacement = append(replacement, lines[sectionEnd:]...)
	return strings.Join(replacement, "\n")
}

func joinQuotedTOML(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, fmt.Sprintf("%q", value))
	}
	return strings.Join(quoted, ", ")
}

func readTextIfExists(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	return string(data), nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func stringValue(v any) string {
	s, _ := v.(string)
	return s
}

func escapeShellArg(value string) string {
	return strings.ReplaceAll(value, `"`, `\"`)
}

func escapeJSString(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return value
}

func SortStatuses(statuses []Status) {
	sort.Slice(statuses, func(i, j int) bool {
		return statuses[i].Runtime < statuses[j].Runtime
	})
}
