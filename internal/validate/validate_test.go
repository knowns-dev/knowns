package validate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestValidateTask_NoTitle(t *testing.T) {
	task := &models.Task{ID: "abc123", Status: "todo", Priority: "medium"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_NO_TITLE")
}

func TestValidateTask_InvalidStatus(t *testing.T) {
	task := &models.Task{ID: "abc123", Title: "Test", Status: "invalid", Priority: "medium"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_INVALID_STATUS")
}

func TestValidateTask_NoStatus(t *testing.T) {
	task := &models.Task{ID: "abc123", Title: "Test", Priority: "medium"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_NO_STATUS")
}

func TestValidateTask_InvalidPriority(t *testing.T) {
	task := &models.Task{ID: "abc123", Title: "Test", Status: "todo", Priority: "critical"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_INVALID_PRIORITY")
}

func TestValidateTask_NoPriority(t *testing.T) {
	task := &models.Task{ID: "abc123", Title: "Test", Status: "todo"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_NO_PRIORITY")
}

func TestValidateTask_BrokenParentRef(t *testing.T) {
	task := &models.Task{ID: "abc123", Title: "Test", Status: "todo", Priority: "medium", Parent: "nonexist"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, map[string]string{"abc123": "nonexist"}, Options{}, nil)
	assertHasCode(t, issues, "BROKEN_TASK_REF")
}

func TestValidateTask_CircularParent(t *testing.T) {
	parentMap := map[string]string{
		"aaa": "bbb",
		"bbb": "aaa",
	}
	taskIDs := map[string]bool{"aaa": true, "bbb": true}
	task := &models.Task{ID: "aaa", Title: "A", Status: "todo", Priority: "medium", Parent: "bbb"}
	issues := validateTask(task, taskIDs, nil, nil, parentMap, Options{}, nil)
	assertHasCode(t, issues, "TASK_CIRCULAR_PARENT")
}

func TestValidateTask_CircularParent_ThreeWay(t *testing.T) {
	parentMap := map[string]string{
		"aaa": "bbb",
		"bbb": "ccc",
		"ccc": "aaa",
	}
	taskIDs := map[string]bool{"aaa": true, "bbb": true, "ccc": true}
	task := &models.Task{ID: "aaa", Title: "A", Status: "todo", Priority: "medium", Parent: "bbb"}
	issues := validateTask(task, taskIDs, nil, nil, parentMap, Options{}, nil)
	assertHasCode(t, issues, "TASK_CIRCULAR_PARENT")
}

func TestValidateTask_NoCircularParent(t *testing.T) {
	parentMap := map[string]string{
		"bbb": "aaa",
	}
	taskIDs := map[string]bool{"aaa": true, "bbb": true}
	task := &models.Task{ID: "bbb", Title: "B", Status: "todo", Priority: "medium", Parent: "aaa"}
	issues := validateTask(task, taskIDs, nil, nil, parentMap, Options{}, nil)
	assertNoCode(t, issues, "TASK_CIRCULAR_PARENT")
}

func TestValidateTask_FulfillsWithoutSpec(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Fulfills: []string{"AC-1"},
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_FULFILLS_NO_SPEC")
}

func TestValidateTask_FulfillsWithSpec(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Spec: "specs/auth", Fulfills: []string{"AC-1"},
	}
	docPaths := map[string]bool{"specs/auth": true}
	issues := validateTask(task, map[string]bool{"abc123": true}, docPaths, nil, nil, Options{}, nil)
	assertNoCode(t, issues, "TASK_FULFILLS_NO_SPEC")
}

func TestValidateTask_DuplicateLabels(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Labels: []string{"bug", "feature", "bug"},
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_DUPLICATE_LABELS")
}

func TestValidateTask_DoneUncheckedAC(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "done", Priority: "medium",
		AcceptanceCriteria: []models.AcceptanceCriterion{
			{Text: "First", Completed: true},
			{Text: "Second", Completed: false},
		},
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "TASK_DONE_UNCHECKED_AC")
}

func TestValidateTask_DoneAllACChecked(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "done", Priority: "medium",
		AcceptanceCriteria: []models.AcceptanceCriterion{
			{Text: "First", Completed: true},
			{Text: "Second", Completed: true},
		},
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertNoCode(t, issues, "TASK_DONE_UNCHECKED_AC")
}

func TestValidateTask_BrokenInlineTaskRef(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Description: "See @task-nonexist for details",
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "BROKEN_TASK_REF")
}

func TestValidateTask_BrokenInlineDocRef(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Description: "See @doc/guides/missing for details",
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "BROKEN_DOC_REF")
}

func TestValidateTask_ValidInlineRefs(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Description: "See @task-xyz789{blocked-by} and @doc/guides/setup{implements} for details",
	}
	taskIDs := map[string]bool{"abc123": true, "xyz789": true}
	docPaths := map[string]bool{"guides/setup": true}
	issues := validateTask(task, taskIDs, docPaths, nil, nil, Options{}, nil)
	assertNoCode(t, issues, "BROKEN_TASK_REF")
	assertNoCode(t, issues, "BROKEN_DOC_REF")
}

func TestValidateTask_InvalidSemanticRelation(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Description: "See @doc/guides/setup{owns} for details",
	}
	docPaths := map[string]bool{"guides/setup": true}
	issues := validateTask(task, map[string]bool{"abc123": true}, docPaths, nil, nil, Options{}, nil)
	assertHasCode(t, issues, "INVALID_SEMANTIC_REF_RELATION")
}

func TestValidateTask_SDD_NoAC(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Test", Status: "todo", Priority: "medium",
		Spec: "specs/auth",
	}
	docPaths := map[string]bool{"specs/auth": true}
	issues := validateTask(task, map[string]bool{"abc123": true}, docPaths, nil, nil, Options{Scope: "sdd"}, nil)
	assertHasCode(t, issues, "SDD_NO_AC")
}

func TestValidateTask_ValidTask(t *testing.T) {
	task := &models.Task{
		ID: "abc123", Title: "Good task", Status: "todo", Priority: "medium",
	}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	if len(issues) > 0 {
		t.Errorf("expected no issues for valid task, got %d: %v", len(issues), issues)
	}
}

// --- Doc validation ---

func TestValidateDoc_NoTitle(t *testing.T) {
	doc := &models.Doc{Path: "readme", Content: "some content", Description: "desc"}
	issues := validateDoc(doc, nil, nil, nil, nil)
	assertHasCode(t, issues, "DOC_NO_TITLE")
}

func TestValidateDoc_NoDescription(t *testing.T) {
	doc := &models.Doc{Path: "readme", Title: "README", Content: "content"}
	issues := validateDoc(doc, nil, nil, nil, nil)
	assertHasCode(t, issues, "DOC_NO_DESCRIPTION")
}

func TestValidateDoc_NoContent(t *testing.T) {
	doc := &models.Doc{Path: "readme", Title: "README", Description: "desc"}
	issues := validateDoc(doc, nil, nil, nil, nil)
	assertHasCode(t, issues, "DOC_NO_CONTENT")
}

func TestValidateDoc_BrokenRefs(t *testing.T) {
	doc := &models.Doc{
		Path: "readme", Title: "README", Description: "desc",
		Content: "See @task-nonexist and @doc/missing/doc for details",
	}
	issues := validateDoc(doc, nil, nil, nil, nil)
	assertHasCode(t, issues, "BROKEN_TASK_REF")
	assertHasCode(t, issues, "BROKEN_DOC_REF")
}

func TestValidateDoc_ValidDoc(t *testing.T) {
	doc := &models.Doc{
		Path: "readme", Title: "README", Description: "desc",
		Content: "Hello world",
	}
	issues := validateDoc(doc, nil, nil, nil, nil)
	if len(issues) > 0 {
		t.Errorf("expected no issues for valid doc, got %d: %v", len(issues), issues)
	}
}

func TestValidateDoc_DecisionRefs(t *testing.T) {
	store := newValidateTestStore(t)
	now := time.Now().UTC()
	decisionID := "20260618-1024-use-qdrant-as-default-vector-db"
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:        decisionID,
		Title:     "Use Qdrant as default vector DB",
		Status:    models.DecisionStatusAccepted,
		Sources:   []string{"@doc/readme"},
		CreatedAt: now,
		UpdatedAt: now,
	}, storage.DecisionCreateOptions{Now: now}); err != nil {
		t.Fatalf("create decision: %v", err)
	}

	doc := &models.Doc{
		Path:        "readme",
		Title:       "README",
		Description: "desc",
		Content:     "See @decision/20260618-1024-use-qdrant-as-default-vector-db and @decision/20260618-1024-missing.",
	}
	issues := validateDoc(doc, nil, nil, nil, store)
	assertNoIssueMessageContains(t, issues, decisionID)
	assertHasCode(t, issues, "BROKEN_DECISION_REF")
}

func TestValidateDoc_TemplateRefs(t *testing.T) {
	store := newValidateTestStore(t)
	templateDir := filepath.Join(store.Root, "templates", "go-feature")
	if err := os.MkdirAll(templateDir, 0o755); err != nil {
		t.Fatalf("create template dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(templateDir, "_template.yaml"), []byte("name: go-feature\ndescription: Go feature\nversion: 1.0.0\n"), 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}

	doc := &models.Doc{
		Path:        "readme",
		Title:       "README",
		Description: "desc",
		Content:     "Use @template/go-feature and avoid @template/missing-feature.",
	}
	issues := validateDoc(doc, nil, nil, nil, store)
	assertNoIssueMessageContains(t, issues, "@template/go-feature")
	assertHasCode(t, issues, "BROKEN_TEMPLATE_REF")
}

// --- Memory validation ---

func TestValidateMemory_LifecycleWarnings(t *testing.T) {
	oldVerified := time.Now().UTC().Add(-48 * time.Hour)
	memory := &models.MemoryEntry{
		ID:           "mem1",
		Title:        "Memory",
		Layer:        models.MemoryLayerProject,
		Status:       "invalid",
		Confidence:   "certain",
		LastVerified: oldVerified,
		TTLDays:      1,
		Sources:      []string{"@doc/missing", "@task-missing", "@memory-missing"},
		Content:      strings.Repeat("x", memoryContentMaxRunes+1),
	}
	issues := validateMemory(memory, nil, nil, nil, nil)
	assertHasCode(t, issues, "MEMORY_INVALID_STATUS")
	assertHasCode(t, issues, "MEMORY_INVALID_CONFIDENCE")
	assertHasCode(t, issues, "MEMORY_TTL_EXPIRED")
	assertHasCode(t, issues, "MEMORY_BROKEN_SOURCE_REF")
	assertHasCode(t, issues, "MEMORY_CONTENT_TOO_LONG")
}

func TestValidateMemory_LegacyMissingTrustMetadata(t *testing.T) {
	memory := &models.MemoryEntry{
		ID:                       "legacy",
		Title:                    "Legacy",
		Layer:                    models.MemoryLayerProject,
		Status:                   models.MemoryStatusActive,
		LifecycleMetadataMissing: []string{"status", "confidence", "lastVerified", "ttlDays", "sources"},
		Content:                  "legacy",
	}
	issues := validateMemory(memory, nil, nil, nil, nil)
	assertHasCode(t, issues, "MEMORY_MISSING_TRUST_METADATA")
	assertHasCode(t, issues, "MEMORY_MISSING_SOURCE")
	assertNoCode(t, issues, "MEMORY_INVALID_STATUS")
}

func TestValidateMemory_OldProposed(t *testing.T) {
	old := time.Now().UTC().Add(-40 * 24 * time.Hour)
	memory := &models.MemoryEntry{
		ID:           "proposed",
		Title:        "Proposed",
		Layer:        models.MemoryLayerProject,
		Status:       models.MemoryStatusProposed,
		Confidence:   models.MemoryConfidenceMedium,
		LastVerified: time.Now().UTC(),
		TTLDays:      90,
		Sources:      []string{"@doc/source"},
		CreatedAt:    old,
		UpdatedAt:    old,
		Content:      "proposal",
	}
	issues := validateMemory(memory, nil, map[string]bool{"source": true}, nil, nil)
	assertHasCode(t, issues, "MEMORY_OLD_PROPOSED")
	assertNoCode(t, issues, "MEMORY_MISSING_TRUST_METADATA")
	assertNoCode(t, issues, "MEMORY_BROKEN_SOURCE_REF")
}

func TestValidateMemory_ResolutionMetadata(t *testing.T) {
	base := models.MemoryEntry{
		ID:           "resolution",
		Title:        "Resolution",
		Layer:        models.MemoryLayerProject,
		Confidence:   models.MemoryConfidenceHigh,
		LastVerified: time.Now().UTC(),
		TTLDays:      90,
		Sources:      []string{"@doc/source"},
		Content:      "resolution",
	}
	merged := base
	merged.Status = models.MemoryStatusMerged
	issues := validateMemory(&merged, nil, map[string]bool{"source": true}, nil, nil)
	assertHasCode(t, issues, "MEMORY_MERGED_MISSING_TARGET")

	rejected := base
	rejected.Status = models.MemoryStatusRejected
	issues = validateMemory(&rejected, nil, map[string]bool{"source": true}, nil, nil)
	assertHasCode(t, issues, "MEMORY_REJECTED_MISSING_REASON")
}

func TestValidateMemory_DecisionSourceRefs(t *testing.T) {
	store := newValidateTestStore(t)
	now := time.Now().UTC()
	supersededID := "20260618-1024-use-qdrant-as-default-vector-db"
	if err := store.Decisions.Create(&models.DecisionEntry{
		ID:           supersededID,
		Title:        "Use Qdrant as default vector DB",
		Status:       models.DecisionStatusSuperseded,
		SupersededBy: []string{"20260618-1030-use-sqlite-vec"},
		Sources:      []string{"@doc/source"},
		CreatedAt:    now,
		UpdatedAt:    now,
	}, storage.DecisionCreateOptions{Now: now}); err != nil {
		t.Fatalf("create superseded decision: %v", err)
	}
	memory := &models.MemoryEntry{
		ID:           "decision-source",
		Title:        "Decision source",
		Layer:        models.MemoryLayerProject,
		Status:       models.MemoryStatusActive,
		Confidence:   models.MemoryConfidenceHigh,
		LastVerified: now,
		TTLDays:      90,
		Sources:      []string{"@decision/" + supersededID, "@decision/20260618-1111-missing"},
		Content:      "Decision sourced memory.",
	}

	issues := validateMemory(memory, nil, nil, nil, store)
	assertHasCode(t, issues, "MEMORY_SOURCE_DECISION_SUPERSEDED")
	assertHasCode(t, issues, "MEMORY_BROKEN_SOURCE_REF")
}

func newValidateTestStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("validate-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

// --- LooksLikeTaskID ---

func TestLooksLikeTaskID(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"abc123", true},
		{"ABC", true},
		{"123", true},
		{"a-b", true},
		{"specs/auth", false},
		{"guides/setup", false},
		{"a very long string that exceeds twenty characters", false},
		{"hello@world", false},
	}
	for _, tt := range tests {
		got := LooksLikeTaskID(tt.input)
		if got != tt.want {
			t.Errorf("LooksLikeTaskID(%q) = %v, want %v", tt.input, got, tt.want)
		}
	}
}

// --- Circular parent detection ---

func TestDetectCircularParent(t *testing.T) {
	tests := []struct {
		name      string
		id        string
		parentMap map[string]string
		want      bool
	}{
		{"no parent", "a", map[string]string{}, false},
		{"simple chain", "b", map[string]string{"b": "a"}, false},
		{"self loop", "a", map[string]string{"a": "a"}, true},
		{"two way", "a", map[string]string{"a": "b", "b": "a"}, true},
		{"three way", "a", map[string]string{"a": "b", "b": "c", "c": "a"}, true},
		{"long chain no loop", "d", map[string]string{"d": "c", "c": "b", "b": "a"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectCircularParent(tt.id, tt.parentMap)
			if got != tt.want {
				t.Errorf("detectCircularParent(%q) = %v, want %v", tt.id, got, tt.want)
			}
		})
	}
}

// --- Strict mode ---

func TestStrictMode(t *testing.T) {
	// A task with warning-level issue (no status)
	task := &models.Task{ID: "abc123", Title: "Test", Priority: "medium"}
	issues := validateTask(task, map[string]bool{"abc123": true}, nil, nil, nil, Options{}, nil)
	assertHasLevel(t, issues, "warning")

	// Simulate strict mode: warnings become errors
	for i := range issues {
		if issues[i].Level == "warning" {
			issues[i].Level = "error"
		}
	}
	assertNoLevel(t, issues, "warning")
	assertHasLevel(t, issues, "error")
}

// --- Helpers ---

func assertHasCode(t *testing.T, issues []Issue, code string) {
	t.Helper()
	for _, iss := range issues {
		if iss.Code == code {
			return
		}
	}
	t.Errorf("expected issue with code %q, not found in %v", code, issues)
}

func assertNoCode(t *testing.T, issues []Issue, code string) {
	t.Helper()
	for _, iss := range issues {
		if iss.Code == code {
			t.Errorf("expected no issue with code %q, but found: %v", code, iss)
		}
	}
}

func assertNoIssueMessageContains(t *testing.T, issues []Issue, text string) {
	t.Helper()
	for _, issue := range issues {
		if strings.Contains(issue.Message, text) {
			t.Fatalf("unexpected issue containing %q: %+v", text, issue)
		}
	}
}

func assertHasLevel(t *testing.T, issues []Issue, level string) {
	t.Helper()
	for _, iss := range issues {
		if iss.Level == level {
			return
		}
	}
	t.Errorf("expected issue with level %q, not found", level)
}

func assertNoLevel(t *testing.T, issues []Issue, level string) {
	t.Helper()
	for _, iss := range issues {
		if iss.Level == level {
			t.Errorf("expected no issue with level %q, but found: %v", level, iss)
		}
	}
}
