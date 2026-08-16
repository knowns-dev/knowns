package cli

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"charm.land/bubbles/v2/paginator"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/howznguyen/knowns/internal/models"
)

func TestListItemFilterValueIncludesVisibleMetadata(t *testing.T) {
	item := listItem{
		id:          "specs/terminal-ui",
		title:       "Giao diện terminal",
		description: joinListMetadata(StyleSuccess.Render("in-progress"), RenderTags([]string{"tui", "ux"})),
	}

	value := item.FilterValue()
	for _, want := range []string{"specs/terminal-ui", "Giao diện terminal", "in-progress", "tui", "ux"} {
		if !strings.Contains(value, want) {
			t.Fatalf("FilterValue() = %q, missing %q", value, want)
		}
	}
	if strings.Contains(value, "\x1b[") {
		t.Fatalf("FilterValue() contains ANSI escapes: %q", value)
	}
}

func TestRenderListItemLinesFitsWidthAndPreservesUnicode(t *testing.T) {
	item := listItem{
		id:          "architecture/patterns/terminal-interface",
		title:       "Cải thiện trải nghiệm terminal 👩🏽‍💻",
		description: joinListMetadata("Mô tả rất dài cần được rút gọn an toàn", RenderTags([]string{"giao-diện", "Unicode"})),
	}

	for _, width := range []int{24, 40, 80, 120} {
		title, description := renderListItemLines(item, width, true)
		if !utf8.ValidString(title) || !utf8.ValidString(description) {
			t.Fatalf("rendered invalid UTF-8 at width %d: %q / %q", width, title, description)
		}
		if got := ansi.StringWidth(title); got > width {
			t.Fatalf("title width = %d, want <= %d: %q", got, width, title)
		}
		if got := ansi.StringWidth(description); got > width {
			t.Fatalf("description width = %d, want <= %d: %q", got, width, description)
		}
	}
}

func TestNewListViewModelExposesActionsAndArabicPagination(t *testing.T) {
	model := newListViewModel("Docs", []listItem{{id: "readme", title: "README"}})
	if model.list.Paginator.Type != paginator.Arabic {
		t.Fatalf("paginator type = %v, want Arabic", model.list.Paginator.Type)
	}

	bindings := model.list.AdditionalShortHelpKeys()
	help := make([]string, 0, len(bindings))
	for _, binding := range bindings {
		help = append(help, binding.Help().Key+" "+binding.Help().Desc)
	}
	joined := strings.Join(help, " ")
	for _, want := range []string{"enter open", "q quit"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("short help = %q, missing %q", joined, want)
		}
	}
}

func TestListViewRendersDetailLazilyAtViewportWidth(t *testing.T) {
	var widths []int
	item := listItem{
		id:    "readme",
		title: "README",
		detailRenderer: func(width int) string {
			widths = append(widths, width)
			return "rendered detail"
		},
	}
	model := newListViewModel("Docs", []listItem{item})

	updated, _ := model.Update(tea.WindowSizeMsg{Width: 72, Height: 24})
	model = updated.(listViewModel)
	if len(widths) != 0 {
		t.Fatalf("detail rendered eagerly during list setup: widths=%v", widths)
	}

	updated, _ = model.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	model = updated.(listViewModel)
	if model.state != stateDetail {
		t.Fatalf("state = %v, want detail", model.state)
	}
	if len(widths) != 1 || widths[0] != 72 {
		t.Fatalf("detail widths after open = %v, want [72]", widths)
	}

	updated, _ = model.Update(tea.WindowSizeMsg{Width: 54, Height: 20})
	model = updated.(listViewModel)
	if len(widths) != 2 || widths[1] != 54 {
		t.Fatalf("detail widths after resize = %v, want [72 54]", widths)
	}
}

func TestBuildTaskListItemsUsesDeterministicActionableOrder(t *testing.T) {
	older := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newer := older.Add(time.Hour)
	tasks := []*models.Task{
		{ID: "done01", Title: "Done", Status: "done", Priority: "high", UpdatedAt: newer},
		{ID: "todo01", Title: "Todo", Status: "todo", Priority: "medium", UpdatedAt: older},
		{ID: "block1", Title: "Blocked", Status: "blocked", Priority: "low", UpdatedAt: older},
		{ID: "prog01", Title: "Progress", Status: "in-progress", Priority: "medium", UpdatedAt: older},
		{ID: "todo02", Title: "Newer Todo", Status: "todo", Priority: "medium", UpdatedAt: newer},
	}

	items := buildTaskListItems(tasks)
	got := make([]string, len(items))
	for i, item := range items {
		got[i] = item.id
	}
	want := []string{"block1", "prog01", "todo02", "todo01", "done01"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("item order = %v, want %v", got, want)
	}

	if tasks[0].ID != "done01" {
		t.Fatalf("buildTaskListItems mutated input order: first = %q", tasks[0].ID)
	}
	for _, item := range items {
		if item.detail != "" || item.detailRenderer == nil {
			t.Fatalf("task detail should be rendered lazily: %#v", item)
		}
	}
}

func TestBuildDocListItemsReusesLoadedContent(t *testing.T) {
	doc := &models.Doc{
		Path:        "guides/tui",
		Title:       "TUI Guide",
		Description: "Terminal interface guidance",
		Tags:        []string{"tui", "ux"},
		Content:     "# Content already loaded",
	}

	items := buildDocListItems([]*models.Doc{doc})
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].detail != "" || items[0].detailRenderer == nil {
		t.Fatalf("doc detail should be rendered lazily: %#v", items[0])
	}
	detail := items[0].detailRenderer(60)
	if !strings.Contains(ansi.Strip(detail), "Content already loaded") {
		t.Fatalf("detail = %q, missing loaded content", detail)
	}
	for _, want := range []string{"Terminal interface guidance", "tui", "ux"} {
		if !strings.Contains(ansi.Strip(items[0].description), want) {
			t.Fatalf("description = %q, missing %q", items[0].description, want)
		}
	}
}
