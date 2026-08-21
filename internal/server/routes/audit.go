package routes

import (
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

// AuditRoutes handles /api/audit endpoints.
// Audit data is global (not project-scoped), so it uses its own AuditStore.
type AuditRoutes struct {
	auditStore *storage.AuditStore
}

// Register wires the audit routes onto r.
func (ar *AuditRoutes) Register(r chi.Router) {
	r.Get("/audit/recent", ar.recent)
	r.Get("/audit/stats", ar.stats)
	r.Get("/audit/analytics", ar.analytics)
}

// recent returns recent MCP audit events.
//
// GET /api/audit/recent?limit=50&tool=tasks&result=success&project=/path
func (ar *AuditRoutes) recent(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}

	filter := buildAuditFilter(r)

	events, err := ar.auditStore.Recent(limit, filter)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if events == nil {
		events = make([]*models.AuditEvent, 0)
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"events": events,
		"count":  len(events),
	})
}

// stats returns aggregate audit statistics.
//
// GET /api/audit/stats?project=/path&tool=tasks
func (ar *AuditRoutes) stats(w http.ResponseWriter, r *http.Request) {
	filter := buildAuditFilter(r)

	stats, err := ar.auditStore.Stats(filter)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, stats)
}

func buildAuditFilter(r *http.Request) *storage.AuditFilter {
	q := r.URL.Query()
	tool := q.Get("tool")
	result := q.Get("result")
	project := q.Get("project")
	from := q.Get("from")
	to := q.Get("to")

	if tool == "" && result == "" && project == "" && from == "" && to == "" {
		return nil
	}

	filter := &storage.AuditFilter{
		ToolName: tool,
		Result:   result,
		Project:  project,
	}

	// from/to are calendar days (YYYY-MM-DD) resolved in the caller's timezone;
	// an unparsable value is ignored rather than failing the whole query.
	location := time.UTC
	if tz := q.Get("timezone"); tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			location = loc
		}
	}
	if since, err := time.ParseInLocation(time.DateOnly, from, location); err == nil {
		filter.Since = &since
	}
	if until, err := time.ParseInLocation(time.DateOnly, to, location); err == nil {
		endOfDay := until.AddDate(0, 0, 1).Add(-time.Nanosecond)
		filter.Until = &endOfDay
	}

	return filter
}

// analytics returns per-day and per-tool aggregates for the audit charts.
//
// GET /api/audit/analytics?days=30&timezone=Asia/Ho_Chi_Minh&scope=project&project=/path
func (ar *AuditRoutes) analytics(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	days := 30
	if v := q.Get("days"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || (n != 7 && n != 30 && n != 90) {
			respondError(w, http.StatusBadRequest, "days must be 7, 30, or 90")
			return
		}
		days = n
	}

	timezone := q.Get("timezone")
	if timezone == "" {
		timezone = "UTC"
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		respondError(w, http.StatusBadRequest, "unknown timezone")
		return
	}

	scope := q.Get("scope")
	project := q.Get("project")
	allProjects := scope == "all" || (scope == "" && project == "")

	analytics, err := ar.auditStore.Analytics(&models.AuditAnalyticsQuery{
		Days:        days,
		Timezone:    timezone,
		Project:     project,
		AllProjects: allProjects,
	})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, analytics)
}
