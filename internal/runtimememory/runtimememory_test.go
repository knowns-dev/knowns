package runtimememory

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestBuildSelectsRelevantProjectAndGlobalMemories(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	entries := []*models.MemoryEntry{
		{Title: "Runtime queue decision", Layer: models.MemoryLayerProject, Category: "pattern", Content: "Use the runtime queue pattern for prompt injection jobs.", Tags: []string{"runtime", "queue"}, CreatedAt: now, UpdatedAt: now},
		{Title: "Global OpenCode warning", Layer: models.MemoryLayerGlobal, Category: "warning", Content: "OpenCode prompt hooks must stay bounded to avoid prompt bloat.", Tags: []string{"opencode", "runtime"}, CreatedAt: now, UpdatedAt: now.Add(-time.Hour)},
		{Title: "Unrelated preference", Layer: models.MemoryLayerProject, Category: "preference", Content: "Use playful colors in marketing pages.", Tags: []string{"design"}, CreatedAt: now, UpdatedAt: now.Add(-2 * time.Hour)},
	}
	for _, entry := range entries {
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create memory %q: %v", entry.Title, err)
		}
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "implement runtime queue prompt injection for opencode",
		Mode:        ModeAuto,
		MaxItems:    5,
		MaxBytes:    2500,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusCandidate {
		t.Fatalf("status = %q, want %q", pack.Status, StatusCandidate)
	}
	if len(pack.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(pack.Items))
	}
	if pack.Items[0].Title != "Runtime queue decision" {
		t.Fatalf("first item = %q, want runtime queue decision", pack.Items[0].Title)
	}
	if pack.Items[1].Layer != models.MemoryLayerGlobal {
		t.Fatalf("second layer = %q, want global", pack.Items[1].Layer)
	}
	if pack.Items[0].Category == "" || pack.Items[0].Layer == "" || pack.Items[0].UpdatedAt.IsZero() {
		t.Fatalf("missing provenance in first item: %+v", pack.Items[0])
	}
	if pack.Serialized == "" {
		t.Fatal("expected serialized payload")
	}
	if !strings.Contains(pack.Serialized, "Knowns Guidance") {
		t.Fatalf("expected guidance header, got %q", pack.Serialized)
	}
	if !strings.Contains(pack.Serialized, "memory({ action: \"list\" })") {
		t.Fatalf("expected memory action list hint, got %q", pack.Serialized)
	}
	for _, entry := range entries[:2] {
		if !strings.Contains(pack.Serialized, "@memory/"+entry.ID) {
			t.Fatalf("expected memory reference for %q in serialized payload, got %q", entry.Title, pack.Serialized)
		}
		if !strings.Contains(pack.Serialized, "["+entry.Layer+"/"+entry.Category+"] "+entry.Title) {
			t.Fatalf("expected memory provenance/title for %q in serialized payload, got %q", entry.Title, pack.Serialized)
		}
		if !strings.Contains(pack.Serialized, entry.Content) {
			t.Fatalf("expected memory content for %q in serialized payload, got %q", entry.Title, pack.Serialized)
		}
	}
	if !strings.Contains(pack.Serialized, "score=") || !strings.Contains(pack.Serialized, "trust=active") {
		t.Fatalf("expected score/trust metadata in serialized payload, got %q", pack.Serialized)
	}
	if strings.Contains(pack.Serialized, "Reasons:") || strings.Contains(pack.Serialized, "keyword-overlap") {
		t.Fatalf("did not expect debug scoring metadata in serialized payload, got %q", pack.Serialized)
	}
}

func TestBuildReturnsNoneWhenNoRelevantMemoryExists(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	entry := &models.MemoryEntry{Title: "UI preference", Layer: models.MemoryLayerProject, Category: "preference", Content: "Prefer serif typography for landing pages.", Tags: []string{"design"}, CreatedAt: now, UpdatedAt: now}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: "debug sqlite vector search", Mode: ModeAuto})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusNone {
		t.Fatalf("status = %q, want %q", pack.Status, StatusNone)
	}
	if len(pack.Items) != 0 {
		t.Fatalf("items = %d, want 0", len(pack.Items))
	}
}

func TestBuildExcludesNonActiveMemoryByDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	statuses := []string{
		models.MemoryStatusProposed,
		models.MemoryStatusArchived,
		models.MemoryStatusRejected,
		models.MemoryStatusMerged,
		models.MemoryStatusStale,
		models.MemoryStatusDeprecated,
	}
	for _, status := range statuses {
		entry := &models.MemoryEntry{
			Title:     "Runtime review proposal " + status,
			Layer:     models.MemoryLayerProject,
			Category:  "pattern",
			Content:   "Use runtime review proposals only after activation.",
			Tags:      []string{"runtime", "review"},
			Status:    status,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create memory %q: %v", status, err)
		}
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "runtime review proposals",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if pack.Status != StatusNone || len(pack.Items) != 0 {
		t.Fatalf("pack = %+v, want no non-active memory injection", pack)
	}
	if pack.Serialized != "" {
		t.Fatalf("serialized = %q, want empty plain payload", pack.Serialized)
	}
	if pack.SkipReason != SkipReasonNoCandidates {
		t.Fatalf("skipReason = %q, want %q", pack.SkipReason, SkipReasonNoCandidates)
	}

	debugPack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "runtime review proposals",
		Mode:        ModeDebug,
		MaxItems:    len(statuses),
	})
	if err != nil {
		t.Fatalf("Build debug: %v", err)
	}
	if debugPack.Status != StatusCandidate || len(debugPack.Candidates) != len(statuses) {
		t.Fatalf("debug pack = %+v, want non-active memory candidates", debugPack)
	}
	if len(debugPack.Items) != 0 || debugPack.Serialized != "" {
		t.Fatalf("debug injected items/serialized = %d/%q, want inspect-only", len(debugPack.Items), debugPack.Serialized)
	}
	seen := map[string]bool{}
	for _, item := range debugPack.Candidates {
		seen[item.Status] = true
	}
	for _, status := range statuses {
		if !seen[status] {
			t.Fatalf("debug candidates missing status %q: %+v", status, debugPack.Candidates)
		}
	}
}

func TestBuildSkipsLowSignalPrompts(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	entry := &models.MemoryEntry{Title: "Runtime queue decision", Layer: models.MemoryLayerProject, Category: "pattern", Content: "Use the runtime queue pattern for prompt injection jobs.", Tags: []string{"runtime", "queue"}, CreatedAt: now, UpdatedAt: now}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	for _, prompt := range []string{"hi", "ok", "continue", "thanks", "yes"} {
		pack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: prompt, Mode: ModeAuto})
		if err != nil {
			t.Fatalf("build pack for %q: %v", prompt, err)
		}
		if pack.Status != StatusNone {
			t.Fatalf("status for %q = %q, want %q", prompt, pack.Status, StatusNone)
		}
		if pack.SkipReason != SkipReasonLowSignalPrompt {
			t.Fatalf("skipReason for %q = %q, want %q", prompt, pack.SkipReason, SkipReasonLowSignalPrompt)
		}
		if pack.Serialized != "" {
			t.Fatalf("serialized for %q = %q, want empty plain payload", prompt, pack.Serialized)
		}
		if len(pack.Items) != 0 {
			t.Fatalf("items for %q = %d, want 0", prompt, len(pack.Items))
		}
	}

	pack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: "fix auth", Mode: ModeAuto})
	if err != nil {
		t.Fatalf("build technical short prompt: %v", err)
	}
	if pack.Status != StatusNone {
		t.Fatalf("status for technical short prompt = %q, want %q because no relevant auth memory exists", pack.Status, StatusNone)
	}
}

func TestBuildSkipsWeakSingleCandidate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	entry := &models.MemoryEntry{Title: "Minor graph note", Layer: models.MemoryLayerProject, Category: "pattern", Content: "Graph page keeps code and knowledge presets on one page.", Tags: []string{"graph", "page"}, CreatedAt: now, UpdatedAt: now}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: "graph page", Mode: ModeAuto})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusNone {
		t.Fatalf("status = %q, want %q for weak candidate", pack.Status, StatusNone)
	}
	if pack.SkipReason != SkipReasonBelowThreshold {
		t.Fatalf("skipReason = %q, want %q", pack.SkipReason, SkipReasonBelowThreshold)
	}
	if len(pack.Candidates) != 1 {
		t.Fatalf("candidates = %d, want weak candidate metadata", len(pack.Candidates))
	}
	if pack.Serialized != "" {
		t.Fatalf("serialized = %q, want empty plain payload", pack.Serialized)
	}
}

func TestBuildModeOffSuppressesInjectionAndCapture(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "implement runtime queue prompt injection for opencode",
		Mode:        ModeOff,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusNone || pack.Serialized != "" || len(pack.Items) != 0 || len(pack.Candidates) != 0 {
		t.Fatalf("pack = %+v, want mode-off silence", pack)
	}
	if pack.SkipReason != SkipReasonModeOff {
		t.Fatalf("skipReason = %q, want %q", pack.SkipReason, SkipReasonModeOff)
	}

	_, outcome, err := CaptureWithOutcome(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "toi muon AI tu luu memory, khong doi toi nhac moi them",
		Mode:        ModeOff,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if outcome.Status != CaptureStatusSkipped || outcome.Reason != SkipReasonModeOff || outcome.Created {
		t.Fatalf("capture outcome = %+v, want mode-off skipped", outcome)
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want only existing active memory", len(entries))
	}
}

func TestNormalizeSettingsIncludesIndependentCaptureControl(t *testing.T) {
	settings := NormalizeSettings(&models.RuntimeMemorySettings{
		Mode:     ModeAuto,
		Capture:  CaptureDisabled,
		MaxItems: 2,
		MaxBytes: 512,
	})
	if settings.Mode != ModeAuto {
		t.Fatalf("mode = %q, want %q", settings.Mode, ModeAuto)
	}
	if settings.Capture != CaptureDisabled {
		t.Fatalf("capture = %q, want %q", settings.Capture, CaptureDisabled)
	}
	if settings.MaxItems != 2 || settings.MaxBytes != 512 {
		t.Fatalf("limits = %d/%d, want 2/512", settings.MaxItems, settings.MaxBytes)
	}

	defaults := NormalizeSettings(nil)
	if defaults.Mode != ModeAuto || defaults.Capture != CaptureHighConfidence {
		t.Fatalf("defaults = mode:%q capture:%q, want auto/high-confidence", defaults.Mode, defaults.Capture)
	}
}

func TestCaptureDisabledStillAllowsInjection(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	input := Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "Use the runtime queue pattern for prompt injection jobs in this repo.",
		Mode:        ModeAuto,
		Capture:     CaptureDisabled,
	}
	pack, err := Build(store, input)
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Serialized == "" || len(pack.Items) == 0 {
		t.Fatalf("pack = %+v, want injection despite capture disabled", pack)
	}

	_, outcome, err := CaptureWithOutcome(store, input)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if outcome.Status != CaptureStatusSkipped || outcome.Reason != SkipReasonCaptureDisabled || outcome.Created {
		t.Fatalf("capture outcome = %+v, want capture-disabled skip", outcome)
	}
	entries, err := store.Memory.List("")
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want only existing injected memory", len(entries))
	}
}

func TestHighConfidenceCaptureDoesNotInferProjectDecision(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	input := Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "AGENTS.md should start with Knowns MCP initial in this repo",
		Mode:        ModeAuto,
		Capture:     CaptureHighConfidence,
	}
	entry, outcome, err := CaptureWithOutcome(store, input)
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if entry != nil || outcome.Created || outcome.Status != CaptureStatusSkipped || outcome.Reason != SkipReasonNoCaptureCandidate {
		t.Fatalf("capture outcome = %+v entry=%+v, want no inferred project decision", outcome, entry)
	}
	decisions, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("list decisions: %v", err)
	}
	if len(decisions) != 0 {
		t.Fatalf("ordinary prompt created System Decisions: %+v", decisions)
	}
}

func TestBuildDebugIsInspectOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: time.Now().UTC(),
		UpdatedAt: time.Now().UTC(),
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "implement runtime queue prompt injection for opencode",
		Mode:        ModeDebug,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusCandidate {
		t.Fatalf("status = %q, want %q", pack.Status, StatusCandidate)
	}
	if len(pack.Candidates) != 1 || pack.Candidates[0].ID != entry.ID {
		t.Fatalf("candidates = %+v, want active memory candidate", pack.Candidates)
	}
	if len(pack.Items) != 0 || pack.Serialized != "" || pack.SelectedCount != 0 {
		t.Fatalf("debug injection = items:%d serialized:%q selected:%d, want inspect-only", len(pack.Items), pack.Serialized, pack.SelectedCount)
	}
	if pack.CandidateCount != 1 || pack.RetrievalMode == "" {
		t.Fatalf("debug metadata = candidateCount:%d retrievalMode:%q, want populated metadata", pack.CandidateCount, pack.RetrievalMode)
	}

	_, outcome, err := CaptureWithOutcome(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "toi muon AI tu luu memory, khong doi toi nhac moi them",
		Mode:        ModeDebug,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if outcome.Status != CaptureStatusSkipped || outcome.Reason != SkipReasonDebugMode || outcome.Created {
		t.Fatalf("capture outcome = %+v, want debug skipped", outcome)
	}
}

func TestSerializePrefixAddsSilentInstructionForOpenCode(t *testing.T) {
	prefix := serializePrefix("opencode")
	if !strings.Contains(prefix, "Silent supplemental context. Do not quote unless asked.") {
		t.Fatalf("expected silent supplemental instruction, got %q", prefix)
	}
	other := serializePrefix("claude-code")
	if strings.Contains(other, "Silent supplemental context. Do not quote unless asked.") {
		t.Fatalf("did not expect OpenCode-specific instruction for other runtimes, got %q", other)
	}
}

func TestBuildSessionBaselineIncludesProjectGuidance(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	entry := &models.MemoryEntry{Title: "Response style", Layer: models.MemoryLayerProject, Category: "preference", Content: "Answer directly and keep formatting flat.", Tags: []string{"style", "preference"}, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{Runtime: "claude-code", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "session-start", Mode: ModeAuto})
	if err != nil {
		t.Fatalf("build baseline pack: %v", err)
	}
	if pack.Status != StatusCandidate {
		t.Fatalf("status = %q, want %q", pack.Status, StatusCandidate)
	}
	if !strings.Contains(pack.Serialized, "Use MCP `initial` first when available") {
		t.Fatalf("expected MCP initial instruction in baseline pack, got %q", pack.Serialized)
	}
	if !strings.Contains(pack.Serialized, "memory({ action: \"list\" })") {
		t.Fatalf("expected MCP memory hint in baseline pack, got %q", pack.Serialized)
	}
}

func TestBuildHonorsItemAndByteLimits(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	for i := 0; i < 3; i++ {
		entry := &models.MemoryEntry{
			Title:     "Runtime injection pattern",
			Layer:     models.MemoryLayerProject,
			Category:  "pattern",
			Content:   "Runtime injection should stay bounded while carrying prompt context and ranking reasons for repeated prompt execution. This text is intentionally long to force truncation.",
			Tags:      []string{"runtime", "prompt"},
			CreatedAt: now,
			UpdatedAt: now.Add(time.Duration(i) * time.Minute),
		}
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create memory %d: %v", i, err)
		}
	}

	pack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: "runtime prompt injection", Mode: ModeAuto, MaxItems: 1, MaxBytes: 300})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if len(pack.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(pack.Items))
	}
	// The byte ceiling no longer cuts inside an entry. This entry alone exceeds
	// 300, and the contract is now to emit it whole rather than to emit a half
	// of it that reads as complete. See TestOversizedSoleEntryIsEmittedWhole.
	if strings.Contains(pack.Serialized, "...") {
		t.Fatalf("did not expect truncation marker in serialized payload, got %q", pack.Serialized)
	}
	if !strings.Contains(pack.Serialized, "ranking reasons for repeated prompt execution") {
		t.Fatalf("expected the claim to be emitted intact, got %q", pack.Serialized)
	}
	if !strings.Contains(pack.Serialized, "score=") || !strings.Contains(pack.Serialized, "trust=active") {
		t.Fatalf("expected score/trust metadata in serialized payload, got %q", pack.Serialized)
	}
	if strings.Contains(pack.Serialized, "Reasons:") || strings.Contains(pack.Serialized, "heuristic-fallback") {
		t.Fatalf("did not expect debug metadata in serialized payload, got %q", pack.Serialized)
	}

	tinyPromptPack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "prompt_async", UserPrompt: "runtime prompt injection", Mode: ModeAuto, MaxItems: 1, MaxBytes: 64})
	if err != nil {
		t.Fatalf("build tiny prompt pack: %v", err)
	}
	if tinyPromptPack.Bytes > 64 {
		t.Fatalf("tiny prompt bytes = %d, want <= 64", tinyPromptPack.Bytes)
	}

	tinySessionPack, err := Build(store, Input{Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot, ActionType: "session-start", Mode: ModeAuto, MaxItems: 1, MaxBytes: 64})
	if err != nil {
		t.Fatalf("build tiny session pack: %v", err)
	}
	if tinySessionPack.Bytes > 64 {
		t.Fatalf("tiny session bytes = %d, want <= 64", tinySessionPack.Bytes)
	}
}

func TestBuildSerializesMemoryFactsInDeterministicOrder(t *testing.T) {
	t.Cleanup(func() {
		lookupHybridCandidates = defaultHybridCandidates
	})
	now := time.Now().UTC()
	lookupHybridCandidates = func(store *storage.Store, input Input, limit int) ([]hybridCandidate, bool) {
		return []hybridCandidate{
			{
				entry: &models.MemoryEntry{
					ID:        "beta-memory",
					Title:     "Runtime prompt memory beta",
					Layer:     models.MemoryLayerProject,
					Category:  "pattern",
					Content:   "Runtime prompt memory beta keeps selected facts bounded.",
					Tags:      []string{"runtime", "prompt"},
					UpdatedAt: now,
				},
				score:     0.9,
				matchedBy: []string{"semantic"},
			},
			{
				entry: &models.MemoryEntry{
					ID:        "alpha-memory",
					Title:     "Runtime prompt memory alpha",
					Layer:     models.MemoryLayerProject,
					Category:  "pattern",
					Content:   "Runtime prompt memory alpha keeps selected facts bounded.",
					Tags:      []string{"runtime", "prompt"},
					UpdatedAt: now,
				},
				score:     0.9,
				matchedBy: []string{"semantic"},
			},
		}, true
	}

	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "runtime prompt memory",
		Mode:        ModeAuto,
		MaxItems:    2,
		MaxBytes:    1000,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if len(pack.Items) != 2 {
		t.Fatalf("items = %d, want 2", len(pack.Items))
	}
	if pack.Items[0].ID != "alpha-memory" || pack.Items[1].ID != "beta-memory" {
		t.Fatalf("item order = [%s %s], want alpha then beta", pack.Items[0].ID, pack.Items[1].ID)
	}
	alphaIndex := strings.Index(pack.Serialized, "@memory/alpha-memory")
	betaIndex := strings.Index(pack.Serialized, "@memory/beta-memory")
	if alphaIndex < 0 || betaIndex < 0 || alphaIndex > betaIndex {
		t.Fatalf("serialized order not deterministic, got %q", pack.Serialized)
	}
}

func TestBuildUsesHybridCandidatesWhenAvailable(t *testing.T) {
	t.Cleanup(func() {
		lookupHybridCandidates = defaultHybridCandidates
	})
	lookupHybridCandidates = func(store *storage.Store, input Input, limit int) ([]hybridCandidate, bool) {
		now := time.Now().UTC()
		return []hybridCandidate{
			{
				entry: &models.MemoryEntry{
					ID:        "runtime-hit",
					Title:     "Unified runtime adapter install",
					Layer:     models.MemoryLayerProject,
					Category:  "pattern",
					Content:   "Use the runtime install command and opencode plugin path for unified adapter setup.",
					Tags:      []string{"runtime", "opencode", "codex"},
					UpdatedAt: now,
				},
				score:     0.92,
				matchedBy: []string{"semantic", "keyword"},
			},
			{
				entry: &models.MemoryEntry{
					ID:        "recent-noise",
					Title:     "Windows npm packages must use win32 os",
					Layer:     models.MemoryLayerProject,
					Category:  "failure",
					Content:   "Windows npm binary packages must declare win32 os metadata.",
					Tags:      []string{"windows", "npm", "cli"},
					UpdatedAt: now.Add(-time.Minute),
				},
				score:     0.21,
				matchedBy: []string{"semantic"},
			},
		}, true
	}

	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "implement unified runtime adapter install for codex and opencode",
		Mode:        ModeAuto,
		MaxItems:    5,
		MaxBytes:    2500,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusCandidate {
		t.Fatalf("status = %q, want %q", pack.Status, StatusCandidate)
	}
	if len(pack.Items) == 0 {
		t.Fatal("expected at least one hybrid-selected item")
	}
	if pack.Items[0].Title != "Unified runtime adapter install" {
		t.Fatalf("first item = %q, want unified runtime adapter install", pack.Items[0].Title)
	}
	if pack.Items[0].Retrieval != "hybrid" {
		t.Fatalf("retrieval = %q, want hybrid", pack.Items[0].Retrieval)
	}
	if !containsString(pack.Items[0].Reasons, "semantic-match") || !containsString(pack.Items[0].Reasons, "hybrid-retrieval") {
		t.Fatalf("expected hybrid reasons, got %v", pack.Items[0].Reasons)
	}
}

func TestBuildFallsBackWhenHybridUnavailable(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Cleanup(func() {
		lookupHybridCandidates = defaultHybridCandidates
	})
	lookupHybridCandidates = func(store *storage.Store, input Input, limit int) ([]hybridCandidate, bool) {
		return nil, false
	}

	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	now := time.Now().UTC()
	entry := &models.MemoryEntry{
		Title:     "Runtime queue decision",
		Layer:     models.MemoryLayerProject,
		Category:  "pattern",
		Content:   "Use the runtime queue pattern for prompt injection jobs.",
		Tags:      []string{"runtime", "queue"},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.Memory.Create(entry); err != nil {
		t.Fatalf("create memory: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "prompt_async",
		UserPrompt:  "implement runtime queue prompt injection for opencode",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if len(pack.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(pack.Items))
	}
	if pack.Items[0].Retrieval != "heuristic-fallback" {
		t.Fatalf("retrieval = %q, want heuristic-fallback", pack.Items[0].Retrieval)
	}
	if !containsString(pack.Items[0].Reasons, "heuristic-fallback") {
		t.Fatalf("expected fallback reason, got %v", pack.Items[0].Reasons)
	}
}

func TestBuildKeepsEmptyPackCleanWhenHybridReturnsNoUsableCandidates(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Cleanup(func() {
		lookupHybridCandidates = defaultHybridCandidates
	})
	lookupHybridCandidates = func(store *storage.Store, input Input, limit int) ([]hybridCandidate, bool) {
		now := time.Now().UTC()
		return []hybridCandidate{{
			entry: &models.MemoryEntry{
				ID:        "noise",
				Title:     "Completely unrelated preference",
				Layer:     models.MemoryLayerProject,
				Category:  "preference",
				Content:   "Use playful colors in marketing pages.",
				Tags:      []string{"design"},
				UpdatedAt: now,
			},
			score:     0.05,
			matchedBy: []string{"semantic"},
		}}, true
	}

	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	pack, err := Build(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "implement unified runtime adapter install for codex and opencode",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("build pack: %v", err)
	}
	if pack.Status != StatusNone {
		t.Fatalf("status = %q, want %q", pack.Status, StatusNone)
	}
	if pack.Serialized != "" {
		t.Fatalf("expected empty serialized payload, got %q", pack.Serialized)
	}
	if strings.Contains(pack.Serialized, "Knowns Guidance") {
		t.Fatalf("expected no serialized memory pack for empty result")
	}
}

func TestCaptureNeverWritesFromPromptText(t *testing.T) {
	// Every prompt below used to create a Memory. The first two are the exact
	// shapes the two removed inferences matched on. The third is the prompt
	// that produced entry 4pgj1h in this repository's own store: the user's
	// question, copied verbatim, stored as durable knowledge.
	//
	// The English cases are the tell. "for now", "currently" and "investigating"
	// are the vocabulary of a fact that is about to stop being true, and the
	// removed inference treated them as the signal to keep one forever.
	cases := []struct {
		name   string
		prompt string
	}{
		{"global preference phrasing", "toi muon AI tu luu memory, khong doi toi nhac moi them"},
		{"working context phrasing", "for now we are debugging the runtime queue workaround"},
		{"vietnamese hien tai", "hiện tại bạn đã thấy Knowns đã có Persistent Memory chưa"},
		{"english currently", "currently I am investigating the reconcile queue"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			projectRoot := t.TempDir()
			store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
			if err := store.Init("runtime-memory"); err != nil {
				t.Fatalf("init store: %v", err)
			}

			entry, outcome, err := CaptureWithOutcome(store, Input{
				Runtime:     "opencode",
				ProjectRoot: projectRoot,
				WorkingDir:  projectRoot,
				ActionType:  "user-prompt-submit",
				UserPrompt:  tc.prompt,
				Mode:        ModeAuto,
			})
			if err != nil {
				t.Fatalf("capture: %v", err)
			}
			if entry != nil {
				t.Fatalf("expected no memory, got %q", entry.Title)
			}
			if outcome.Created {
				t.Fatal("expected Created to be false")
			}
			if outcome.Status != CaptureStatusSkipped {
				t.Fatalf("status = %q, want %q", outcome.Status, CaptureStatusSkipped)
			}
			if outcome.Reason != SkipReasonNoCaptureCandidate {
				t.Fatalf("reason = %q, want %q", outcome.Reason, SkipReasonNoCaptureCandidate)
			}

			stored, err := store.Memory.List("")
			if err != nil {
				t.Fatalf("list memories: %v", err)
			}
			if len(stored) != 0 {
				t.Fatalf("expected an empty store, got %d entries", len(stored))
			}
		})
	}
}

func TestCaptureDoesNotInferProjectDecisionFromPrompt(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	entry, created, err := Capture(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "AGENTS.md should start with Knowns MCP initial in this repo",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if created || entry != nil {
		t.Fatalf("ordinary prompt created memory: created=%v entry=%+v", created, entry)
	}
}

func TestLookupAdapterIncludesRequiredRuntimesAndModes(t *testing.T) {
	for _, runtime := range []string{"kiro", "claude-code", "opencode", "antigravity"} {
		adapter, ok := LookupAdapter(runtime)
		if !ok {
			t.Fatalf("missing adapter %q", runtime)
		}
		if len(adapter.SupportedModes) != 4 {
			t.Fatalf("adapter %q modes = %v", runtime, adapter.SupportedModes)
		}
	}
	kiro, _ := LookupAdapter("kiro")
	if !kiro.NativeHooks || kiro.HookKind != HookNative {
		t.Fatalf("kiro adapter = %+v, want native hooks", kiro)
	}
}

func TestHookGuidanceDefinesWhatAMemoryIs(t *testing.T) {
	// This block is paid on every prompt, so it carries exactly one line about
	// what belongs in the store. Without it the only place that says so is the
	// kn-extract skill, which has to be invoked, while the hook that fires on
	// every message explains only which tool to call.
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	summary := serializeKNOWNSSummary(store, 4000)
	if !strings.Contains(summary, "a fact the NEXT session needs") {
		t.Fatalf("hook guidance should define a Memory, got:\n%s", summary)
	}
	if !strings.Contains(summary, "only repeats the prompt") {
		t.Fatalf("hook guidance should carry the negative test, got:\n%s", summary)
	}

	// canonicalityWarning is already emitted above every injection, so repeating
	// it here spent a line on every prompt to say the same thing twice.
	if strings.Count(summary, canonicalityWarning) > 1 {
		t.Errorf("canonicality warning is duplicated inside the guidance block")
	}
}

func TestExpireAbandonedProposalsRetiresOnlyTheAbandoned(t *testing.T) {
	// Driven with an explicit clock rather than time.Now, so it keeps testing
	// the rule after the grace window for the pre-existing backlog has passed
	// and stops depending on what day it is run.
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}

	now := time.Now().UTC().AddDate(2, 0, 0)
	seed := func(id, status string, updated time.Time) {
		t.Helper()
		if err := store.Memory.Create(&models.MemoryEntry{
			ID: id, Title: "Memory " + id, Layer: models.MemoryLayerProject,
			Category: "pattern", Content: "Body " + id, Status: status, UpdatedAt: updated,
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
	seed("abandoned", models.MemoryStatusProposed, now.AddDate(0, 0, -90))
	seed("kept", models.MemoryStatusActive, now.AddDate(0, 0, -90))
	seed("recent", models.MemoryStatusProposed, now.AddDate(0, 0, -1))

	if got := expireAbandonedProposals(store, now); got != 1 {
		t.Fatalf("expired = %d, want 1", got)
	}

	expired, err := store.Memory.Get("abandoned")
	if err != nil {
		t.Fatalf("get abandoned: %v", err)
	}
	if expired.Status != models.MemoryStatusRejected {
		t.Fatalf("abandoned status = %q, want rejected", expired.Status)
	}

	// An entry in use must survive being old, and a proposal inside its window
	// must survive being unreviewed.
	for _, id := range []string{"kept", "recent"} {
		entry, err := store.Memory.Get(id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		if entry.Status == models.MemoryStatusRejected {
			t.Errorf("%s was expired but should not have been", id)
		}
	}
}

func TestCaptureReportsTheExpirySweep(t *testing.T) {
	// The hook's write path used to manufacture junk. It now runs the sweep,
	// so the queue is bounded without anyone remembering to run a command.
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	if err := store.Memory.Create(&models.MemoryEntry{
		ID: "fresh", Title: "Fresh", Layer: models.MemoryLayerProject,
		Category: "pattern", Content: "Body", Status: models.MemoryStatusProposed,
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	_, outcome, err := CaptureWithOutcome(store, Input{
		Runtime: "opencode", ProjectRoot: projectRoot, WorkingDir: projectRoot,
		ActionType: "user-prompt-submit", UserPrompt: "please review the reconcile queue", Mode: ModeAuto,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if outcome.ExpiredProposals != 0 {
		t.Fatalf("a proposal written moments ago must not be swept, got %d", outcome.ExpiredProposals)
	}
	entry, err := store.Memory.Get("fresh")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want it left proposed", entry.Status)
	}
}

// item builds a serialization-ready Item without going through the store.
func claimItem(id, title, claim string, hasDetail bool, fullBytes int) Item {
	return Item{
		ID: id, Title: title, Category: "pattern", Layer: models.MemoryLayerProject,
		Status: models.MemoryStatusActive, Claim: claim, HasDetail: hasDetail,
		FullBytes: fullBytes, Score: 1.5,
	}
}

func TestOversizedEntryDoesNotBlockSmallerOnesBehindIt(t *testing.T) {
	// This is the defect that made every injection show exactly one memory.
	// The list is score-ordered, so what follows a large entry is usually a
	// SMALLER entry; `break` discarded all of them to protect budget with room
	// still in it.
	big := claimItem("big", "Large", strings.Repeat("x", 400), false, 400)
	small := claimItem("small", "Small", "short and useful", false, 16)
	var emitted []Item
	out := serializeItems([]Item{big, small}, 220, &emitted)
	if len(emitted) != 1 || emitted[0].ID != "small" {
		t.Fatalf("emitted = %+v, want only the small entry", emitted)
	}
	if !strings.Contains(out, "short and useful") {
		t.Fatalf("serialized = %q, want the smaller entry present", out)
	}
	if !strings.Contains(out, "1 more matching memory did not fit") {
		t.Fatalf("serialized = %q, want the elision line to name the skipped entry", out)
	}
}

func TestOversizedSoleEntryIsEmittedWhole(t *testing.T) {
	// A prompt that retrieved a memory and then showed none is, from the
	// agent's side, identical to having no memory at all.
	body := strings.Repeat("y", 500)
	var emitted []Item
	out := serializeItems([]Item{claimItem("only", "Only", body, false, 500)}, 100, &emitted)
	if len(emitted) != 1 {
		t.Fatalf("emitted = %d, want 1 even over budget", len(emitted))
	}
	if !strings.Contains(out, body) {
		t.Fatalf("serialized = %q, want the claim intact rather than trimmed", out)
	}
	if strings.Contains(out, "...") {
		t.Fatalf("serialized = %q, want no truncation marker", out)
	}
}

func TestDetailLinePrintedOnlyWhenSomethingWasHeldBack(t *testing.T) {
	withDetail := serializeItems([]Item{claimItem("a", "A", "the claim", true, 900)}, 4000, nil)
	if !strings.Contains(withDetail, `detail: memory(action:"get", id:"a")`) {
		t.Fatalf("serialized = %q, want the detail hint", withDetail)
	}
	if !strings.Contains(withDetail, "full=900b") {
		t.Fatalf("serialized = %q, want the full size named", withDetail)
	}
	// A memory whose claim IS its body must not send an agent after a fuller
	// version that does not exist; one wasted call teaches it to ignore the
	// hint everywhere it does matter.
	withoutDetail := serializeItems([]Item{claimItem("b", "B", "the whole thing", false, 15)}, 4000, nil)
	if strings.Contains(withoutDetail, "detail: memory(") {
		t.Fatalf("serialized = %q, want no detail hint on a memory with no detail", withoutDetail)
	}
}

func TestElisionLineCountsEveryHiddenEntry(t *testing.T) {
	items := []Item{
		claimItem("keep", "Keep", "tiny", false, 4),
		claimItem("d1", "D1", strings.Repeat("z", 400), false, 400),
		claimItem("d2", "D2", strings.Repeat("z", 400), false, 400),
	}
	out := serializeItems(items, 200, nil)
	if !strings.Contains(out, "2 more matching memories did not fit") {
		t.Fatalf("serialized = %q, want both hidden entries counted", out)
	}
}

func TestConventionCategoryReachesInjection(t *testing.T) {
	// sbf2ih is `convention`: active, fully sourced, top of every search, and
	// invisible to the agent because injection kept its own category list.
	if !allowedCategory("convention") {
		t.Fatalf("convention must be injectable; it is in models.AllowedMemoryCategories")
	}
	for _, legacy := range []string{"decision", "warning"} {
		if !allowedCategory(legacy) {
			t.Fatalf("%s predates the contract and must stay readable", legacy)
		}
	}
	if allowedCategory("implementation") || allowedCategory("") {
		t.Fatalf("categories outside the contract must not be injectable")
	}
}

func TestClaimFieldsSplitOnRawContentNotNormalized(t *testing.T) {
	// normalizeWhitespace collapses the blank line that separates a claim from
	// its evidence, so the split has to happen before it runs.
	claim, hasDetail, full := claimFields("The point.\n\nThe evidence that supports it.")
	if claim != "The point." || !hasDetail {
		t.Fatalf("claim = %q hasDetail = %v", claim, hasDetail)
	}
	if full != len("The point.\n\nThe evidence that supports it.") {
		t.Fatalf("fullBytes = %d", full)
	}
}

func baselineEntry(id, category, layer string, tags []string) *models.MemoryEntry {
	return &models.MemoryEntry{
		ID: id, Title: "Memory " + id, Category: category, Layer: layer,
		Status: models.MemoryStatusActive, Content: "Body of " + id, Tags: tags,
		UpdatedAt: time.Now().UTC().Add(-24 * time.Hour),
	}
}

func TestBaselineRanksCommitmentsAboveContextDependentFacts(t *testing.T) {
	// Ranking used to come from TAGS, which are free-form. On the real store
	// that put three of four preferences at positions 10, 11 and 12 out of 12,
	// below every project failure note, while the fourth led only because its
	// author happened to write `style` and `preference` on it.
	entries := []*models.MemoryEntry{
		baselineEntry("failure-recent", "failure", models.MemoryLayerProject, []string{"debug"}),
		baselineEntry("pattern-proj", "pattern", models.MemoryLayerProject, []string{"storage"}),
		baselineEntry("pref-untagged", "preference", models.MemoryLayerGlobal, []string{"workflow"}),
		baselineEntry("convention-proj", "convention", models.MemoryLayerProject, []string{"sdd"}),
		baselineEntry("pref-tagged", "preference", models.MemoryLayerGlobal, []string{"style", "preference"}),
	}
	scored := map[string]float64{}
	for _, entry := range entries {
		score, _ := baselineScore(entry)
		scored[entry.ID] = score
	}
	// Every preference outranks every non-commitment, tagged or not.
	for _, pref := range []string{"pref-untagged", "pref-tagged"} {
		for _, other := range []string{"failure-recent", "pattern-proj", "convention-proj"} {
			if scored[pref] <= scored[other] {
				t.Fatalf("%s (%.2f) must outrank %s (%.2f)", pref, scored[pref], other, scored[other])
			}
		}
	}
	if scored["convention-proj"] <= scored["failure-recent"] {
		t.Fatalf("a convention must outrank a context-dependent fact: %.2f vs %.2f",
			scored["convention-proj"], scored["failure-recent"])
	}
	// A second matching tag must not buy a second bonus; that is what let one
	// entry jump the queue for a reason nobody chose.
	if scored["pref-tagged"]-scored["pref-untagged"] > baselineTagWeight+0.0001 {
		t.Fatalf("tags gave more than one bonus: %.2f vs %.2f", scored["pref-tagged"], scored["pref-untagged"])
	}
}

func TestSessionBaselineCapsItemsEvenWhenConfigAsksForMore(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	projectRoot := t.TempDir()
	store := storage.NewStore(filepath.Join(projectRoot, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	for i := 0; i < baselineMaxItems+4; i++ {
		entry := &models.MemoryEntry{
			Title: fmt.Sprintf("Commitment %d", i), Layer: models.MemoryLayerGlobal,
			Category: "preference", Content: fmt.Sprintf("Rule %d.\n\n**Why:** because.", i),
			Status: models.MemoryStatusActive, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	// MaxItems arrives filled in from config on every real call, which is why
	// the old `input.MaxItems <= 0` guard never fired and the cap was dead.
	pack, err := Build(store, Input{
		Runtime: "claude-code", ProjectRoot: projectRoot, WorkingDir: projectRoot,
		ActionType: "session-start", UserPrompt: "", Mode: ModeAuto,
		MaxItems: baselineMaxItems + 4, MaxBytes: 40000,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if pack.RetrievalMode != "session-baseline" {
		t.Fatalf("retrievalMode = %q, want session-baseline", pack.RetrievalMode)
	}
	if len(pack.Items) > baselineMaxItems {
		t.Fatalf("items = %d, want at most %d", len(pack.Items), baselineMaxItems)
	}
}

func TestSemanticHitSharingNoWordWithThePromptIsStillConsidered(t *testing.T) {
	// The keyword gate stood IN FRONT of the semantic layer: a hit that
	// matched on meaning but shared no word with the prompt was discarded,
	// which is exactly the case the semantic layer exists to catch.
	entry := &models.MemoryEntry{
		ID: "ipkq69", Title: "Khong dung em dash", Category: "preference",
		Layer: models.MemoryLayerGlobal, Status: models.MemoryStatusActive,
		Content:   "Khi viet noi dung cho nguoi dung, khong dung ky tu em dash.",
		UpdatedAt: time.Now().UTC(),
	}
	// Shares no token with the entry's title, category, tags or content.
	input := Input{Runtime: "claude-code", UserPrompt: "avoid that lengthy horizontal stroke in prose", Mode: ModeAuto}
	if _, _, overlaps := scoreEntry(entry, input, false); overlaps != 0 {
		t.Fatalf("fixture must share zero words with the prompt, got %d", overlaps)
	}

	strong := buildHybridItems([]hybridCandidate{{entry: entry, score: 0.95, matchedBy: []string{"semantic"}}}, input)
	if len(strong) != 1 {
		t.Fatalf("a strong semantic hit with zero word overlap was dropped")
	}
	if strong[0].item.Retrieval != "hybrid" {
		t.Fatalf("retrieval = %q, want hybrid", strong[0].item.Retrieval)
	}

	// The floor still holds. With no overlap nearly all of the score is the
	// semantic boost, so a weak semantic match must not ride in on the
	// removal of the gate.
	weak := buildHybridItems([]hybridCandidate{{entry: entry, score: 0.40, matchedBy: []string{"semantic"}}}, input)
	if len(weak) != 0 {
		t.Fatalf("a weak semantic hit with zero word overlap cleared the floor: %+v", weak[0].item)
	}
}
