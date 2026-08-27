package handlers

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/howznguyen/knowns/internal/storage"
)

// backslashSentinel carries the sequences that unescapeText used to rewrite,
// alongside the real-world payloads that rewrite corrupted: a Go string
// literal, a regex escape, and a Windows path.
const backslashSentinel = `fmt.Println("a\nb")` + "\n" + `re := regexp.MustCompile("\t+")` + "\n" + `path := "C:\new\table"`

func TestStringArgPreservesBackslashSequences(t *testing.T) {
	// Every key here used to be read through textArg.
	keys := []string{
		"description", "plan", "notes", "appendNotes",
		"content", "appendContent",
		"body", "context", "decision", "alternatives", "consequences",
		"needle", "repl",
	}
	for _, key := range keys {
		t.Run(key, func(t *testing.T) {
			got, ok := stringArg(map[string]any{key: backslashSentinel}, key)
			if !ok {
				t.Fatalf("stringArg(%q) reported missing", key)
			}
			if got != backslashSentinel {
				t.Fatalf("stringArg(%q) = %q, want verbatim %q", key, got, backslashSentinel)
			}
		})
	}
}

func TestTaskTextFieldsStoredVerbatim(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("verbatim-task-text"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }

	createResult, err := handleTaskCreate(getStore, mutationRequest(map[string]any{
		"title":       "Verbatim task",
		"description": backslashSentinel,
		"plan":        backslashSentinel,
		"notes":       backslashSentinel,
	}))
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	taskID, _ := mutationResultMap(t, createResult)["taskId"].(string)
	if taskID == "" {
		t.Fatal("create task returned no taskId")
	}

	task, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get created task: %v", err)
	}
	for name, got := range map[string]string{
		"description": task.Description,
		"plan":        task.ImplementationPlan,
		"notes":       task.ImplementationNotes,
	} {
		if got != backslashSentinel {
			t.Fatalf("stored %s = %q, want verbatim %q", name, got, backslashSentinel)
		}
	}
}

func TestAppendNotesSeparatesEntriesWithBlankLine(t *testing.T) {
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("append-notes-separator"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	getStore := func() *storage.Store { return store }

	createResult, err := handleTaskCreate(getStore, mutationRequest(map[string]any{"title": "Append separator"}))
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	taskID, _ := mutationResultMap(t, createResult)["taskId"].(string)
	if taskID == "" {
		t.Fatal("create task returned no taskId")
	}

	for _, note := range []string{"first entry", "second entry"} {
		if _, err := handleTaskUpdate(getStore, mutationRequest(map[string]any{
			"taskId":      taskID,
			"appendNotes": note,
		})); err != nil {
			t.Fatalf("append %q: %v", note, err)
		}
	}

	task, err := store.Tasks.Get(taskID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	const want = "first entry\n\nsecond entry"
	if task.ImplementationNotes != want {
		t.Fatalf("notes = %q, want %q", task.ImplementationNotes, want)
	}
}

func TestCodeReplacePreservesBackslashSequences(t *testing.T) {
	root := t.TempDir()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	if err := store.Init("verbatim-code-replace"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	target := filepath.Join(root, "sample.go")
	if err := os.WriteFile(target, []byte("package sample\n\nconst marker = \"placeholder\"\n"), 0644); err != nil {
		t.Fatalf("write target: %v", err)
	}

	result, err := handleCodeReplace(
		context.Background(),
		func() *storage.Store { return store },
		func() CodeRuntime { return nil },
		mutationRequest(map[string]any{
			"path":   "sample.go",
			"needle": `"placeholder"`,
			"repl":   `"a\nb\tc"`,
		}),
	)
	if err != nil {
		t.Fatalf("code replace: %v", err)
	}
	if payload := mutationResultMap(t, result); payload["success"] != true {
		t.Fatalf("code replace failed: %#v", payload)
	}

	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	// The replacement must land as source text, not as real whitespace that
	// would break the surrounding string literal.
	const want = "package sample\n\nconst marker = \"a\\nb\\tc\"\n"
	if string(data) != want {
		t.Fatalf("file = %q, want %q", string(data), want)
	}
}
