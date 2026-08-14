package routes

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// TunnelManager controls the Cloudflare tunnel lifecycle.
type TunnelManager interface {
	Start() (string, error)
	Stop() error
	Status() TunnelStatus
}

// TunnelStatus describes the current tunnel state.
type TunnelStatus struct {
	Running     bool   `json:"running"`
	URL         string `json:"url,omitempty"`
	PID         int    `json:"pid,omitempty"`
	StartedByUs bool   `json:"startedByUs,omitempty"`
}

// SetupTunnelRoutes registers tunnel control endpoints.
func SetupTunnelRoutes(r chi.Router, tunnelMgr TunnelManager, broadcaster Broadcaster, protectionReady ...func() bool) {
	r.Post("/start", func(w http.ResponseWriter, r *http.Request) {
		if len(protectionReady) > 0 && protectionReady[0] != nil && !protectionReady[0]() {
			respondError(w, http.StatusForbidden, "password protection is required before starting a public tunnel")
			return
		}
		url, err := tunnelMgr.Start()
		if err != nil {
			handleTunnelError(w, err)
			return
		}
		status := tunnelMgr.Status()
		broadcastTunnelStatus(broadcaster, status)
		respondJSON(w, http.StatusOK, map[string]string{
			"url":    url,
			"status": "running",
		})
	})

	r.Post("/stop", func(w http.ResponseWriter, r *http.Request) {
		if err := tunnelMgr.Stop(); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]string{
				"error":   "tunnel failed to stop",
				"details": err.Error(),
			})
			return
		}
		status := tunnelMgr.Status()
		broadcastTunnelStatus(broadcaster, status)
		respondJSON(w, http.StatusOK, map[string]string{"status": "stopped"})
	})

	r.Get("/status", func(w http.ResponseWriter, r *http.Request) {
		respondJSON(w, http.StatusOK, tunnelMgr.Status())
	})
}

func handleTunnelError(w http.ResponseWriter, err error) {
	msg := err.Error()
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "cloudflared not found") || strings.Contains(lower, "executable file not found") {
		respondJSON(w, http.StatusBadRequest, map[string]string{
			"error":       "cloudflared not installed",
			"installHint": "brew install cloudflared",
		})
		return
	}
	if strings.Contains(lower, "timed out waiting for cloudflared public url") {
		respondJSON(w, http.StatusInternalServerError, map[string]string{
			"error":   "tunnel failed to start",
			"details": msg,
		})
		return
	}
	respondJSON(w, http.StatusInternalServerError, map[string]string{
		"error":   "tunnel failed to start",
		"details": msg,
	})
}

func broadcastTunnelStatus(broadcaster Broadcaster, status TunnelStatus) {
	if broadcaster == nil {
		return
	}
	broadcaster.Broadcast(SSEEvent{Type: "tunnel:status", Data: status})
}
