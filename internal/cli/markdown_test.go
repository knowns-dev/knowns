package cli

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/charmbracelet/x/ansi"
	"github.com/howznguyen/knowns/internal/models"
)

func TestRenderTerminalMarkdownWithStyleFormatsAndWraps(t *testing.T) {
	input := "# Heading\n\nThis paragraph contains **bold text** and enough words to wrap across several terminal lines."

	got := newTerminalMarkdownBodyRenderer(30, "dark")(input)
	plain := ansi.Strip(got)

	if got == input {
		t.Fatal("expected Glamour to format Markdown")
	}
	if !strings.Contains(plain, "Heading") || !strings.Contains(plain, "bold text") {
		t.Fatalf("rendered output lost Markdown content:\n%s", got)
	}
	if strings.Contains(plain, "**bold text**") {
		t.Fatalf("rendered output still contains Markdown emphasis markers:\n%s", got)
	}
	for _, line := range strings.Split(plain, "\n") {
		if width := utf8.RuneCountInString(line); width > 30 {
			t.Fatalf("rendered line width %d exceeds requested width 30: %q", width, line)
		}
	}
}

func TestRenderTerminalMarkdownFallsBackToRawInput(t *testing.T) {
	input := "**keep this Markdown**"
	got := newTerminalMarkdownBodyRenderer(80, "/missing/knowns/glamour-style.json")(input)
	if got != input {
		t.Fatalf("expected raw fallback %q, got %q", input, got)
	}
}

func TestTerminalMarkdownStyleUsesASCIIForDumbTerminal(t *testing.T) {
	t.Setenv("TERM", "dumb")
	if got := terminalMarkdownStyle(); got != "ascii" {
		t.Fatalf("terminalMarkdownStyle() = %q, want ascii", got)
	}
}

func TestRenderDocViewMarkdownFormatsOnlyTheBody(t *testing.T) {
	doc := &models.Doc{
		Title:       "Markdown Doc",
		Description: "Metadata stays in the existing renderer",
		Content:     "## Section\n\nA **formatted** body.",
	}

	raw := renderDocView(doc)
	rendered := ansi.Strip(renderDocViewMarkdownWithStyle(doc, 60, "dark"))

	if !strings.Contains(raw, "**formatted**") {
		t.Fatalf("raw list preview unexpectedly rendered Markdown:\n%s", raw)
	}
	if strings.Contains(rendered, "**formatted**") {
		t.Fatalf("interactive doc body was not rendered:\n%s", rendered)
	}
	for _, want := range []string{"Markdown Doc", "Metadata stays in the existing renderer", "Section", "formatted"} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("interactive doc output missing %q:\n%s", want, rendered)
		}
	}
}

func TestRenderDocListDetailMarkdownStylesHeadingsAndCode(t *testing.T) {
	doc := &models.Doc{
		Title:       "Outer TUI Title",
		Description: "Detail metadata",
		Content:     "# Styled Heading\n\n```go\nfmt.Println(\"hello\")\n```",
	}

	rendered := renderDocListDetailMarkdownWithStyle(doc, 60, "dark")
	plain := ansi.Strip(rendered)

	if !strings.Contains(rendered, "\x1b[") {
		t.Fatalf("rendered detail has no terminal styling:\n%s", rendered)
	}
	if strings.Contains(plain, "# Styled Heading") || strings.Contains(plain, "```") {
		t.Fatalf("rendered detail still contains raw heading/code markers:\n%s", plain)
	}
	for _, want := range []string{"Detail metadata", "Styled Heading", "fmt.Println", "hello"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("rendered detail missing %q:\n%s", want, plain)
		}
	}
	if strings.Contains(plain, doc.Title) {
		t.Fatalf("detail repeated the outer TUI title:\n%s", plain)
	}
}

func TestRenderTaskDetailedMarkdownPreservesMetadataAndRendersFields(t *testing.T) {
	task := &models.Task{
		ID:                  "abc123",
		Title:               "Markdown Task",
		Status:              "in-progress",
		Priority:            "high",
		Description:         "A **formatted description**.",
		ImplementationPlan:  "1. First\n2. Second",
		ImplementationNotes: "Use `glamour` here.",
		AcceptanceCriteria: []models.AcceptanceCriterion{
			{Text: "Keep the existing checkbox", Completed: true},
		},
	}

	raw := renderTaskDetailed(task)
	rendered := ansi.Strip(renderTaskDetailedMarkdownWithStyle(task, 60, "dark"))

	if !strings.Contains(raw, "**formatted description**") {
		t.Fatalf("raw task list preview unexpectedly rendered Markdown:\n%s", raw)
	}
	if strings.Contains(rendered, "**formatted description**") {
		t.Fatalf("interactive task field was not rendered:\n%s", rendered)
	}
	for _, want := range []string{
		"abc123",
		"Markdown Task",
		"in-progress",
		"high",
		"formatted description",
		"First",
		"Second",
		"glamour",
		"Keep the existing checkbox",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("interactive task output missing %q:\n%s", want, rendered)
		}
	}

	items := buildTaskListItems([]*models.Task{task})
	if len(items) != 1 || items[0].detail != "" || items[0].detailRenderer == nil {
		t.Fatalf("task list detail should be rendered lazily: %#v", items)
	}
	if plain := sprintTaskPlain(task); !strings.Contains(plain, "**formatted description**") {
		t.Fatalf("plain task output contract changed:\n%s", plain)
	}
}
