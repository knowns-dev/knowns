package cli

import (
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/howznguyen/knowns/internal/models"
)

func plainListFixture() []*models.Task {
	return []*models.Task{
		{ID: "KN-A1", Status: "todo", Priority: "high", Title: "Add JWT auth"},
		{ID: "KN-LONGER2", Status: "in-progress", Priority: "medium", Assignee: "howznguyen", Title: "Write auth tests"},
		{ID: "KN-C3", Status: "done", Priority: "low", Title: "Design token schema"},
	}
}

// TestPlainListPutsStatusOnEveryRow is the defect this format replaced: status
// used to live only in a group heading, so a grepped row carried no status at all
// and reading one meant tracking which heading it fell under.
func TestPlainListPutsStatusOnEveryRow(t *testing.T) {
	out := sprintTaskListPlain(plainListFixture())

	for _, want := range []struct{ id, status string }{
		{"KN-A1", "todo"},
		{"KN-LONGER2", "in-progress"},
		{"KN-C3", "done"},
	} {
		var row string
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, want.id+" ") {
				row = line
				break
			}
		}
		if row == "" {
			t.Fatalf("no row for %s in:\n%s", want.id, out)
		}
		if !strings.Contains(row, want.status) {
			t.Errorf("row for %s carries no status: %q", want.id, row)
		}
	}
}

// TestPlainListKeepsEveryColumnOnEveryRow guards the field positions. An absent
// assignee has to hold its column, or the field a value lands in depends on which
// task it belongs to and the format stops being splittable.
func TestPlainListKeepsEveryColumnOnEveryRow(t *testing.T) {
	out := sprintTaskListPlain(plainListFixture())

	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "KN-") {
			continue
		}
		if got := len(strings.Fields(line)); got < 5 {
			t.Errorf("row has %d fields, want at least 5 (id, status, priority, assignee, title): %q", got, line)
		}
	}

	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "KN-A1 ") {
			continue
		}
		if f := strings.Fields(line); f[3] != "-" {
			t.Errorf("assignee column of an unassigned task = %q, want the %q placeholder: %q", f[3], "-", line)
		}
	}
}

// TestPlainListSummaryCountsEveryTask pins the trailing total, the one line that
// tells a reader whether they are looking at the whole list. The order follows
// taskStatusListRank, the same rank the rows are sorted by, so in-progress leads
// todo here exactly as it does above.
func TestPlainListSummaryCountsEveryTask(t *testing.T) {
	out := sprintTaskListPlain(plainListFixture())
	want := "Total: 3 tasks (1 in-progress, 1 todo, 1 done)"
	if !strings.Contains(out, want) {
		t.Errorf("want summary %q in:\n%s", want, out)
	}
}

// TestPlainListSummaryOrdersByWorkflow keeps the summary reading in the order a
// task actually moves through, not map order, which would differ run to run.
func TestPlainListSummaryOrdersByWorkflow(t *testing.T) {
	tasks := []*models.Task{
		{ID: "a", Status: "done", Priority: "low", Title: "x"},
		{ID: "b", Status: "todo", Priority: "low", Title: "y"},
		{ID: "c", Status: "blocked", Priority: "low", Title: "z"},
	}
	got := plainStatusSummary(tasks)
	if got != "1 blocked, 1 todo, 1 done" {
		t.Errorf("summary = %q, want workflow order", got)
	}
}

// TestPlainListHandlesUnknownStatus makes sure a status outside the canonical
// progression is still counted rather than silently dropped from the total.
func TestPlainListHandlesUnknownStatus(t *testing.T) {
	tasks := []*models.Task{
		{ID: "a", Status: "todo", Priority: "low", Title: "x"},
		{ID: "b", Status: "wontfix", Priority: "low", Title: "y"},
	}
	got := plainStatusSummary(tasks)
	if !strings.Contains(got, "1 wontfix") {
		t.Errorf("summary %q drops the unrecognised status", got)
	}
}

// TestEveryRendererAgreesOnOrder is the regression that motivated pulling the sort
// out of the interactive list builder. The same command used to answer in three
// different orders: sorted when attached to a terminal, raw store order when piped,
// and raw store order again under --plain. Two renderers remain, and they agree.
func TestEveryRendererAgreesOnOrder(t *testing.T) {
	unsorted := []*models.Task{
		{ID: "d", Status: "done", Priority: "high", Title: "d"},
		{ID: "a", Status: "in-progress", Priority: "low", Title: "a"},
		{ID: "c", Status: "todo", Priority: "high", Title: "c"},
		{ID: "b", Status: "blocked", Priority: "medium", Title: "b"},
	}

	sorted := sortTasksForList(unsorted)

	want := []string{"b", "a", "c", "d"} // blocked, in-progress, todo, done
	for i, id := range want {
		if sorted[i].ID != id {
			t.Fatalf("sortTasksForList order = %s, want %v", renderIDs(sorted), want)
		}
	}

	// The plain renderer must not reorder what it is handed, or it becomes a
	// fourth opinion about order.
	var got []string
	for _, line := range strings.Split(sprintTaskListPlain(sorted), "\n") {
		if f := strings.Fields(line); len(f) >= 5 && f[0] != "Total:" {
			got = append(got, f[0])
		}
	}
	for i, id := range want {
		if i >= len(got) || got[i] != id {
			t.Fatalf("plain rows = %v, want %v", got, want)
		}
	}

	// The styled table must agree too; it is the other renderer over the same rows.
	var table []string
	for _, line := range strings.Split(renderTaskTable(sorted), "\n") {
		f := strings.Fields(stripANSI(line))
		if len(f) == 0 || f[0] == "ID" || strings.HasPrefix(f[0], "\u2500") {
			continue // header and the rule under it
		}
		table = append(table, f[0])
	}
	for i, id := range want {
		if i >= len(table) || table[i] != id {
			t.Fatalf("styled table rows = %v, want %v", table, want)
		}
	}
}

func renderIDs(tasks []*models.Task) string {
	ids := make([]string, len(tasks))
	for i, t := range tasks {
		ids[i] = t.ID
	}
	return strings.Join(ids, ",")
}

// stripANSI removes colour escapes so a styled rendering can be compared by field.
func stripANSI(s string) string {
	return ansiEscapeRE.ReplaceAllString(s, "")
}

var ansiEscapeRE = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// TestTaskTableNeverSplitsARune is the bug a Vietnamese title exposed: the table
// cut titles with a byte slice, so any multi-byte character near the cut produced
// invalid UTF-8 and the command's own output could not be read back. sed rejected
// the stream with "illegal byte sequence".
func TestTaskTableNeverSplitsARune(t *testing.T) {
	long := "Thêm xác thực JWT cho toàn bộ hệ thống người dùng và cả phần quản trị viên nội bộ"
	tasks := []*models.Task{{ID: "ST-1", Status: "todo", Priority: "high", Title: long}}

	for _, out := range []string{renderTaskTable(tasks), sprintTaskListPlain(tasks)} {
		if !utf8.ValidString(out) {
			t.Errorf("renderer emitted invalid UTF-8 for a multi-byte title:\n%q", out)
		}
	}
}

// TestSearchTruncateNeverSplitsARune covers the second copy of the same byte-slice
// cut, in search results.
func TestSearchTruncateNeverSplitsARune(t *testing.T) {
	for _, n := range []int{1, 5, 9, 12, 20} {
		got := truncate("Thêm xác thực JWT cho toàn bộ hệ thống", n)
		if !utf8.ValidString(got) {
			t.Errorf("truncate(.., %d) = %q, which is not valid UTF-8", n, got)
		}
	}
}

// TestTaskTableCarriesTheSameTotalAsPlain keeps the two remaining renderers from
// drifting on the one line that says whether the reader is seeing everything.
func TestTaskTableCarriesTheSameTotalAsPlain(t *testing.T) {
	tasks := plainListFixture()
	want := "Total: 3 tasks (1 in-progress, 1 todo, 1 done)"

	for name, out := range map[string]string{
		"styled table": stripANSI(renderTaskTable(tasks)),
		"plain":        sprintTaskListPlain(tasks),
	} {
		if !strings.Contains(out, want) {
			t.Errorf("%s is missing %q:\n%s", name, want, out)
		}
	}
}

// TestDocTableNeverSplitsARune covers the second copy of the byte-slice cut, in the
// document table. The doc store happens to hold no non-ASCII path today, so this is
// the only thing standing between the bug and its return.
func TestDocTableNeverSplitsARune(t *testing.T) {
	docs := []*models.Doc{{
		Path:  "hướng-dẫn/kiến-trúc-hệ-thống-và-các-quyết-định-thiết-kế-quan-trọng",
		Title: "Kiến trúc hệ thống và các quyết định thiết kế",
		Tags:  []string{"kiến-trúc", "tài-liệu"},
	}}
	if out := renderDocList(docs); !utf8.ValidString(out) {
		t.Errorf("renderDocList emitted invalid UTF-8:\n%q", out)
	}
}

// TestDocTableCarriesATotal keeps the doc listing's two renderers agreeing on the
// count line, the way the task listing's do.
func TestDocTableCarriesATotal(t *testing.T) {
	docs := []*models.Doc{
		{Path: "a", Title: "A"},
		{Path: "b", Title: "B"},
	}
	if out := stripANSI(renderDocList(docs)); !strings.Contains(out, "Total: 2 docs") {
		t.Errorf("doc table is missing its total:\n%s", out)
	}
	if got := pluralDocs(1); got != "doc" {
		t.Errorf("pluralDocs(1) = %q, want %q", got, "doc")
	}
}
