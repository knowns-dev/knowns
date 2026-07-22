package storage

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"gopkg.in/yaml.v3"
)

// TaskStore reads and writes task files from .knowns/tasks/ and .knowns/archive/.
type TaskStore struct {
	root          string
	lifecycleLock *taskLifecycleLock
}

func (ts *TaskStore) tasksDir() string   { return filepath.Join(ts.root, "tasks") }
func (ts *TaskStore) archiveDir() string { return filepath.Join(ts.root, "archive") }
func (ts *TaskStore) tombstonesDir() string {
	return filepath.Join(ts.root, "tombstones", "tasks")
}

// taskFrontmatter mirrors the YAML frontmatter in every task file.
// Fields use yaml tags that match the TypeScript output exactly.
type taskFrontmatter struct {
	ID          string   `yaml:"id"`
	Title       string   `yaml:"title"`
	Status      string   `yaml:"status"`
	Priority    string   `yaml:"priority"`
	Labels      []string `yaml:"labels"`
	CreatedAt   string   `yaml:"createdAt"`
	UpdatedAt   string   `yaml:"updatedAt"`
	CompletedAt string   `yaml:"completedAt,omitempty"`
	ArchivedAt  string   `yaml:"archivedAt,omitempty"`
	TimeSpent   int      `yaml:"timeSpent"`
	Assignee    string   `yaml:"assignee,omitempty"`
	Parent      string   `yaml:"parent,omitempty"`
	Spec        string   `yaml:"spec,omitempty"`
	Fulfills    []string `yaml:"fulfills,omitempty"`
	Order       *int     `yaml:"order,omitempty"`
}

// List returns all tasks from .knowns/tasks/.
func (ts *TaskStore) List() ([]*models.Task, error) {
	return ts.listDir(ts.tasksDir())
}

// ListArchived returns all tasks from .knowns/archive/.
func (ts *TaskStore) ListArchived() ([]*models.Task, error) {
	return ts.listDir(ts.archiveDir())
}

func (ts *TaskStore) listDir(dir string) ([]*models.Task, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("listDir %s: %w", dir, err)
	}
	// Parse all task files, deduplicating by ID (keep latest updatedAt).
	// Duplicates can exist from migration artifacts or old filename-rename bugs.
	byID := make(map[string]*models.Task)
	pathByID := make(map[string]string) // track kept file path per ID
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		task, err := ts.parseFile(path)
		if err != nil {
			continue
		}
		if existing, ok := byID[task.ID]; ok {
			// Duplicate found — keep the one with the latest updatedAt,
			// remove the stale file.
			if task.UpdatedAt.After(existing.UpdatedAt) {
				_ = os.Remove(pathByID[task.ID])
				byID[task.ID] = task
				pathByID[task.ID] = path
			} else {
				_ = os.Remove(path)
			}
		} else {
			byID[task.ID] = task
			pathByID[task.ID] = path
		}
	}
	// Build final task list and subtask relationships.
	var tasks []*models.Task
	for _, t := range byID {
		tasks = append(tasks, t)
	}
	for _, t := range tasks {
		if t.Parent == "" {
			continue
		}
		if parent, ok := byID[t.Parent]; ok {
			parent.Subtasks = append(parent.Subtasks, t.ID)
		}
	}
	return tasks, nil
}

// Get finds and parses a single task by ID, checking tasks/ then archive/.
func (ts *TaskStore) Get(id string) (*models.Task, error) {
	path, err := ts.findFile(id)
	if err != nil {
		return nil, err
	}
	return ts.parseFile(path)
}

func (ts *TaskStore) findFile(id string) (string, error) {
	for _, dir := range []string{ts.tasksDir(), ts.archiveDir()} {
		if p, err := ts.scanForID(dir, id); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("task %q not found", id)
}

func (ts *TaskStore) scanForID(dir, id string) (string, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return "", fmt.Errorf("not found")
	}
	if err != nil {
		return "", err
	}
	prefix := "task-" + id + " - "
	exact := "task-" + id + ".md"
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if n == exact || strings.HasPrefix(n, prefix) {
			return filepath.Join(dir, n), nil
		}
	}
	return "", fmt.Errorf("task %q not found in %s", id, dir)
}

// Create writes a new task file to .knowns/tasks/.
func (ts *TaskStore) Create(task *models.Task) error {
	return ts.withLifecycleLock(func() error { return ts.createUnlocked(task) })
}

func (ts *TaskStore) createUnlocked(task *models.Task) error {
	if task.ID == "" {
		return fmt.Errorf("task ID is required")
	}
	if _, err := ts.findFile(task.ID); err == nil {
		return fmt.Errorf("task ID %q already exists", task.ID)
	}
	reserved, err := ts.IsIDReserved(task.ID)
	if err != nil {
		return fmt.Errorf("check reserved task ID: %w", err)
	}
	if reserved {
		return fmt.Errorf("task ID %q is reserved by a deletion tombstone", task.ID)
	}
	if err := os.MkdirAll(ts.tasksDir(), 0755); err != nil {
		return fmt.Errorf("create task dir: %w", err)
	}
	path := filepath.Join(ts.tasksDir(), taskFilename(task.ID, task.Title))
	return ts.writeFile(path, task)
}

// Update writes an updated task to its existing file path.
// The file is NOT renamed when the title changes — the title lives in
// frontmatter, so the original filename remains stable and avoids duplicates.
func (ts *TaskStore) Update(task *models.Task) error {
	return ts.withLifecycleLock(func() error { return ts.updateUnlocked(task) })
}

func (ts *TaskStore) updateUnlocked(task *models.Task) error {
	oldPath, err := ts.findFile(task.ID)
	if err != nil {
		return ts.createUnlocked(task)
	}
	return ts.writeFile(oldPath, task)
}

// Delete removes a task file from tasks/ or archive/.
func (ts *TaskStore) Delete(id string) error {
	return ts.withLifecycleLock(func() error { return ts.deleteUnlocked(id) })
}

func (ts *TaskStore) deleteUnlocked(id string) error {
	path, err := ts.findFile(id)
	if err != nil {
		return err
	}
	return os.Remove(path)
}

// deleteAllUnlocked removes every active or archived file that resolves to the
// ID. Lifecycle hard-delete uses this to clean up legacy duplicate filenames.
func (ts *TaskStore) deleteAllUnlocked(id string) (int, error) {
	if _, err := ts.tombstonePath(id); err != nil {
		return 0, err
	}
	removed := 0
	for _, dir := range []string{ts.tasksDir(), ts.archiveDir()} {
		entries, err := os.ReadDir(dir)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return removed, err
		}
		prefix := "task-" + id + " - "
		exact := "task-" + id + ".md"
		for _, entry := range entries {
			if entry.IsDir() || (entry.Name() != exact && !strings.HasPrefix(entry.Name(), prefix)) {
				continue
			}
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !os.IsNotExist(err) {
				return removed, err
			}
			removed++
		}
	}
	return removed, nil
}

// Archive moves a task from tasks/ to archive/.
func (ts *TaskStore) Archive(id string) error {
	return ts.withLifecycleLock(func() error { return ts.archiveUnlocked(id) })
}

func (ts *TaskStore) archiveUnlocked(id string) error {
	src, err := ts.scanForID(ts.tasksDir(), id)
	if err != nil {
		return fmt.Errorf("archive: %w", err)
	}
	if err := os.MkdirAll(ts.archiveDir(), 0755); err != nil {
		return err
	}
	if _, err := ts.scanForID(ts.archiveDir(), id); err == nil {
		return fmt.Errorf("archive: task %q already exists in archive", id)
	}
	return os.Rename(src, filepath.Join(ts.archiveDir(), filepath.Base(src)))
}

// Unarchive moves a task from archive/ back to tasks/.
func (ts *TaskStore) Unarchive(id string) error {
	return ts.withLifecycleLock(func() error { return ts.unarchiveUnlocked(id) })
}

func (ts *TaskStore) unarchiveUnlocked(id string) error {
	src, err := ts.scanForID(ts.archiveDir(), id)
	if err != nil {
		return fmt.Errorf("unarchive: %w", err)
	}
	if err := os.MkdirAll(ts.tasksDir(), 0755); err != nil {
		return err
	}
	if _, err := ts.scanForID(ts.tasksDir(), id); err == nil {
		return fmt.Errorf("unarchive: task %q already exists in active storage", id)
	}
	return os.Rename(src, filepath.Join(ts.tasksDir(), filepath.Base(src)))
}

// SaveTombstone persists a content-free identity reservation for a deleted Task.
func (ts *TaskStore) SaveTombstone(tombstone *models.TaskTombstone) error {
	return ts.withLifecycleLock(func() error { return ts.saveTombstoneUnlocked(tombstone) })
}

func (ts *TaskStore) saveTombstoneUnlocked(tombstone *models.TaskTombstone) error {
	if tombstone == nil {
		return fmt.Errorf("task tombstone is required")
	}
	path, err := ts.tombstonePath(tombstone.ID)
	if err != nil {
		return err
	}
	if tombstone.DeletedAt.IsZero() {
		return fmt.Errorf("task tombstone deletedAt is required")
	}
	if strings.TrimSpace(tombstone.Reason) == "" {
		return fmt.Errorf("task tombstone reason is required")
	}
	if err := os.MkdirAll(ts.tombstonesDir(), 0755); err != nil {
		return fmt.Errorf("create task tombstone dir: %w", err)
	}
	data, err := json.MarshalIndent(tombstone, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal task tombstone: %w", err)
	}
	data = append(data, '\n')
	if err := writeFileExclusiveAtomic(path, data); err == nil {
		return nil
	} else if !os.IsExist(err) {
		return fmt.Errorf("persist task tombstone %q: %w", tombstone.ID, err)
	}

	existing, err := ts.GetTombstone(tombstone.ID)
	if err != nil {
		return fmt.Errorf("validate existing task tombstone %q: %w", tombstone.ID, err)
	}
	if sameTaskTombstone(existing, tombstone) {
		return nil
	}
	return fmt.Errorf("task tombstone %q already exists with different audit metadata", tombstone.ID)
}

func (ts *TaskStore) withLifecycleLock(fn func() error) error {
	if ts.lifecycleLock == nil {
		return fn()
	}
	return ts.lifecycleLock.with(context.Background(), fn)
}

func writeFileExclusiveAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tombstone-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	writeErr := func() error {
		if err := tmp.Chmod(0o644); err != nil {
			return err
		}
		if _, err := tmp.Write(data); err != nil {
			return err
		}
		return tmp.Sync()
	}()
	closeErr := tmp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Link(tmpPath, path)
}

func sameTaskTombstone(a, b *models.TaskTombstone) bool {
	return a != nil && b != nil &&
		a.ID == b.ID &&
		a.DeletedAt.Equal(b.DeletedAt) &&
		a.Actor == b.Actor &&
		a.Reason == b.Reason
}

// GetTombstone loads the identity reservation for a hard-deleted Task.
func (ts *TaskStore) GetTombstone(id string) (*models.TaskTombstone, error) {
	path, err := ts.tombstonePath(id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("task tombstone %q not found", id)
		}
		return nil, fmt.Errorf("read task tombstone %q: %w", id, err)
	}
	var tombstone models.TaskTombstone
	if err := json.Unmarshal(data, &tombstone); err != nil {
		return nil, fmt.Errorf("parse task tombstone %q: %w", id, err)
	}
	if tombstone.ID != id {
		return nil, fmt.Errorf("task tombstone identity mismatch: got %q, want %q", tombstone.ID, id)
	}
	return &tombstone, nil
}

// IsIDReserved reports whether a hard-delete tombstone prevents ID reuse.
func (ts *TaskStore) IsIDReserved(id string) (bool, error) {
	path, err := ts.tombstonePath(id)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, fmt.Errorf("stat task tombstone %q: %w", id, err)
}

func (ts *TaskStore) tombstonePath(id string) (string, error) {
	if id == "" || id == "." || id == ".." || filepath.Base(id) != id || strings.ContainsAny(id, `/\\`) || strings.IndexByte(id, 0) >= 0 {
		return "", fmt.Errorf("invalid task ID %q", id)
	}
	return filepath.Join(ts.tombstonesDir(), id+".json"), nil
}

// parseFile reads and parses a task markdown file.
func (ts *TaskStore) parseFile(path string) (*models.Task, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("parseFile %s: %w", path, err)
	}
	task, err := parseTaskContent(string(data))
	if err != nil {
		return nil, err
	}
	task.Archived = filepath.Clean(filepath.Dir(path)) == filepath.Clean(ts.archiveDir())
	return task, nil
}

// ParseTaskContent parses the raw content of a task file into a models.Task.
// Exported so it can be used in tests.
func ParseTaskContent(content string) (*models.Task, error) {
	return parseTaskContent(content)
}

func parseTaskContent(content string) (*models.Task, error) {
	yamlBlock, body := splitFrontmatter(content)
	if yamlBlock == "" {
		return nil, fmt.Errorf("missing YAML frontmatter")
	}
	var fm taskFrontmatter
	if err := yaml.Unmarshal([]byte(yamlBlock), &fm); err != nil {
		return nil, fmt.Errorf("parse frontmatter: %w", err)
	}

	task := &models.Task{
		ID:                  fm.ID,
		Title:               fm.Title,
		Status:              fm.Status,
		Priority:            fm.Priority,
		Labels:              normalizeStringSlice(fm.Labels),
		TimeSpent:           fm.TimeSpent,
		Assignee:            fm.Assignee,
		Parent:              fm.Parent,
		Spec:                fm.Spec,
		Fulfills:            normalizeStringSlice(fm.Fulfills),
		Order:               fm.Order,
		Description:         extractSection(body, "DESCRIPTION"),
		ImplementationPlan:  extractSection(body, "PLAN"),
		ImplementationNotes: extractSection(body, "NOTES"),
		AcceptanceCriteria:  extractAC(body),
	}
	task.CreatedAt, _ = parseISO(fm.CreatedAt)
	task.UpdatedAt, _ = parseISO(fm.UpdatedAt)
	completedAt, err := parseOptionalISO(fm.CompletedAt)
	if err != nil {
		return nil, fmt.Errorf("parse completedAt: %w", err)
	}
	task.CompletedAt = completedAt
	archivedAt, err := parseOptionalISO(fm.ArchivedAt)
	if err != nil {
		return nil, fmt.Errorf("parse archivedAt: %w", err)
	}
	task.ArchivedAt = archivedAt
	return task, nil
}

// writeFile serialises a Task and writes it to path.
func (ts *TaskStore) writeFile(path string, task *models.Task) error {
	return atomicWrite(path, []byte(renderTask(task)))
}

// patchLifecycleUnlocked changes only lifecycle frontmatter keys and preserves
// every unknown frontmatter field and markdown body byte-for-byte.
func (ts *TaskStore) patchLifecycleUnlocked(task *models.Task) error {
	if task == nil {
		return fmt.Errorf("patch Task lifecycle: task is required")
	}
	path, err := ts.findFile(task.ID)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read Task %q for lifecycle patch: %w", task.ID, err)
	}
	content := string(data)
	yamlBlock, body := splitFrontmatter(content)
	if yamlBlock == "" {
		return fmt.Errorf("patch Task %q lifecycle: missing YAML frontmatter", task.ID)
	}
	newline := "\n"
	if strings.Contains(content, "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(yamlBlock, "\r\n", "\n"), "\n")
	lines = patchTaskFrontmatterScalar(lines, "status", task.Status, false)
	lines = patchTaskFrontmatterScalar(lines, "updatedAt", "'"+formatISO(task.UpdatedAt)+"'", false)
	if task.CompletedAt == nil {
		lines = patchTaskFrontmatterScalar(lines, "completedAt", "", true)
	} else {
		lines = patchTaskFrontmatterScalar(lines, "completedAt", "'"+formatISO(*task.CompletedAt)+"'", false)
	}
	if task.ArchivedAt == nil {
		lines = patchTaskFrontmatterScalar(lines, "archivedAt", "", true)
	} else {
		lines = patchTaskFrontmatterScalar(lines, "archivedAt", "'"+formatISO(*task.ArchivedAt)+"'", false)
	}
	patched := "---" + newline + strings.Join(lines, newline) + newline + "---" + newline + body
	if _, err := parseTaskContent(patched); err != nil {
		return fmt.Errorf("validate Task %q lifecycle patch: %w", task.ID, err)
	}
	return atomicWrite(path, []byte(patched))
}

func patchTaskFrontmatterScalar(lines []string, key, value string, remove bool) []string {
	prefix := key + ":"
	for index, line := range lines {
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || !strings.HasPrefix(line, prefix) {
			continue
		}
		if remove {
			return append(lines[:index], lines[index+1:]...)
		}
		lines[index] = prefix + " " + value
		return lines
	}
	if remove {
		return lines
	}
	return append(lines, prefix+" "+value)
}

// RenderTask produces the canonical markdown file content for a task.
// Exported so it can be used in tests.
func RenderTask(task *models.Task) string { return renderTask(task) }

func renderTask(task *models.Task) string {
	var b strings.Builder

	// ---- Frontmatter ----
	b.WriteString("---\n")
	if isNumericString(task.ID) {
		fmt.Fprintf(&b, "id: '%s'\n", task.ID)
	} else {
		fmt.Fprintf(&b, "id: %s\n", task.ID)
	}
	fmt.Fprintf(&b, "title: %s\n", yamlScalar(task.Title))
	fmt.Fprintf(&b, "status: %s\n", task.Status)
	fmt.Fprintf(&b, "priority: %s\n", task.Priority)

	if len(task.Labels) == 0 {
		b.WriteString("labels: []\n")
	} else {
		b.WriteString("labels:\n")
		for _, l := range task.Labels {
			fmt.Fprintf(&b, "  - %s\n", l)
		}
	}

	fmt.Fprintf(&b, "createdAt: '%s'\n", formatISO(task.CreatedAt))
	fmt.Fprintf(&b, "updatedAt: '%s'\n", formatISO(task.UpdatedAt))
	if task.CompletedAt != nil {
		fmt.Fprintf(&b, "completedAt: '%s'\n", formatISO(*task.CompletedAt))
	}
	if task.ArchivedAt != nil {
		fmt.Fprintf(&b, "archivedAt: '%s'\n", formatISO(*task.ArchivedAt))
	}
	fmt.Fprintf(&b, "timeSpent: %d\n", task.TimeSpent)

	if task.Assignee != "" {
		fmt.Fprintf(&b, "assignee: %s\n", yamlScalar(task.Assignee))
	}
	if task.Parent != "" {
		fmt.Fprintf(&b, "parent: %s\n", task.Parent)
	}
	if task.Spec != "" {
		fmt.Fprintf(&b, "spec: %s\n", task.Spec)
	}
	if len(task.Fulfills) > 0 {
		b.WriteString("fulfills:\n")
		for _, f := range task.Fulfills {
			fmt.Fprintf(&b, "  - %s\n", f)
		}
	}
	if task.Order != nil {
		fmt.Fprintf(&b, "order: %d\n", *task.Order)
	}
	b.WriteString("---\n")

	// ---- Body ----
	fmt.Fprintf(&b, "# %s\n\n", task.Title)

	b.WriteString("## Description\n\n")
	b.WriteString(renderSection("DESCRIPTION", task.Description))
	b.WriteString("\n\n")

	b.WriteString("## Acceptance Criteria\n")
	b.WriteString("<!-- AC:BEGIN -->\n")
	if len(task.AcceptanceCriteria) > 0 {
		b.WriteString(renderAC(task.AcceptanceCriteria))
		b.WriteString("\n")
	}
	b.WriteString("<!-- AC:END -->\n")

	if task.ImplementationPlan != "" {
		b.WriteString("\n## Implementation Plan\n\n")
		b.WriteString(renderSection("PLAN", task.ImplementationPlan))
		b.WriteString("\n")
	}

	if task.ImplementationNotes != "" {
		b.WriteString("\n## Implementation Notes\n\n")
		b.WriteString(renderSection("NOTES", task.ImplementationNotes))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	return b.String()
}

// yamlScalar returns a YAML-safe scalar value for a string.
// Bracket-containing values use double quotes to keep generated task titles readable.
func yamlScalar(s string) string {
	if needsYAMLQuoting(s) {
		if strings.ContainsAny(s, "[]") {
			return strconv.Quote(s)
		}
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
	return s
}

func needsYAMLQuoting(s string) bool {
	if s == "" {
		return true
	}
	if s == "true" || s == "false" || s == "null" || s == "~" {
		return true
	}
	if isNumericString(s) {
		return true
	}
	for _, r := range s {
		if strings.ContainsRune(":#{}[]&*!|>'\"%@`", r) {
			return true
		}
	}
	if strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ") {
		return true
	}
	if strings.HasPrefix(s, "-") || strings.HasPrefix(s, "?") {
		return true
	}
	return false
}

// isNumericString returns true if s consists entirely of ASCII digits.
func isNumericString(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// normalizeStringSlice returns nil if the slice is nil or empty.
func normalizeStringSlice(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s
}

// parseISO parses an ISO 8601 / RFC3339 timestamp string.
func parseISO(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	for _, f := range []string{
		"2006-01-02T15:04:05.000Z07:00",
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05Z",
	} {
		if t, err := time.Parse(f, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse time %q", s)
}

func parseOptionalISO(s string) (*time.Time, error) {
	if s == "" {
		return nil, nil
	}
	parsed, err := parseISO(s)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

// formatISO formats a time.Time as the TypeScript-compatible ISO string.
func formatISO(t time.Time) string {
	if t.IsZero() {
		return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// taskIDPattern extracts the ID from a task filename.
var taskIDPattern = regexp.MustCompile(`^task-([^ ]+)`)

// IDFromFilename extracts a task ID from a filename like "task-abc123 - My Task.md".
func IDFromFilename(filename string) string {
	m := taskIDPattern.FindStringSubmatch(filename)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}
