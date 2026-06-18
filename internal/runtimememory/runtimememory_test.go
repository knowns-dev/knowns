package runtimememory

import (
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
		{Title: "Runtime queue decision", Layer: models.MemoryLayerProject, Category: "decision", Content: "Use the runtime queue pattern for prompt injection jobs.", Tags: []string{"runtime", "queue"}, CreatedAt: now, UpdatedAt: now},
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
	if strings.Contains(pack.Serialized, "Score:") || strings.Contains(pack.Serialized, "Reasons:") || strings.Contains(pack.Serialized, "keyword-overlap") {
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
			Category:  "decision",
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
	entry := &models.MemoryEntry{Title: "Runtime queue decision", Layer: models.MemoryLayerProject, Category: "decision", Content: "Use the runtime queue pattern for prompt injection jobs.", Tags: []string{"runtime", "queue"}, CreatedAt: now, UpdatedAt: now}
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
	entry := &models.MemoryEntry{Title: "Minor graph note", Layer: models.MemoryLayerProject, Category: "decision", Content: "Graph page keeps code and knowledge presets on one page.", Tags: []string{"graph", "page"}, CreatedAt: now, UpdatedAt: now}
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
		Category:  "decision",
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
		Category:  "decision",
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

func TestHighConfidenceCaptureCreatesProposedOnly(t *testing.T) {
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
	if !outcome.Created || outcome.Status != CaptureStatusCreated {
		t.Fatalf("capture outcome = %+v, want created", outcome)
	}
	if entry == nil {
		t.Fatal("expected created memory")
	}
	if outcome.MemoryStatus != models.MemoryStatusProposed || entry.Status != models.MemoryStatusProposed {
		t.Fatalf("memory status = outcome:%q entry:%q, want proposed", outcome.MemoryStatus, entry.Status)
	}

	pack, err := Build(store, input)
	if err != nil {
		t.Fatalf("build after proposed capture: %v", err)
	}
	if len(pack.Items) != 0 || pack.Serialized != "" {
		t.Fatalf("pack = %+v, want proposed memory excluded from default injection", pack)
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
		Category:  "decision",
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
	if pack.Bytes > 300 {
		t.Fatalf("bytes = %d, want <= 300", pack.Bytes)
	}
	if !strings.Contains(pack.Serialized, "...") {
		t.Fatalf("expected truncated content marker in serialized payload, got %q", pack.Serialized)
	}
	if strings.Contains(pack.Serialized, "ranking reasons for repeated prompt execution") {
		t.Fatalf("expected long content tail to be truncated, got %q", pack.Serialized)
	}
	if strings.Contains(pack.Serialized, "Score:") || strings.Contains(pack.Serialized, "Reasons:") || strings.Contains(pack.Serialized, "heuristic-fallback") {
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
		Category:  "decision",
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

func TestCaptureStoresStableGlobalPreference(t *testing.T) {
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
		UserPrompt:  "toi muon AI tu luu memory, khong doi toi nhac moi them",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if !created {
		t.Fatal("expected capture to create a memory")
	}
	if entry == nil {
		t.Fatal("expected created entry")
	}
	if entry.Layer != models.MemoryLayerGlobal {
		t.Fatalf("layer = %q, want %q", entry.Layer, models.MemoryLayerGlobal)
	}
	if entry.Category != "preference" {
		t.Fatalf("category = %q, want preference", entry.Category)
	}
	if !strings.Contains(entry.Content, "proactively save durable memory") {
		t.Fatalf("unexpected content: %q", entry.Content)
	}
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entry.Status)
	}

	_, createdAgain, err := Capture(store, Input{
		Runtime:     "opencode",
		ProjectRoot: projectRoot,
		WorkingDir:  projectRoot,
		ActionType:  "user-prompt-submit",
		UserPrompt:  "toi muon AI tu luu memory, khong doi toi nhac moi them",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("capture duplicate: %v", err)
	}
	if createdAgain {
		t.Fatal("expected duplicate capture to be skipped")
	}
}

func TestCaptureStoresProjectDecisionForMCPShimGuidance(t *testing.T) {
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
	if !created {
		t.Fatal("expected project decision memory to be created")
	}
	if entry.Layer != models.MemoryLayerProject {
		t.Fatalf("layer = %q, want %q", entry.Layer, models.MemoryLayerProject)
	}
	if entry.Category != "decision" {
		t.Fatalf("category = %q, want decision", entry.Category)
	}
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entry.Status)
	}
	if !strings.Contains(entry.Content, "AGENTS.md should start with Knowns MCP initial") {
		t.Fatalf("unexpected content: %q", entry.Content)
	}
}

func TestCaptureStoresWorkingContextForTemporaryInstruction(t *testing.T) {
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
		UserPrompt:  "for now we are debugging the runtime queue workaround",
		Mode:        ModeAuto,
	})
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if !created {
		t.Fatal("expected memory to be created")
	}
	if entry.Layer != models.MemoryLayerProject {
		t.Fatalf("layer = %q, want %q", entry.Layer, models.MemoryLayerProject)
	}
	if entry.Category != "context" {
		t.Fatalf("category = %q, want context", entry.Category)
	}
	if entry.Status != models.MemoryStatusProposed {
		t.Fatalf("status = %q, want proposed", entry.Status)
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
