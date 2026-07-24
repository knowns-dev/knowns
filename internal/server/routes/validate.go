package routes

import (
	"math"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
	knownsvalidate "github.com/howznguyen/knowns/internal/validate"
)

// ValidateRoutes handles /api/validate endpoints.
type ValidateRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
}

func (vr *ValidateRoutes) getStore() *storage.Store {
	if vr.mgr != nil {
		return vr.mgr.GetStore()
	}
	return vr.store
}

// Register wires the validate routes onto r.
func (vr *ValidateRoutes) Register(r chi.Router) {
	r.Get("/validate/sdd", vr.sdd)
}

// SDDWarning describes a single SDD validation finding.
type SDDWarning struct {
	Type    string `json:"type"`
	Entity  string `json:"entity"`
	Message string `json:"message"`
}

// roundPercent rounds a percentage to 1 decimal place.
func roundPercent(v float64) float64 {
	return math.Round(v*10) / 10
}

// sdd returns spec-driven-development stats.
// Status counting is driven by config.json statuses rather than hardcoded values.
//
// GET /api/validate/sdd
func (vr *ValidateRoutes) sdd(w http.ResponseWriter, r *http.Request) {
	tasks, err := vr.getStore().Tasks.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	docs, err := vr.getStore().Docs.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Load config for dynamic status definitions.
	cfg, _ := vr.getStore().Config.Load()
	statuses := cfg.Settings.Statuses
	if len(statuses) == 0 {
		statuses = []string{"todo", "in-progress", "in-review", "done", "blocked", "on-hold", "urgent"}
	}

	// Count tasks per configured status.
	byStatus := make(map[string]int, len(statuses))
	for _, s := range statuses {
		byStatus[s] = 0
	}

	var warnings []SDDWarning
	var passed []string
	withSpec := 0
	withoutSpec := 0

	for _, t := range tasks {
		byStatus[t.Status]++
		if t.Spec != "" {
			withSpec++
		} else {
			withoutSpec++
			warnings = append(warnings, SDDWarning{
				Type:    "task-no-spec",
				Entity:  t.ID,
				Message: "Task \"" + t.Title + "\" has no linked spec",
			})
		}
	}

	// Count spec docs referenced by tasks.
	specPaths := make(map[string]struct{})
	for _, t := range tasks {
		if t.Spec != "" {
			specPaths[t.Spec] = struct{}{}
		}
	}

	var coveragePercent float64
	if len(tasks) > 0 {
		coveragePercent = roundPercent(float64(withSpec) / float64(len(tasks)) * 100)
	}

	// AC completion per spec.
	acCompletion := make(map[string]map[string]interface{})
	for _, t := range tasks {
		if t.Spec == "" || len(t.AcceptanceCriteria) == 0 {
			continue
		}
		ac, ok := acCompletion[t.Spec]
		if !ok {
			ac = map[string]interface{}{"total": 0, "completed": 0, "percent": 0.0}
		}
		for _, criterion := range t.AcceptanceCriteria {
			ac["total"] = ac["total"].(int) + 1
			if criterion.Completed {
				ac["completed"] = ac["completed"].(int) + 1
			}
		}
		total := ac["total"].(int)
		completed := ac["completed"].(int)
		if total > 0 {
			ac["percent"] = roundPercent(float64(completed) / float64(total) * 100)
		}
		acCompletion[t.Spec] = ac
	}

	if warnings == nil {
		warnings = []SDDWarning{}
	}
	if passed == nil {
		passed = []string{}
	}

	decisionStats := map[string]int{
		"compliant": 0, "unassessed": 0, "conflicts": 0,
		"impactDeclared": 0, "impactInvalid": 0, "legacyImpactMissing": 0,
	}
	decisionValidation := knownsvalidate.Run(vr.getStore(), knownsvalidate.Options{Scope: "sdd"})
	for _, issue := range decisionValidation.Issues {
		switch issue.Code {
		case "SDD_SPEC_DECISIONS_COMPLIANT":
			decisionStats["compliant"]++
		case "SDD_SPEC_DECISIONS_UNASSESSED":
			decisionStats["unassessed"]++
		case "SDD_SPEC_DECISION_CONFLICT":
			decisionStats["conflicts"]++
		case "SDD_SYSTEM_DECISION_IMPACT_DECLARED":
			decisionStats["impactDeclared"]++
		case "SDD_SYSTEM_DECISION_IMPACT_INVALID":
			decisionStats["impactInvalid"]++
		case "SDD_LEGACY_SPEC_NO_SYSTEM_DECISION_IMPACT":
			decisionStats["legacyImpactMissing"]++
		default:
			continue
		}
		if issue.Level == "error" || issue.Level == "warning" {
			warnings = append(warnings, SDDWarning{Type: issue.Code, Entity: issue.Entity, Message: issue.Message})
		} else {
			passed = append(passed, issue.Message)
		}
	}

	_ = docs

	// Build task stats dynamically using config statuses.
	taskStatsMap := map[string]interface{}{
		"total":       len(tasks),
		"withSpec":    withSpec,
		"withoutSpec": withoutSpec,
	}
	// Include counts for each configured status (camelCase keys for UI compat).
	for _, s := range statuses {
		key := statusToCamelCase(s)
		taskStatsMap[key] = byStatus[s]
	}

	result := map[string]interface{}{
		"stats": map[string]interface{}{
			"specs": map[string]int{
				"total":       len(specPaths),
				"approved":    0,
				"draft":       0,
				"implemented": 0,
			},
			"tasks": taskStatsMap,
			"coverage": map[string]interface{}{
				"linked":  withSpec,
				"total":   len(tasks),
				"percent": coveragePercent,
			},
			"acCompletion": acCompletion,
			"decisions":    decisionStats,
		},
		"warnings": warnings,
		"passed":   passed,
	}

	respondJSON(w, http.StatusOK, result)
}

// statusToCamelCase converts a kebab-case status like "in-progress" to "inProgress".
func statusToCamelCase(s string) string {
	parts := make([]byte, 0, len(s))
	upper := false
	for i := 0; i < len(s); i++ {
		if s[i] == '-' {
			upper = true
			continue
		}
		if upper {
			if s[i] >= 'a' && s[i] <= 'z' {
				parts = append(parts, s[i]-32)
			} else {
				parts = append(parts, s[i])
			}
			upper = false
		} else {
			parts = append(parts, s[i])
		}
	}
	return string(parts)
}
