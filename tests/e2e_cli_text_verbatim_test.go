package tests

import (
	"strings"
	"testing"
)

// TestCLI_TextFlagsStoreBackslashSequencesVerbatim guards the behaviour set by
// commit ecddf78: flag values reach storage unchanged, so a code snippet, a
// regex, or a Windows path survives a round trip. Shells produce real newlines
// through $'...', which Go's exec passes through the same way.
func TestCLI_TextFlagsStoreBackslashSequencesVerbatim(t *testing.T) {
	dir := setupTestProject(t)

	const sentinel = `fmt.Println("a\nb") and "C:\new\table"`

	res := runCli(t, dir, "task", "create", "CLI verbatim text", "-d", sentinel)
	requireSuccess(t, res, "create task")
	taskID := extractTaskIDShort(res.Stdout + res.Stderr)
	if taskID == "" {
		t.Fatalf("no task ID found in output:\n%s\n%s", res.Stdout, res.Stderr)
	}

	res = runCli(t, dir, "task", "edit", taskID, "--plan", sentinel, "--notes", sentinel)
	requireSuccess(t, res, "set plan and notes")

	res = runCli(t, dir, "task", taskID, "--plain")
	requireSuccess(t, res, "view task")
	if got := strings.Count(res.Stdout, sentinel); got != 3 {
		t.Fatalf("sentinel appears %d times in task view, want 3 (description, plan, notes):\n%s", got, res.Stdout)
	}
}

// TestCLI_AppendNotesSeparatesEntriesWithBlankLine keeps each appended entry a
// separate markdown block instead of merging them into one paragraph.
func TestCLI_AppendNotesSeparatesEntriesWithBlankLine(t *testing.T) {
	dir := setupTestProject(t)

	res := runCli(t, dir, "task", "create", "CLI append separator")
	requireSuccess(t, res, "create task")
	taskID := extractTaskIDShort(res.Stdout + res.Stderr)
	if taskID == "" {
		t.Fatalf("no task ID found in output:\n%s\n%s", res.Stdout, res.Stderr)
	}

	for _, note := range []string{"first entry", "second entry"} {
		res = runCli(t, dir, "task", "edit", taskID, "--append-notes", note)
		requireSuccess(t, res, "append "+note)
	}

	res = runCli(t, dir, "task", taskID, "--plain")
	requireSuccess(t, res, "view task")
	if !strings.Contains(res.Stdout, "first entry\n\nsecond entry") {
		t.Fatalf("appended notes are not separated by a blank line:\n%s", res.Stdout)
	}
}
