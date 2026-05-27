package routes

import (
	"context"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/howznguyen/knowns/internal/storage"
)

// RuntimeServicesRoutes handles GET /api/runtime/services.
type RuntimeServicesRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
}

func (rs *RuntimeServicesRoutes) getStore() *storage.Store {
	if rs.mgr != nil {
		return rs.mgr.GetStore()
	}
	return rs.store
}

// Register wires the runtime services routes onto r.
func (rs *RuntimeServicesRoutes) Register(r chi.Router) {
	r.Get("/runtime/services", rs.getServices)
}

// getServices returns status for all managed sub-processes.
//
// GET /api/runtime/services
func (rs *RuntimeServicesRoutes) getServices(w http.ResponseWriter, r *http.Request) {
	// Enforce a 2-second timeout on the entire handler.
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	done := make(chan []services.ServiceStatus, 1)
	go func() {
		done <- services.DetectAll(rs.getStore())
	}()

	var results []services.ServiceStatus
	select {
	case results = <-done:
	case <-ctx.Done():
		respondError(w, http.StatusGatewayTimeout, "service detection timed out")
		return
	}

	// Convert time.Duration to human-readable string for JSON serialization.
	type serviceResponse struct {
		Name            string            `json:"name"`
		Type            string            `json:"type"`
		Status          string            `json:"status"`
		PID             int               `json:"pid,omitempty"`
		Port            int               `json:"port,omitempty"`
		Uptime          string            `json:"uptime,omitempty"`
		EnabledInConfig bool              `json:"enabledInConfig"`
		Details         map[string]string `json:"details,omitempty"`
	}

	resp := make([]serviceResponse, 0, len(results))
	for _, s := range results {
		var uptime string
		if s.Uptime > 0 {
			uptime = s.Uptime.Round(time.Second).String()
		}
		resp = append(resp, serviceResponse{
			Name:            s.Name,
			Type:            s.Type,
			Status:          s.Status,
			PID:             s.PID,
			Port:            s.Port,
			Uptime:          uptime,
			EnabledInConfig: s.EnabledInConfig,
			Details:         s.Details,
		})
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"services": resp,
	})
}
