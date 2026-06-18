package cli

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/runtimememory"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/spf13/cobra"
)

func TestRuntimeMemoryHookModeOffPlainSilentAndSkipsCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_PROMPT", "toi muon AI tu luu memory, khong doi toi nhac moi them")
	projectRoot, store := setupRuntimeMemoryHookStore(t)
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "decision",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	var out bytes.Buffer
	cmd := newRuntimeMemoryHookTestCmd(&out, false)
	setRuntimeMemoryHookFlag(t, cmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, cmd, "mode", runtimememory.ModeOff)

	if err := runRuntimeMemoryHook(cmd, nil); err != nil {
		t.Fatalf("run hook: %v", err)
	}
	if out.String() != "" {
		t.Fatalf("plain output = %q, want silence", out.String())
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want no auto-capture in mode off", len(entries))
	}

	out.Reset()
	jsonCmd := newRuntimeMemoryHookTestCmd(&out, true)
	setRuntimeMemoryHookFlag(t, jsonCmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, jsonCmd, "mode", runtimememory.ModeOff)
	if err := runRuntimeMemoryHook(jsonCmd, nil); err != nil {
		t.Fatalf("run hook json: %v", err)
	}
	var pack runtimememory.Pack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("decode json %q: %v", out.String(), err)
	}
	if pack.Serialized != "" || len(pack.Items) != 0 || len(pack.Candidates) != 0 {
		t.Fatalf("mode-off json pack = %+v, want no injection metadata", pack)
	}
	if pack.SkipReason != runtimememory.SkipReasonModeOff {
		t.Fatalf("skipReason = %q, want %q", pack.SkipReason, runtimememory.SkipReasonModeOff)
	}
	if pack.Capture == nil || pack.Capture.Status != runtimememory.CaptureStatusSkipped || pack.Capture.Reason != runtimememory.SkipReasonModeOff {
		t.Fatalf("capture = %+v, want mode-off skipped", pack.Capture)
	}
	entries, err = store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory after json: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries after json = %d, want no auto-capture in mode off", len(entries))
	}
}

func TestRuntimeMemoryHookDebugJSONIncludesMetadataWithoutPlainPayload(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_PROMPT", "runtime review proposals")
	projectRoot, store := setupRuntimeMemoryHookStore(t)
	entry := &models.MemoryEntry{
		Title:     "Runtime review proposal",
		Layer:     models.MemoryLayerProject,
		Category:  "decision",
		Content:   "Use runtime review proposals only after activation.",
		Tags:      []string{"runtime", "review"},
		Status:    models.MemoryStatusProposed,
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	var out bytes.Buffer
	jsonCmd := newRuntimeMemoryHookTestCmd(&out, true)
	setRuntimeMemoryHookFlag(t, jsonCmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, jsonCmd, "mode", runtimememory.ModeDebug)

	if err := runRuntimeMemoryHook(jsonCmd, nil); err != nil {
		t.Fatalf("run hook json: %v", err)
	}
	var pack runtimememory.Pack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("decode json %q: %v", out.String(), err)
	}
	if pack.Serialized != "" || len(pack.Items) != 0 || pack.SelectedCount != 0 {
		t.Fatalf("pack injection = serialized:%q items:%d selected:%d, want inspect-only", pack.Serialized, len(pack.Items), pack.SelectedCount)
	}
	if len(pack.Candidates) != 1 || pack.Candidates[0].Status != models.MemoryStatusProposed {
		t.Fatalf("candidates = %+v, want proposed memory metadata", pack.Candidates)
	}
	if pack.CandidateCount != 1 || pack.RetrievalMode == "" {
		t.Fatalf("metadata = candidateCount:%d retrievalMode:%q, want populated metadata", pack.CandidateCount, pack.RetrievalMode)
	}
	if pack.Capture == nil || pack.Capture.Status != runtimememory.CaptureStatusSkipped || pack.Capture.Reason != runtimememory.SkipReasonDebugMode {
		t.Fatalf("capture = %+v, want debug-mode skipped", pack.Capture)
	}

	out.Reset()
	plainCmd := newRuntimeMemoryHookTestCmd(&out, false)
	setRuntimeMemoryHookFlag(t, plainCmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, plainCmd, "mode", runtimememory.ModeDebug)
	if err := runRuntimeMemoryHook(plainCmd, nil); err != nil {
		t.Fatalf("run hook plain: %v", err)
	}
	if out.String() != "" {
		t.Fatalf("debug plain output = %q, want silence", out.String())
	}
}

func TestRuntimeMemoryHookCaptureDisabledConfigStillInjects(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_PROMPT", "Use the runtime queue pattern for prompt injection jobs in this repo.")
	projectRoot, store := setupRuntimeMemoryHookStore(t)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	project.Settings.RuntimeMemory = &models.RuntimeMemorySettings{
		Mode:    runtimememory.ModeAuto,
		Capture: runtimememory.CaptureDisabled,
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("save config: %v", err)
	}
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "decision",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	var out bytes.Buffer
	jsonCmd := newRuntimeMemoryHookTestCmd(&out, true)
	setRuntimeMemoryHookFlag(t, jsonCmd, "project", projectRoot)
	if err := runRuntimeMemoryHook(jsonCmd, nil); err != nil {
		t.Fatalf("run hook json: %v", err)
	}
	var pack runtimememory.Pack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("decode json %q: %v", out.String(), err)
	}
	if pack.Serialized == "" || len(pack.Items) == 0 {
		t.Fatalf("pack = %+v, want injection while capture disabled", pack)
	}
	if pack.Capture == nil || pack.Capture.Status != runtimememory.CaptureStatusSkipped || pack.Capture.Reason != runtimememory.SkipReasonCaptureDisabled {
		t.Fatalf("capture = %+v, want capture-disabled skip", pack.Capture)
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want no proposed memory created", len(entries))
	}
}

func TestRuntimeMemoryHookCaptureDisabledFlagSkipsCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_PROMPT", "AGENTS.md should start with Knowns MCP initial in this repo")
	projectRoot, store := setupRuntimeMemoryHookStore(t)

	var out bytes.Buffer
	jsonCmd := newRuntimeMemoryHookTestCmd(&out, true)
	setRuntimeMemoryHookFlag(t, jsonCmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, jsonCmd, "capture", runtimememory.CaptureDisabled)
	if err := runRuntimeMemoryHook(jsonCmd, nil); err != nil {
		t.Fatalf("run hook json: %v", err)
	}
	var pack runtimememory.Pack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("decode json %q: %v", out.String(), err)
	}
	if pack.Capture == nil || pack.Capture.Status != runtimememory.CaptureStatusSkipped || pack.Capture.Reason != runtimememory.SkipReasonCaptureDisabled {
		t.Fatalf("capture = %+v, want capture-disabled skip", pack.Capture)
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("entries = %d, want no proposed memory created", len(entries))
	}
}

func TestRuntimeMemoryHookHighConfidenceCaptureCreatesProposedOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("KNOWNS_RUNTIME_PROMPT", "AGENTS.md should start with Knowns MCP initial in this repo")
	projectRoot, store := setupRuntimeMemoryHookStore(t)

	var out bytes.Buffer
	jsonCmd := newRuntimeMemoryHookTestCmd(&out, true)
	setRuntimeMemoryHookFlag(t, jsonCmd, "project", projectRoot)
	setRuntimeMemoryHookFlag(t, jsonCmd, "capture", runtimememory.CaptureHighConfidence)
	if err := runRuntimeMemoryHook(jsonCmd, nil); err != nil {
		t.Fatalf("run hook json: %v", err)
	}
	var pack runtimememory.Pack
	if err := json.Unmarshal(out.Bytes(), &pack); err != nil {
		t.Fatalf("decode json %q: %v", out.String(), err)
	}
	if pack.Capture == nil || pack.Capture.Status != runtimememory.CaptureStatusCreated || pack.Capture.MemoryStatus != models.MemoryStatusProposed {
		t.Fatalf("capture = %+v, want proposed memory created", pack.Capture)
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want one proposed memory", len(entries))
	}
	if entries[0].Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entries[0].Status)
	}
	if len(pack.Items) != 0 || pack.Serialized != "" {
		t.Fatalf("pack = %+v, want no automatic injection/activation for captured memory", pack)
	}
}

func setupRuntimeMemoryHookStore(t *testing.T) (string, *storage.Store) {
	t.Helper()
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return projectRoot, store
}

func newRuntimeMemoryHookTestCmd(out *bytes.Buffer, jsonOutput bool) *cobra.Command {
	cmd := &cobra.Command{Use: "hook", RunE: runRuntimeMemoryHook}
	cmd.Flags().String("runtime", "opencode", "")
	cmd.Flags().String("event", "prompt_async", "")
	cmd.Flags().String("project", "", "")
	cmd.Flags().String("cwd", "", "")
	cmd.Flags().String("mode", "", "")
	cmd.Flags().String("capture", "", "")
	cmd.Flags().Int("max-items", 0, "")
	cmd.Flags().Int("max-bytes", 0, "")
	cmd.Flags().Bool("json", jsonOutput, "")
	cmd.SetOut(out)
	return cmd
}

func setRuntimeMemoryHookFlag(t *testing.T, cmd *cobra.Command, name, value string) {
	t.Helper()
	if err := cmd.Flags().Set(name, value); err != nil {
		t.Fatalf("set flag %s: %v", name, err)
	}
}
