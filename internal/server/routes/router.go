// Package routes wires all REST API handlers into the chi.Router provided by
// the server package.
package routes

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

// requireStore returns a middleware that returns 503 when no project is active.
// It is a no-op when manager is nil (e.g. in tests that bypass the middleware).
func requireStore(manager *storage.Manager) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if manager != nil && manager.GetStore() == nil {
				respondError(w, http.StatusServiceUnavailable, "no active project")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// SetupRoutes registers all /api sub-routes onto r.
// The caller is responsible for mounting r at the /api prefix.
// manager may be nil when workspace switching is not needed (e.g. tests).
func SetupRoutes(r chi.Router, store *storage.Store, sse Broadcaster, projectRoot string, manager *storage.Manager, onWorkspaceSwitch ...func(string)) {
	// Project-scoped routes: guarded by requireStore so they return 503 in picker mode.
	r.Group(func(r chi.Router) {
		r.Use(requireStore(manager))

		// Tasks
		tr := &TaskRoutes{store: store, mgr: manager, sse: sse}
		tr.Register(r)

		// Docs
		dr := &DocRoutes{store: store, mgr: manager, sse: sse}
		dr.Register(r)

		// Config
		cr := &ConfigRoutes{store: store, mgr: manager}
		cr.Register(r)

		// Runtime services
		rsr := &RuntimeServicesRoutes{store: store, mgr: manager}
		rsr.Register(r)

		// Time tracking
		timr := &TimeRoutes{store: store, mgr: manager, sse: sse}
		timr.Register(r)

		// Search
		sr := &SearchRoutes{store: store, mgr: manager}
		sr.Register(r)

		// Templates
		tmplr := &TemplateRoutes{store: store, mgr: manager, sse: sse}
		tmplr.Register(r)

		// Validate
		vr := &ValidateRoutes{store: store, mgr: manager}
		vr.Register(r)

		// Notify (MCP → Server notifications)
		nr := &NotifyRoutes{store: store, mgr: manager, sse: sse}
		nr.Register(r)

		// Imports
		ir := &ImportRoutes{store: store, mgr: manager, sse: sse}
		ir.Register(r)

		// Activities
		ar := &ActivityRoutes{store: store, mgr: manager}
		ar.Register(r)

		// Chats
		chr := &ChatRoutes{
			store:       store,
			mgr:         manager,
			sse:         sse,
			projectRoot: projectRoot,
		}
		chr.Register(r)

		// Graph
		ggr := &GraphRoutes{store: store, mgr: manager}
		ggr.Register(r)

		// Embedding models (project-scoped, reads from global paths)
		emr := &EmbeddingModelRoutes{}
		emr.Register(r)

		// Memory
		mr := &MemoryRoutes{store: store, mgr: manager, sse: sse}
		mr.Register(r)
	})

	// Skills (project-root based, not store-dependent)
	skr := NewSkillRoutes(projectRoot)
	skr.Register(r)

	// User-level preferences (cross-project, no store needed)
	upr := &UserPrefsRoutes{store: storage.NewUserPrefsStore()}
	upr.Register(r)

	// Audit trail (global, not project-scoped)
	audr := &AuditRoutes{auditStore: storage.NewGlobalAuditStore()}
	audr.Register(r)

	// Workspaces (multi-project management, always available)
	if manager != nil {
		var switchCb func(string)
		if len(onWorkspaceSwitch) > 0 {
			switchCb = onWorkspaceSwitch[0]
		}
		wsr := &WorkspaceRoutes{manager: manager, sse: sse, onSwitch: switchCb}
		wsr.Register(r)
	}
}
