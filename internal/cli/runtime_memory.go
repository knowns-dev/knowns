package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/runtimememory"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

// newRuntimeMemoryHookCmd builds a fresh hook command. Two identical instances
// are registered — one under `knowns runtime memory`, one under the original
// top-level `knowns runtime-memory` — because a cobra.Command can only have one
// parent, and the old path must keep working: it is baked into every hook
// script, OpenCode plugin, and Kiro hook file that runtimeinstall has already
// written to users' machines.
func newRuntimeMemoryHookCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "hook",
		Short: "Build a runtime memory payload for adapter hooks",
		RunE:  runRuntimeMemoryHook,
	}
	c.Flags().String("runtime", "", "Runtime adapter name")
	c.Flags().String("event", "", "Hook event name")
	c.Flags().String("project", "", "Project root (defaults to detected project)")
	c.Flags().String("cwd", "", "Working directory for scoring context")
	c.Flags().String("mode", "", "Override runtime memory mode")
	c.Flags().String("capture", "", "Override runtime memory capture mode")
	c.Flags().Int("max-items", 0, "Override maximum number of memory items")
	c.Flags().Int("max-bytes", 0, "Override maximum serialized bytes")
	return c
}

func runRuntimeMemoryHook(cmd *cobra.Command, args []string) error {
	runtimeName, _ := cmd.Flags().GetString("runtime")
	eventName, _ := cmd.Flags().GetString("event")
	projectRoot, _ := cmd.Flags().GetString("project")
	mode, _ := cmd.Flags().GetString("mode")
	capture, _ := cmd.Flags().GetString("capture")
	workingDir, _ := cmd.Flags().GetString("cwd")
	maxItems, _ := cmd.Flags().GetInt("max-items")
	maxBytes, _ := cmd.Flags().GetInt("max-bytes")

	if strings.TrimSpace(runtimeName) == "" {
		return fmt.Errorf("--runtime is required")
	}
	if strings.TrimSpace(eventName) == "" {
		return fmt.Errorf("--event is required")
	}
	if workingDir == "" {
		workingDir, _ = os.Getwd()
	}
	if projectRoot == "" && workingDir != "" {
		if root, err := storage.FindProjectRoot(workingDir); err == nil {
			projectRoot = filepath.Dir(root)
		}
	}
	if projectRoot == "" {
		return nil
	}

	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	settings := runtimememory.NormalizeSettings(nil)
	if project, err := store.Config.Load(); err == nil {
		settings = runtimememory.NormalizeSettings(project.Settings.RuntimeMemory)
	}
	if normalized := runtimememory.NormalizeMode(mode); normalized != "" {
		settings.Mode = normalized
	}
	if strings.TrimSpace(capture) != "" {
		settings.Capture = runtimememory.NormalizeCaptureMode(capture)
	}
	if maxItems > 0 {
		settings.MaxItems = maxItems
	}
	if maxBytes > 0 {
		settings.MaxBytes = maxBytes
	}
	prompt, err := runtimeMemoryPrompt()
	if err != nil {
		return err
	}
	input := runtimememory.Input{
		Runtime:     runtimeName,
		ProjectRoot: projectRoot,
		WorkingDir:  workingDir,
		ActionType:  eventName,
		UserPrompt:  prompt,
		Mode:        settings.Mode,
		Capture:     settings.Capture,
		MaxItems:    settings.MaxItems,
		MaxBytes:    settings.MaxBytes,
	}
	pack, err := runtimememory.Build(store, input)
	if err != nil {
		return err
	}
	if _, outcome, err := runtimememory.CaptureWithOutcome(store, input); err != nil {
		return err
	} else {
		pack.Capture = &outcome
	}
	if isJSON(cmd) {
		data, err := json.MarshalIndent(pack, "", "  ")
		if err != nil {
			return err
		}
		fmt.Fprintln(cmd.OutOrStdout(), string(data))
		return nil
	}
	if strings.TrimSpace(pack.Serialized) == "" {
		return nil
	}
	fmt.Fprintln(cmd.OutOrStdout(), pack.Serialized)
	return nil
}

func runtimeMemoryPrompt() (string, error) {
	if prompt := strings.TrimSpace(os.Getenv("KNOWNS_RUNTIME_PROMPT")); prompt != "" {
		return prompt, nil
	}
	if prompt := strings.TrimSpace(os.Getenv("USER_PROMPT")); prompt != "" {
		return prompt, nil
	}
	body, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return "", nil
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil {
		if prompt := strings.TrimSpace(stringFromMap(payload, "prompt", "text", "message")); prompt != "" {
			return prompt, nil
		}
	}
	return trimmed, nil
}

func stringFromMap(payload map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func init() {
	// Discoverable path: `knowns runtime memory hook`, grouped under the noun
	// it belongs to instead of sitting beside it as a second top-level command.
	runtimeMemoryCmd := &cobra.Command{
		Use:   "memory",
		Short: "Manage runtime memory hook behavior",
	}
	runtimeMemoryCmd.AddCommand(newRuntimeMemoryHookCmd())
	runtimeCmd.AddCommand(runtimeMemoryCmd)

	// Compatibility path: `knowns runtime-memory hook`, kept runnable for hooks
	// already installed. Its retirement schedule lives in lifecycle.go, which
	// also hides it from help.
	legacy := &cobra.Command{
		Use:   "runtime-memory",
		Short: "Manage runtime memory hook behavior (use \"knowns runtime memory\")",
	}
	legacy.AddCommand(newRuntimeMemoryHookCmd())
	rootCmd.AddCommand(legacy)
}
