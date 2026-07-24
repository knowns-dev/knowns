// Package validate provides shared validation logic for tasks, docs, and templates.
// Both CLI and MCP handlers use this package to ensure consistent checks.
package validate

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/howznguyen/knowns/internal/codegen"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/references"
	"github.com/howznguyen/knowns/internal/storage"
)

// Issue represents a single validation problem.
type Issue struct {
	Level   string `json:"level"`            // "error", "warning", "info"
	Code    string `json:"code"`             // e.g. "TASK_NO_TITLE"
	Message string `json:"message"`          // human-readable description
	Entity  string `json:"entity,omitempty"` // task ID or doc path
	Fixed   bool   `json:"fixed,omitempty"`  // true if auto-fixed
}

// Result holds the outcome of a validation run.
type Result struct {
	Issues       []Issue `json:"issues"`
	ErrorCount   int     `json:"errorCount"`
	WarningCount int     `json:"warningCount"`
	InfoCount    int     `json:"infoCount"`
	Valid        bool    `json:"valid"`
}

// Options configures the validation run.
type Options struct {
	Scope  string // "all", "tasks", "docs", "templates", "sdd"
	Entity string // validate a single entity (task ID or doc path)
	Strict bool   // treat warnings as errors
	Fix    bool   // auto-fix supported issues
}

// Reference-detection regexes.
var (
	codeRefRE                = regexp.MustCompile(`@code/([^\s\)]+)`)
	lockedDecisionRE         = regexp.MustCompile(`(?m)^\s*-\s*(D[1-9][0-9]*):\s*\S`)
	decisionComplianceLineRE = regexp.MustCompile(`(?mi)^\s*Spec Decision Compliance:\s*(.+)$`)
	decisionComplianceItemRE = regexp.MustCompile(`(?i)^\s*(D[1-9][0-9]*)\s*=\s*(pass|conflict)(?::\s*(.+))?\s*$`)
	systemDecisionImpactRE   = regexp.MustCompile(`(?mi)^\s*-\s*Impact:\s*(.+)$`)
)

// Valid status and priority values.
var (
	validStatuses = map[string]bool{
		"todo": true, "in-progress": true, "in-review": true,
		"done": true, "blocked": true, "on-hold": true, "urgent": true,
	}
	validPriorities = map[string]bool{
		"low": true, "medium": true, "high": true,
	}
)

const (
	memoryContentMaxRunes      = 12000
	proposedMemoryMaxAgeInDays = 30
)

// Run executes all validation checks according to opts and returns the result.
func Run(store *storage.Store, opts Options) *Result {
	if opts.Scope == "" {
		opts.Scope = "all"
	}

	var issues []Issue

	// Load all tasks and docs for cross-reference validation.
	tasks, _ := store.Tasks.List()
	docs, _ := store.Docs.List()

	taskIDs := make(map[string]bool, len(tasks))
	for _, t := range tasks {
		taskIDs[t.ID] = true
	}
	docPaths := make(map[string]bool, len(docs))
	for _, d := range docs {
		docPaths[d.Path] = true
	}

	// Load memory entries for cross-reference validation.
	memories, _ := store.Memory.List("")
	memoryIDs := make(map[string]bool, len(memories))
	for _, m := range memories {
		memoryIDs[m.ID] = true
	}

	// Build parent map for circular detection.
	parentMap := make(map[string]string, len(tasks))
	for _, t := range tasks {
		if t.Parent != "" {
			parentMap[t.ID] = t.Parent
		}
	}

	// --- Tasks ---
	if opts.Scope == "all" || opts.Scope == "tasks" || opts.Scope == "sdd" {
		for _, t := range tasks {
			if opts.Entity != "" && opts.Entity != t.ID {
				continue
			}
			issues = append(issues, validateTask(t, taskIDs, docPaths, memoryIDs, parentMap, opts, store)...)
		}
	}

	// --- Docs ---
	if opts.Scope == "all" || opts.Scope == "docs" || opts.Scope == "sdd" {
		for _, d := range docs {
			if d.IsImported {
				continue
			}
			if opts.Entity != "" && opts.Entity != d.Path {
				continue
			}
			fullDoc, err := store.Docs.Get(d.Path)
			if err != nil {
				issues = append(issues, Issue{
					Level:   "error",
					Code:    "DOC_PARSE_ERROR",
					Message: fmt.Sprintf("Failed to parse doc: %s", err.Error()),
					Entity:  d.Path,
				})
				continue
			}
			issues = append(issues, validateDoc(fullDoc, taskIDs, docPaths, memoryIDs, store)...)
			if opts.Scope == "sdd" {
				issues = append(issues, validateSpecDecisionContract(fullDoc)...)
			}
		}
	}

	// --- Memory ---
	if opts.Scope == "all" || opts.Scope == "memory" {
		for _, m := range memories {
			if opts.Entity != "" && opts.Entity != m.ID {
				continue
			}
			issues = append(issues, validateMemory(m, taskIDs, docPaths, memoryIDs, store)...)
		}
	}

	// --- Templates ---
	if opts.Scope == "all" || opts.Scope == "templates" {
		templates, templateListErr := store.Templates.List()
		if templateListErr != nil {
			issues = append(issues, Issue{
				Level:   "error",
				Code:    "TEMPLATE_LIST_ERROR",
				Message: fmt.Sprintf("Failed to list templates: %s", templateListErr.Error()),
			})
		} else {
			projectRoot := filepath.Dir(store.Root)
			engine := codegen.NewEngine(projectRoot)
			for _, tmpl := range templates {
				if opts.Entity != "" && opts.Entity != tmpl.Name {
					continue
				}
				issues = append(issues, validateTemplate(tmpl, engine, docPaths, opts)...)
			}
		}
	}

	// Strict mode: upgrade warnings → errors.
	if opts.Strict {
		for i := range issues {
			if issues[i].Level == "warning" {
				issues[i].Level = "error"
			}
		}
	}

	// Count by level.
	r := &Result{Issues: issues}
	for _, iss := range issues {
		switch iss.Level {
		case "error":
			r.ErrorCount++
		case "warning":
			r.WarningCount++
		case "info":
			r.InfoCount++
		}
	}
	r.Valid = r.ErrorCount == 0
	if r.Issues == nil {
		r.Issues = []Issue{}
	}
	return r
}

// ---------- Task validation ----------

func validateTask(t *models.Task, taskIDs, docPaths, memoryIDs map[string]bool, parentMap map[string]string, opts Options, store *storage.Store) []Issue {
	var issues []Issue

	// Title required.
	if t.Title == "" {
		issues = append(issues, Issue{
			Level: "error", Code: "TASK_NO_TITLE",
			Message: "Task has no title", Entity: t.ID,
		})
	}

	// Valid status.
	if t.Status == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "TASK_NO_STATUS",
			Message: "Task has no status", Entity: t.ID,
		})
	} else if !validStatuses[t.Status] {
		issues = append(issues, Issue{
			Level: "warning", Code: "TASK_INVALID_STATUS",
			Message: fmt.Sprintf("Task has non-standard status: %q", t.Status), Entity: t.ID,
		})
	}

	// Valid priority.
	if t.Priority == "" {
		issues = append(issues, Issue{
			Level: "info", Code: "TASK_NO_PRIORITY",
			Message: "Task has no priority", Entity: t.ID,
		})
	} else if !validPriorities[t.Priority] {
		issues = append(issues, Issue{
			Level: "warning", Code: "TASK_INVALID_PRIORITY",
			Message: fmt.Sprintf("Task has invalid priority: %q", t.Priority), Entity: t.ID,
		})
	}

	// Parent ref exists.
	if t.Parent != "" && !taskIDs[t.Parent] {
		issues = append(issues, Issue{
			Level: "error", Code: "BROKEN_TASK_REF",
			Message: fmt.Sprintf("Parent task %q not found", t.Parent), Entity: t.ID,
		})
	}

	// Circular parent chain.
	if t.Parent != "" {
		if detectCircularParent(t.ID, parentMap) {
			issues = append(issues, Issue{
				Level: "error", Code: "TASK_CIRCULAR_PARENT",
				Message: "Circular parent chain detected", Entity: t.ID,
			})
		}
	}

	// Spec ref exists.
	if t.Spec != "" && !docPaths[t.Spec] {
		issues = append(issues, Issue{
			Level: "warning", Code: "BROKEN_DOC_REF",
			Message: fmt.Sprintf("Spec doc %q not found", t.Spec), Entity: t.ID,
		})
	}

	// Fulfills without spec.
	if len(t.Fulfills) > 0 && t.Spec == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "TASK_FULFILLS_NO_SPEC",
			Message: "Task has fulfills but no linked spec", Entity: t.ID,
		})
	}

	// Duplicate labels.
	if len(t.Labels) > 1 {
		seen := make(map[string]bool, len(t.Labels))
		for _, l := range t.Labels {
			if seen[l] {
				issues = append(issues, Issue{
					Level: "info", Code: "TASK_DUPLICATE_LABELS",
					Message: fmt.Sprintf("Duplicate label: %q", l), Entity: t.ID,
				})
				break
			}
			seen[l] = true
		}
	}

	// Done but unchecked AC (applicable to all scopes, not just SDD).
	if t.Status == "done" && len(t.AcceptanceCriteria) > 0 {
		for i, ac := range t.AcceptanceCriteria {
			if !ac.Completed {
				issues = append(issues, Issue{
					Level: "warning", Code: "TASK_DONE_UNCHECKED_AC",
					Message: fmt.Sprintf("Task is done but AC #%d is not checked: %s", i+1, ac.Text),
					Entity:  t.ID,
				})
			}
		}
	}

	// Inline refs in description, plan, notes.
	checkText := t.Description + " " + t.ImplementationPlan + " " + t.ImplementationNotes
	issues = append(issues, validateSemanticRefs(checkText, t.ID, "warning", taskIDs, docPaths, memoryIDs, store)...)

	// @code/ references — check against AST index when it exists.
	issues = append(issues, validateCodeRefs(checkText, t.ID, store)...)

	// SDD-specific checks.
	if opts.Scope == "sdd" {
		if t.Spec != "" && len(t.AcceptanceCriteria) == 0 {
			issues = append(issues, Issue{
				Level: "warning", Code: "SDD_NO_AC",
				Message: "Task is linked to a spec but has no acceptance criteria", Entity: t.ID,
			})
		}
		if t.Spec != "" && store != nil {
			issues = append(issues, validateTaskSpecDecisionCompliance(t, store)...)
		}
	}

	return issues
}

func validateTaskSpecDecisionCompliance(task *models.Task, store *storage.Store) []Issue {
	spec, err := store.Docs.Get(task.Spec)
	if err != nil {
		return []Issue{{Level: "error", Code: "SDD_SPEC_DECISIONS_UNREADABLE", Message: fmt.Sprintf("Locked Decisions cannot be read from spec %q: %v", task.Spec, err), Entity: task.ID}}
	}
	// The System Decision Impact section is the versioned opt-in for the new
	// Decision contract. Legacy specs remain readable and receive doc-level
	// upgrade guidance without retroactively failing completed tasks.
	if _, contractEnabled := markdownSectionContent(spec.Content, "System Decision Impact"); !contractEnabled {
		return nil
	}
	ids, sectionFound, parseIssues := specDecisionIDs(spec)
	issues := append([]Issue(nil), parseIssues...)
	if !sectionFound || len(ids) == 0 {
		return issues
	}
	checks := parseSpecDecisionCompliance(task.ImplementationNotes)
	strictState := task.Status == "in-review" || task.Status == "done"
	assessmentRequired := strictState || task.Status == "in-progress"
	missing := make([]string, 0)
	for _, id := range ids {
		check, ok := checks[id]
		if !ok {
			missing = append(missing, id)
			continue
		}
		if check.status == "conflict" {
			note := strings.TrimSpace(check.note)
			if note == "" {
				note = "no conflict reason supplied"
			}
			issues = append(issues, Issue{Level: "error", Code: "SDD_SPEC_DECISION_CONFLICT", Message: fmt.Sprintf("Spec Decision %s conflicts with task execution: %s", id, note), Entity: task.ID})
		}
	}
	if len(missing) > 0 && assessmentRequired {
		level := "warning"
		if strictState {
			level = "error"
		}
		issues = append(issues, Issue{Level: level, Code: "SDD_SPEC_DECISIONS_UNASSESSED", Message: fmt.Sprintf("Spec Decisions not assessed for linked spec %q: %s; append `Spec Decision Compliance: D1=pass, ...`", task.Spec, strings.Join(missing, ", ")), Entity: task.ID})
	} else if len(missing) == 0 && assessmentRequired && !hasIssueCode(issues, "SDD_SPEC_DECISION_CONFLICT") {
		issues = append(issues, Issue{Level: "info", Code: "SDD_SPEC_DECISIONS_COMPLIANT", Message: fmt.Sprintf("All %d Spec Decisions from %q are assessed as compliant", len(ids), task.Spec), Entity: task.ID})
	}
	return issues
}

type decisionComplianceCheck struct {
	status string
	note   string
}

func parseSpecDecisionCompliance(notes string) map[string]decisionComplianceCheck {
	matches := decisionComplianceLineRE.FindAllStringSubmatch(notes, -1)
	checks := map[string]decisionComplianceCheck{}
	if len(matches) == 0 {
		return checks
	}
	for _, raw := range strings.FieldsFunc(matches[len(matches)-1][1], func(r rune) bool { return r == ',' || r == ';' }) {
		parts := decisionComplianceItemRE.FindStringSubmatch(raw)
		if len(parts) == 0 {
			continue
		}
		checks[strings.ToUpper(parts[1])] = decisionComplianceCheck{status: strings.ToLower(parts[2]), note: strings.TrimSpace(parts[3])}
	}
	return checks
}

func validateSpecDecisionContract(doc *models.Doc) []Issue {
	if doc == nil || !hasFoldedString(doc.Tags, "spec") {
		return nil
	}
	ids, sectionFound, issues := specDecisionIDs(doc)
	if !sectionFound {
		issues = append(issues, Issue{Level: "info", Code: "SDD_LEGACY_SPEC_NO_LOCKED_DECISIONS", Message: "Legacy spec has no Locked Decisions section; add stable D1/D2 IDs when it is next revised", Entity: doc.Path})
	} else if len(ids) > 0 {
		issues = append(issues, Issue{Level: "info", Code: "SDD_SPEC_DECISIONS_DECLARED", Message: fmt.Sprintf("Spec declares %d stable Locked Decisions", len(ids)), Entity: doc.Path})
	}

	impact, impactFound := markdownSectionContent(doc.Content, "System Decision Impact")
	if !impactFound {
		issues = append(issues, Issue{Level: "info", Code: "SDD_LEGACY_SPEC_NO_SYSTEM_DECISION_IMPACT", Message: "Legacy spec has no System Decision Impact declaration; declare none, existing, draft new, or replacement when next revised", Entity: doc.Path})
		return issues
	}
	match := systemDecisionImpactRE.FindStringSubmatch(impact)
	if len(match) == 0 || !validSystemDecisionImpact(match[1]) {
		issues = append(issues, Issue{Level: "error", Code: "SDD_SYSTEM_DECISION_IMPACT_INVALID", Message: "System Decision Impact must declare one of: none, existing, draft new, replacement", Entity: doc.Path})
	} else {
		issues = append(issues, Issue{Level: "info", Code: "SDD_SYSTEM_DECISION_IMPACT_DECLARED", Message: "System Decision impact is declared: " + strings.TrimSpace(match[1]), Entity: doc.Path})
	}
	return issues
}

func specDecisionIDs(doc *models.Doc) ([]string, bool, []Issue) {
	if doc == nil {
		return nil, false, nil
	}
	section, found := markdownSectionContent(doc.Content, "Locked Decisions")
	if !found {
		return nil, false, nil
	}
	matches := lockedDecisionRE.FindAllStringSubmatch(section, -1)
	ids := make([]string, 0, len(matches))
	seen := map[string]bool{}
	var issues []Issue
	for _, match := range matches {
		id := strings.ToUpper(match[1])
		if seen[id] {
			issues = append(issues, Issue{Level: "error", Code: "SDD_SPEC_DECISION_DUPLICATE", Message: fmt.Sprintf("Locked Decision ID %s is duplicated", id), Entity: doc.Path})
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		issues = append(issues, Issue{Level: "warning", Code: "SDD_SPEC_DECISIONS_EMPTY", Message: "Locked Decisions section has no stable IDs such as D1 or D2", Entity: doc.Path})
	}
	return ids, true, issues
}

func markdownSectionContent(content, title string) (string, bool) {
	lines := strings.Split(content, "\n")
	start := -1
	level := 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") {
			continue
		}
		hashes := len(trimmed) - len(strings.TrimLeft(trimmed, "#"))
		heading := strings.TrimSpace(strings.TrimLeft(trimmed, "#"))
		if start < 0 && strings.EqualFold(heading, title) {
			start, level = i+1, hashes
			continue
		}
		if start >= 0 && hashes <= level {
			return strings.Join(lines[start:i], "\n"), true
		}
	}
	if start >= 0 {
		return strings.Join(lines[start:], "\n"), true
	}
	return "", false
}

func validSystemDecisionImpact(value string) bool {
	value = strings.ToLower(strings.Trim(strings.TrimSpace(value), "."))
	for _, allowed := range []string{"none", "existing", "draft new", "replacement"} {
		if value == allowed || strings.HasPrefix(value, allowed+" ") {
			return true
		}
	}
	return false
}

func hasFoldedString(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

func hasIssueCode(issues []Issue, code string) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

// detectCircularParent walks the parent chain and returns true if a cycle is found.
func detectCircularParent(id string, parentMap map[string]string) bool {
	visited := map[string]bool{id: true}
	cur := parentMap[id]
	for cur != "" {
		if visited[cur] {
			return true
		}
		visited[cur] = true
		cur = parentMap[cur]
	}
	return false
}

// ---------- Doc validation ----------

func validateDoc(d *models.Doc, taskIDs, docPaths, memoryIDs map[string]bool, store *storage.Store) []Issue {
	var issues []Issue

	if d.Title == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "DOC_NO_TITLE",
			Message: "Doc has no title", Entity: d.Path,
		})
	}

	if d.Description == "" {
		issues = append(issues, Issue{
			Level: "info", Code: "DOC_NO_DESCRIPTION",
			Message: "Doc has no description", Entity: d.Path,
		})
	}

	if d.Content == "" {
		issues = append(issues, Issue{
			Level: "info", Code: "DOC_NO_CONTENT",
			Message: "Doc has no content", Entity: d.Path,
		})
	}

	// Inline refs in doc content.
	issues = append(issues, validateSemanticRefs(d.Content, d.Path, "info", taskIDs, docPaths, memoryIDs, store)...)

	// @code/ references — check against AST index when it exists.
	issues = append(issues, validateCodeRefs(d.Content, d.Path, store)...)

	return issues
}

// ---------- Memory validation ----------

func validateMemory(m *models.MemoryEntry, taskIDs, docPaths, memoryIDs map[string]bool, store *storage.Store) []Issue {
	var issues []Issue

	if m.Title == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_NO_TITLE",
			Message: "Memory entry has no title", Entity: m.ID,
		})
	}

	if m.Content == "" {
		issues = append(issues, Issue{
			Level: "info", Code: "MEMORY_NO_CONTENT",
			Message: "Memory entry has no content", Entity: m.ID,
		})
	}

	if !models.ValidMemoryLayer(m.Layer) {
		issues = append(issues, Issue{
			Level: "error", Code: "MEMORY_INVALID_LAYER",
			Message: fmt.Sprintf("Memory entry has invalid layer: %q", m.Layer), Entity: m.ID,
		})
	}

	if m.Status == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_MISSING_STATUS",
			Message: "Memory entry has no lifecycle status", Entity: m.ID,
		})
	} else if !models.ValidMemoryStatus(m.Status) {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_INVALID_STATUS",
			Message: fmt.Sprintf("Memory entry has invalid lifecycle status: %q", m.Status), Entity: m.ID,
		})
	}

	if m.Confidence != "" && !models.ValidMemoryConfidence(m.Confidence) {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_INVALID_CONFIDENCE",
			Message: fmt.Sprintf("Memory entry has invalid confidence: %q", m.Confidence), Entity: m.ID,
		})
	}

	if missing := m.MissingTrustMetadata(); len(missing) > 0 {
		issues = append(issues, Issue{
			Level:   "warning",
			Code:    "MEMORY_MISSING_TRUST_METADATA",
			Message: fmt.Sprintf("Memory entry is missing trust metadata: %s", strings.Join(missing, ", ")),
			Entity:  m.ID,
		})
	}

	if m.TTLDays > 0 && !m.LastVerified.IsZero() {
		expiresAt := m.LastVerified.Add(time.Duration(m.TTLDays) * 24 * time.Hour)
		if time.Now().UTC().After(expiresAt) {
			issues = append(issues, Issue{
				Level: "warning", Code: "MEMORY_TTL_EXPIRED",
				Message: fmt.Sprintf("Memory TTL expired on %s", expiresAt.Format("2006-01-02")), Entity: m.ID,
			})
		}
	}

	if len(m.Sources) == 0 {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_MISSING_SOURCE",
			Message: "Memory entry has no source references", Entity: m.ID,
		})
	} else {
		issues = append(issues, validateMemorySources(m, taskIDs, docPaths, memoryIDs, store)...)
	}

	if len([]rune(m.Content)) > memoryContentMaxRunes {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_CONTENT_TOO_LONG",
			Message: fmt.Sprintf("Memory content is longer than %d characters", memoryContentMaxRunes), Entity: m.ID,
		})
	}

	if m.Status == models.MemoryStatusProposed {
		effective := m.UpdatedAt
		if effective.IsZero() {
			effective = m.CreatedAt
		}
		if !effective.IsZero() && effective.Before(time.Now().UTC().Add(-proposedMemoryMaxAgeInDays*24*time.Hour)) {
			issues = append(issues, Issue{
				Level: "warning", Code: "MEMORY_OLD_PROPOSED",
				Message: fmt.Sprintf("Proposed memory is older than %d days", proposedMemoryMaxAgeInDays), Entity: m.ID,
			})
		}
	}

	if m.Status == models.MemoryStatusMerged && m.MergedInto == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_MERGED_MISSING_TARGET",
			Message: "Merged memory tombstone must point to mergedInto", Entity: m.ID,
		})
	}

	if m.Status == models.MemoryStatusRejected && m.RejectedReason == "" {
		issues = append(issues, Issue{
			Level: "warning", Code: "MEMORY_REJECTED_MISSING_REASON",
			Message: "Rejected memory should record rejectedReason", Entity: m.ID,
		})
	}

	// Inline refs in memory content.
	issues = append(issues, validateSemanticRefs(m.Content, m.ID, "info", taskIDs, docPaths, memoryIDs, store)...)

	// @code/ references — check against AST index when it exists.
	issues = append(issues, validateCodeRefs(m.Content, m.ID, store)...)

	return issues
}

func validateMemorySources(m *models.MemoryEntry, taskIDs, docPaths, memoryIDs map[string]bool, store *storage.Store) []Issue {
	var issues []Issue
	for _, source := range m.Sources {
		ref, ok := parseMemorySourceRef(source)
		if !ok {
			continue
		}
		switch ref.Type {
		case "task":
			if !taskIDs[ref.Target] {
				issues = append(issues, brokenMemorySourceIssue(m.ID, source))
			}
		case "doc":
			if !docPaths[ref.Target] {
				issues = append(issues, brokenMemorySourceIssue(m.ID, source))
			}
		case "memory":
			if ref.Target != m.ID && !memoryIDs[ref.Target] {
				issues = append(issues, brokenMemorySourceIssue(m.ID, source))
			}
		case "decision":
			issues = append(issues, validateMemoryDecisionSource(m.ID, ref.Target, source, store)...)
		}
	}
	return issues
}

type memorySourceRef struct {
	Type   string
	Target string
}

func parseMemorySourceRef(source string) (memorySourceRef, bool) {
	source = strings.TrimSpace(source)
	if source == "" {
		return memorySourceRef{}, false
	}
	if ref, ok := references.Parse(source); ok {
		return memorySourceRef{Type: ref.Type, Target: ref.Target}, true
	}
	for _, prefix := range []struct {
		raw string
		typ string
	}{
		{"@task/", "task"},
		{"@memory/", "memory"},
		{"@decision/", "decision"},
	} {
		if !strings.HasPrefix(source, prefix.raw) {
			continue
		}
		target := strings.TrimSpace(strings.TrimPrefix(source, prefix.raw))
		target = strings.TrimRight(target, ".,;)")
		if target == "" {
			return memorySourceRef{}, false
		}
		return memorySourceRef{Type: prefix.typ, Target: target}, true
	}
	return memorySourceRef{}, false
}

func brokenMemorySourceIssue(entityID, source string) Issue {
	return Issue{
		Level: "warning", Code: "MEMORY_BROKEN_SOURCE_REF",
		Message: fmt.Sprintf("Memory source reference is broken: %s", strings.TrimSpace(source)), Entity: entityID,
	}
}

func validateMemoryDecisionSource(entityID, decisionID, source string, store *storage.Store) []Issue {
	if store == nil || store.Decisions == nil {
		return nil
	}
	decision, err := store.Decisions.Get(decisionID)
	if err != nil {
		return []Issue{brokenMemorySourceIssue(entityID, source)}
	}
	if decision.Status == models.DecisionStatusSuperseded || len(decision.SupersededBy) > 0 {
		return []Issue{{
			Level: "warning", Code: "MEMORY_SOURCE_DECISION_SUPERSEDED",
			Message: fmt.Sprintf("Memory source decision is superseded: %s", strings.TrimSpace(source)), Entity: entityID,
		}}
	}
	return nil
}

// ---------- Template validation ----------

func validateTemplate(tmpl *models.Template, engine *codegen.Engine, docPaths map[string]bool, opts Options) []Issue {
	var issues []Issue

	if tmpl.Name == "" {
		issues = append(issues, Issue{
			Level: "error", Code: "TEMPLATE_NO_NAME",
			Message: "Template has no name", Entity: tmpl.Path,
		})
	}

	if len(tmpl.Actions) == 0 {
		issues = append(issues, Issue{
			Level: "warning", Code: "TEMPLATE_NO_ACTIONS",
			Message: "Template has no actions defined", Entity: tmpl.Name,
		})
	}

	// Check each action's template file and path syntax.
	for i, action := range tmpl.Actions {
		if action.Template != "" {
			tplFile := filepath.Join(tmpl.Path, action.Template)
			if _, err := os.Stat(tplFile); os.IsNotExist(err) {
				issues = append(issues, Issue{
					Level: "error", Code: "TEMPLATE_FILE_MISSING",
					Message: fmt.Sprintf("action[%d] template file %q not found", i+1, action.Template),
					Entity:  tmpl.Name,
				})
			} else {
				content, err := os.ReadFile(tplFile)
				if err == nil {
					if _, err := engine.ValidateTemplate(string(content)); err != nil {
						issues = append(issues, Issue{
							Level: "error", Code: "TEMPLATE_PARSE_ERROR",
							Message: fmt.Sprintf("action[%d] %q parse error: %s", i+1, action.Template, err),
							Entity:  tmpl.Name,
						})
					}
				}
			}
		}
		if action.Path != "" {
			if _, err := engine.ValidateTemplate(action.Path); err != nil {
				issues = append(issues, Issue{
					Level: "error", Code: "TEMPLATE_PATH_ERROR",
					Message: fmt.Sprintf("action[%d] path %q parse error: %s", i+1, action.Path, err),
					Entity:  tmpl.Name,
				})
			}
		}
	}

	// Linked doc ref.
	if tmpl.Doc != "" && !docPaths[tmpl.Doc] {
		severity := "warning"
		if opts.Fix {
			severity = "info"
		}
		issues = append(issues, Issue{
			Level: severity, Code: "BROKEN_DOC_REF",
			Message: fmt.Sprintf("Linked doc %q not found", tmpl.Doc), Entity: tmpl.Name,
		})
	}

	return issues
}

// validateCodeRefs checks @code/ references in content when the AST index exists.
// It silently skips when code_edges table has no rows.
func validateCodeRefs(content, entityID string, store *storage.Store) []Issue {
	var issues []Issue

	// Skip if store is nil or AST index doesn't exist
	if store == nil || !store.CodeRefIndexExists() {
		return issues
	}

	for _, match := range codeRefRE.FindAllStringSubmatch(content, -1) {
		ref := strings.TrimRight(match[1], ".,;)")
		// Parse @code/<filepath> or @code/<filepath>::<symbol>
		var docPath, symbol string
		if idx := strings.Index(ref, "::"); idx >= 0 {
			docPath = ref[:idx]
			symbol = ref[idx+2:]
		} else {
			docPath = ref
			symbol = ""
		}

		// Check if the ref exists in the AST index
		if !store.CodeRefExists(docPath, symbol) {
			issues = append(issues, Issue{
				Level:   "error",
				Code:    "BROKEN_CODE_REF",
				Message: fmt.Sprintf("Broken code ref: @code/%s (symbol not found in AST index)", ref),
				Entity:  entityID,
			})
		}
	}

	return issues
}

func validateSemanticRefs(content, entityID, level string, taskIDs, docPaths, memoryIDs map[string]bool, store *storage.Store) []Issue {
	var issues []Issue
	for _, ref := range references.Extract(content) {
		if !ref.ValidRelation {
			issues = append(issues, Issue{
				Level:   level,
				Code:    "INVALID_SEMANTIC_REF_RELATION",
				Message: fmt.Sprintf("Reference %s uses unsupported relation %q", ref.Raw, ref.Relation),
				Entity:  entityID,
			})
			continue
		}
		switch ref.Type {
		case "task":
			if !taskIDs[ref.Target] {
				issues = append(issues, Issue{
					Level: level, Code: "BROKEN_TASK_REF",
					Message: fmt.Sprintf("Referenced task %s not found", ref.Canonical), Entity: entityID,
				})
			}
		case "doc":
			if !docPaths[ref.Target] {
				issues = append(issues, Issue{
					Level: level, Code: "BROKEN_DOC_REF",
					Message: fmt.Sprintf("Referenced doc %s not found", ref.Canonical), Entity: entityID,
				})
			}
		case "memory":
			if ref.Target != entityID && !memoryIDs[ref.Target] {
				issues = append(issues, Issue{
					Level: level, Code: "BROKEN_MEMORY_REF",
					Message: fmt.Sprintf("Referenced memory %s not found", ref.Canonical), Entity: entityID,
				})
			}
		case "decision":
			if store == nil || store.Decisions == nil {
				continue
			}
			if _, err := store.Decisions.Get(ref.Target); err != nil {
				issues = append(issues, Issue{
					Level: level, Code: "BROKEN_DECISION_REF",
					Message: fmt.Sprintf("Referenced decision %s not found", ref.Canonical), Entity: entityID,
				})
			}
		case "template":
			if store == nil || store.Templates == nil {
				continue
			}
			if _, err := store.Templates.Get(ref.Target); err != nil {
				issues = append(issues, Issue{
					Level: level, Code: "BROKEN_TEMPLATE_REF",
					Message: fmt.Sprintf("Referenced template %s not found", ref.Canonical), Entity: entityID,
				})
			}
		}
	}
	return issues
}

// LooksLikeTaskID returns true if s looks like a task ID rather than a doc path.
func LooksLikeTaskID(s string) bool {
	if len(s) > 20 {
		return false
	}
	if strings.Contains(s, "/") {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-') {
			return false
		}
	}
	return true
}
