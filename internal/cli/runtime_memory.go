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

var runtimeMemoryCmd = &cobra.Command{
	Use:   "runtime-memory",
	Short: "Manage runtime memory hook behavior",
}

var runtimeMemoryHookCmd = &cobra.Command{
	Use:   "hook",
	Short: "Build a runtime memory payload for adapter hooks",
	RunE:  runRuntimeMemoryHook,
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
	runtimeMemoryHookCmd.Flags().String("runtime", "", "Runtime adapter name")
	runtimeMemoryHookCmd.Flags().String("event", "", "Hook event name")
	runtimeMemoryHookCmd.Flags().String("project", "", "Project root (defaults to detected project)")
	runtimeMemoryHookCmd.Flags().String("cwd", "", "Working directory for scoring context")
	runtimeMemoryHookCmd.Flags().String("mode", "", "Override runtime memory mode")
	runtimeMemoryHookCmd.Flags().String("capture", "", "Override runtime memory capture mode")
	runtimeMemoryHookCmd.Flags().Int("max-items", 0, "Override maximum number of memory items")
	runtimeMemoryHookCmd.Flags().Int("max-bytes", 0, "Override maximum serialized bytes")
	runtimeMemoryCmd.AddCommand(runtimeMemoryHookCmd)
	rootCmd.AddCommand(runtimeMemoryCmd)
}
