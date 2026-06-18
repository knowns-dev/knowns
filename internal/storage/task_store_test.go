package storage

import (
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestRenderTaskQuotesBracketPrefixedTitle(t *testing.T) {
	task := &models.Task{
		ID:        "2c9t78",
		Title:     "[memory-decision-review-ui-01] Add Memory lifecycle metadata and validation",
		Status:    "todo",
		Priority:  "medium",
		CreatedAt: time.Date(2026, 6, 18, 3, 39, 0, 0, time.UTC),
		UpdatedAt: time.Date(2026, 6, 18, 3, 41, 54, 0, time.UTC),
	}

	rendered := RenderTask(task)
	if !strings.Contains(rendered, "title: \"[memory-decision-review-ui-01] Add Memory lifecycle metadata and validation\"\n") {
		t.Fatalf("expected bracket-prefixed title to be quoted, got:\n%s", rendered)
	}

	parsed, err := ParseTaskContent(rendered)
	if err != nil {
		t.Fatalf("ParseTaskContent(RenderTask(task)) failed: %v", err)
	}
	if parsed.Title != task.Title {
		t.Fatalf("parsed title = %q, want %q", parsed.Title, task.Title)
	}
}
