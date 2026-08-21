package storage

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

const (
	auditFileName      = "audit.jsonl"
	auditMaxFileSize   = 5 * 1024 * 1024 // 5 MB before rotation
	auditMaxBackups    = 2
	auditDefaultRecent = 50
	auditMaxRecent     = 500
)

// AuditStore provides append-only storage for MCP audit events.
// Events are stored as JSON-lines in ~/.knowns/audit.jsonl (global).
type AuditStore struct {
	dir string // directory containing audit.jsonl (e.g. ~/.knowns)
	mu  sync.Mutex
}

// NewAuditStore creates an AuditStore rooted at the given directory.
func NewAuditStore(dir string) *AuditStore {
	return &AuditStore{dir: dir}
}

// NewGlobalAuditStore creates an AuditStore at the global ~/.knowns/ path.
func NewGlobalAuditStore() *AuditStore {
	return NewAuditStore(GlobalRootPath())
}

func (as *AuditStore) filePath() string {
	return filepath.Join(as.dir, auditFileName)
}

// Append writes a single audit event to the log file.
// It is safe for concurrent use.
func (as *AuditStore) Append(event *models.AuditEvent) error {
	as.mu.Lock()
	defer as.mu.Unlock()

	// Rotate if needed.
	if err := as.rotateIfNeeded(); err != nil {
		// Non-fatal: rotation failure should not block audit writes.
		_ = err
	}

	path := as.filePath()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("audit: create dir: %w", err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("audit: open file: %w", err)
	}
	defer f.Close()

	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("audit: marshal event: %w", err)
	}
	data = append(data, '\n')

	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("audit: write event: %w", err)
	}
	return nil
}

// rotateIfNeeded checks the current file size and rotates if it exceeds the limit.
// Must be called with as.mu held.
func (as *AuditStore) rotateIfNeeded() error {
	path := as.filePath()
	info, err := os.Stat(path)
	if err != nil {
		return nil // file doesn't exist yet
	}
	if info.Size() < auditMaxFileSize {
		return nil
	}

	// Rotate: audit.jsonl.2 -> delete, audit.jsonl.1 -> audit.jsonl.2, audit.jsonl -> audit.jsonl.1
	for i := auditMaxBackups; i >= 1; i-- {
		src := fmt.Sprintf("%s.%d", path, i)
		if i == auditMaxBackups {
			_ = os.Remove(src)
		} else {
			dst := fmt.Sprintf("%s.%d", path, i+1)
			_ = os.Rename(src, dst)
		}
	}
	_ = os.Rename(path, fmt.Sprintf("%s.1", path))
	return nil
}

// AuditFilter specifies optional filters for querying audit events.
type AuditFilter struct {
	ToolName    string
	ActionClass string
	Result      string
	Project     string
	Since       *time.Time
	Until       *time.Time
}

// Recent returns the most recent N audit events, newest first.
func (as *AuditStore) Recent(limit int, filter *AuditFilter) ([]*models.AuditEvent, error) {
	if limit <= 0 {
		limit = auditDefaultRecent
	}
	if limit > auditMaxRecent {
		limit = auditMaxRecent
	}

	events, err := as.readRetained()
	if err != nil {
		return nil, err
	}

	// Apply filters.
	if filter != nil {
		events = filterEvents(events, filter)
	}

	// Reverse to newest-first.
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}

	// Limit.
	if len(events) > limit {
		events = events[:limit]
	}

	return events, nil
}

// Stats computes aggregate statistics over all audit events, optionally filtered.
func (as *AuditStore) Stats(filter *AuditFilter) (*models.AuditStats, error) {
	events, err := as.readRetained()
	if err != nil {
		return nil, err
	}

	if filter != nil {
		events = filterEvents(events, filter)
	}

	return aggregateAuditStats(events), nil
}

// filterEvents applies the filter criteria to a slice of events.
func filterEvents(events []*models.AuditEvent, f *AuditFilter) []*models.AuditEvent {
	result := make([]*models.AuditEvent, 0, len(events))
	for _, e := range events {
		if f.ToolName != "" && e.ToolName != f.ToolName {
			continue
		}
		if f.ActionClass != "" && e.ActionClass != f.ActionClass {
			continue
		}
		if f.Result != "" && e.Result != f.Result {
			continue
		}
		if f.Project != "" && e.ProjectRoot != f.Project {
			continue
		}
		if f.Since != nil && e.Timestamp.Before(*f.Since) {
			continue
		}
		if f.Until != nil && e.Timestamp.After(*f.Until) {
			continue
		}
		result = append(result, e)
	}
	return result
}

// readRetained reads every retained audit file (rotated backups oldest-first,
// then the live file) so analytics can report on the full retained window
// rather than only the current segment.
func (as *AuditStore) readRetained() ([]*models.AuditEvent, error) {
	path := as.filePath()
	paths := make([]string, 0, auditMaxBackups+1)
	for i := auditMaxBackups; i >= 1; i-- {
		paths = append(paths, fmt.Sprintf("%s.%d", path, i))
	}
	paths = append(paths, path)

	var events []*models.AuditEvent
	for _, p := range paths {
		segment, err := readAuditFile(p)
		if err != nil {
			return events, err
		}
		events = append(events, segment...)
	}

	sort.SliceStable(events, func(i, j int) bool {
		return events[i].Timestamp.Before(events[j].Timestamp)
	})
	return events, nil
}

func readAuditFile(path string) ([]*models.AuditEvent, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("audit: open file: %w", err)
	}
	defer f.Close()

	var events []*models.AuditEvent
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var event models.AuditEvent
		if err := json.Unmarshal(line, &event); err != nil {
			continue // skip malformed lines
		}
		if event.Timestamp.IsZero() || event.ToolName == "" {
			continue
		}
		events = append(events, &event)
	}
	if err := scanner.Err(); err != nil {
		return events, fmt.Errorf("audit: scan file: %w", err)
	}
	return events, nil
}

// Analytics aggregates retained audit events into per-day buckets and per-tool
// totals for the requested calendar range, resolved in the caller's timezone.
func (as *AuditStore) Analytics(query *models.AuditAnalyticsQuery) (*models.AuditAnalytics, error) {
	if query == nil {
		return nil, fmt.Errorf("audit: analytics query is required")
	}
	switch query.Days {
	case 7, 30, 90:
	default:
		return nil, fmt.Errorf("audit: analytics days must be 7, 30, or 90")
	}

	timezone := query.Timezone
	if timezone == "" {
		timezone = "UTC"
	}
	location, err := time.LoadLocation(timezone)
	if err != nil {
		return nil, fmt.Errorf("audit: load timezone %q: %w", timezone, err)
	}

	localNow := time.Now().In(location)
	rangeEnd := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	rangeStart := rangeEnd.AddDate(0, 0, -(query.Days - 1))
	rangeEndExclusive := rangeEnd.AddDate(0, 0, 1)

	retained, err := as.readRetained()
	if err != nil {
		return nil, err
	}

	coverage := auditCoverage(retained, location, rangeStart, rangeEnd)

	filtered := make([]*models.AuditEvent, 0, len(retained))
	for _, event := range retained {
		if event.Timestamp.Before(rangeStart) || !event.Timestamp.Before(rangeEndExclusive) {
			continue
		}
		if !query.AllProjects && query.Project != "" && event.ProjectRoot != query.Project {
			continue
		}
		filtered = append(filtered, event)
	}

	stats := aggregateAuditStats(filtered)
	analytics := &models.AuditAnalytics{
		AuditStats:   *stats,
		Timezone:     timezone,
		RangeStart:   rangeStart.Format(time.DateOnly),
		RangeEnd:     rangeEnd.Format(time.DateOnly),
		Coverage:     coverage,
		DailyBuckets: make([]models.AuditDailyBucket, query.Days),
		Tools:        make([]models.AuditToolStats, 0, len(stats.ByTool)),
		ByProject:    make(map[string]int),
	}

	type dayAccumulator struct {
		durationTotal int64
		tools         map[string]int
	}
	days := make(map[string]*dayAccumulator, query.Days)
	for i := 0; i < query.Days; i++ {
		date := rangeStart.AddDate(0, 0, i).Format(time.DateOnly)
		analytics.DailyBuckets[i] = models.AuditDailyBucket{
			Date:    date,
			Covered: coverage.StartDate != "" && date >= coverage.StartDate && date <= coverage.EndDate,
		}
		days[date] = &dayAccumulator{tools: make(map[string]int)}
	}

	toolDurations := make(map[string]int64, len(stats.ByTool))
	var durationTotal int64
	for _, event := range filtered {
		local := event.Timestamp.In(location)
		index := auditDaysBetween(rangeStart, local)
		if index < 0 || index >= len(analytics.DailyBuckets) {
			continue
		}

		bucket := &analytics.DailyBuckets[index]
		bucket.TotalCalls++
		switch event.Result {
		case "success":
			bucket.SuccessCount++
		case "error":
			bucket.ErrorCount++
		case "denied":
			bucket.DeniedCount++
		}
		bucket.NeedsAttention = bucket.ErrorCount + bucket.DeniedCount

		day := days[bucket.Date]
		day.durationTotal += event.DurationMs
		toolKey := auditToolKey(event)
		day.tools[toolKey]++
		toolDurations[toolKey] += event.DurationMs

		project := event.ProjectRoot
		if project == "" {
			project = models.UnknownAuditProject
		}
		analytics.ByProject[project]++
		durationTotal += event.DurationMs
	}

	for i := range analytics.DailyBuckets {
		bucket := &analytics.DailyBuckets[i]
		if bucket.TotalCalls > 0 {
			day := days[bucket.Date]
			bucket.AverageDurationMs = float64(day.durationTotal) / float64(bucket.TotalCalls)
			bucket.TopTool, bucket.TopToolCalls = topAuditTool(day.tools)
		}
		analytics.NeedsAttention += bucket.NeedsAttention
	}
	if analytics.TotalCalls > 0 {
		analytics.AverageDurationMs = float64(durationTotal) / float64(analytics.TotalCalls)
	}

	for tool, total := range stats.ByTool {
		analytics.Tools = append(analytics.Tools, models.AuditToolStats{
			Tool:              tool,
			TotalCalls:        total,
			ByResult:          stats.ByToolResult[tool],
			AverageDurationMs: float64(toolDurations[tool]) / float64(total),
		})
	}
	sort.Slice(analytics.Tools, func(i, j int) bool {
		if analytics.Tools[i].TotalCalls == analytics.Tools[j].TotalCalls {
			return analytics.Tools[i].Tool < analytics.Tools[j].Tool
		}
		return analytics.Tools[i].TotalCalls > analytics.Tools[j].TotalCalls
	})

	return analytics, nil
}

// aggregateAuditStats computes the shared totals used by both Stats and
// Analytics.
func aggregateAuditStats(events []*models.AuditEvent) *models.AuditStats {
	stats := &models.AuditStats{
		ByTool:        make(map[string]int),
		ByActionClass: make(map[string]int),
		ByResult:      make(map[string]int),
		ByToolResult:  make(map[string]map[string]int),
	}

	for _, e := range events {
		stats.TotalCalls++
		toolKey := auditToolKey(e)
		stats.ByTool[toolKey]++
		stats.ByActionClass[e.ActionClass]++
		stats.ByResult[e.Result]++
		if e.DryRun {
			stats.DryRunCount++
		} else {
			stats.ExecuteCount++
		}
		if _, ok := stats.ByToolResult[toolKey]; !ok {
			stats.ByToolResult[toolKey] = make(map[string]int)
		}
		stats.ByToolResult[toolKey][e.Result]++
	}

	return stats
}

func auditToolKey(event *models.AuditEvent) string {
	if event.Action != "" {
		return event.ToolName + "." + event.Action
	}
	return event.ToolName
}

// auditCoverage reports which part of the requested range the retained log can
// answer for. An empty log yields no coverage and a partial range.
func auditCoverage(events []*models.AuditEvent, location *time.Location, rangeStart, rangeEnd time.Time) models.AuditCoverage {
	if len(events) == 0 {
		return models.AuditCoverage{Partial: true}
	}

	oldest := events[0].Timestamp.In(location)
	newest := events[len(events)-1].Timestamp.In(location)

	// The live segment keeps recording up to now, so the covered window runs to
	// the end of the requested range; only the start is limited by rotation. A
	// day with no events inside that window is genuinely idle, not missing.
	start := rangeStart
	if oldest.After(start) {
		start = time.Date(oldest.Year(), oldest.Month(), oldest.Day(), 0, 0, 0, 0, location)
	}
	if newest.Before(rangeStart) || start.After(rangeEnd) {
		return models.AuditCoverage{Partial: true}
	}

	return models.AuditCoverage{
		StartDate: start.Format(time.DateOnly),
		EndDate:   rangeEnd.Format(time.DateOnly),
		Partial:   start.After(rangeStart),
	}
}

// auditDaysBetween counts whole calendar days from start to value.
func auditDaysBetween(start time.Time, value time.Time) int {
	startDay := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, start.Location())
	valueDay := time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, value.Location())
	return int(valueDay.Sub(startDay).Hours() / 24)
}

func topAuditTool(tools map[string]int) (string, int) {
	var topTool string
	topCalls := 0
	for tool, calls := range tools {
		if calls > topCalls || (calls == topCalls && tool < topTool) {
			topTool = tool
			topCalls = calls
		}
	}
	return topTool, topCalls
}
