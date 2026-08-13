package routes

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/storage"
)

// NotifyRoutes handles /api/notify endpoints that receive push notifications
// from MCP tools and relay them as SSE events to connected UI clients.
type NotifyRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (nr *NotifyRoutes) getStore() *storage.Store {
	if nr.mgr != nil {
		return nr.mgr.GetStore()
	}
	return nr.store
}

// Register wires the notify routes onto r.
func (nr *NotifyRoutes) Register(r chi.Router) {
	r.Post("/notify/task/{id}", nr.notifyTask)
	r.Post("/notify/doc/*", nr.notifyDoc)
	r.Post("/notify/time", nr.notifyTime)
	r.Post("/notify/refresh", nr.notifyRefresh)
}

// notifyTask broadcasts a tasks:updated event for the given task ID.
// It reads the task from storage to send the full object to clients.
//
// POST /api/notify/task/{id}
func (nr *NotifyRoutes) notifyTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	task, err := nr.getStore().Tasks.Get(id)
	if err != nil {
		// Task not found — broadcast a full refresh instead.
		nr.sse.Broadcast(SSEEvent{Type: "tasks:refresh", Data: map[string]interface{}{}})
	} else {
		nr.sse.Broadcast(SSEEvent{Type: "tasks:updated", Data: map[string]interface{}{"task": newTaskResponse(task)}})
	}
	respondJSON(w, http.StatusOK, map[string]string{"status": "broadcast"})
}

// notifyDoc broadcasts a docs:updated event for the given doc path.
//
// POST /api/notify/doc/*
func (nr *NotifyRoutes) notifyDoc(w http.ResponseWriter, r *http.Request) {
	path := chi.URLParam(r, "*")
	path = strings.TrimPrefix(path, "/")
	nr.sse.Broadcast(SSEEvent{Type: "docs:updated", Data: map[string]string{"path": path}})
	respondJSON(w, http.StatusOK, map[string]string{"status": "broadcast"})
}

// notifyTime broadcasts a time:updated event with the current timer state.
//
// POST /api/notify/time
func (nr *NotifyRoutes) notifyTime(w http.ResponseWriter, r *http.Request) {
	state, err := nr.getStore().Time.GetState()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	nr.sse.Broadcast(SSEEvent{Type: "time:updated", Data: state})
	respondJSON(w, http.StatusOK, map[string]string{"status": "broadcast"})
}

// notifyRefresh broadcasts a full-refresh event so clients reload all data.
//
// POST /api/notify/refresh
func (nr *NotifyRoutes) notifyRefresh(w http.ResponseWriter, r *http.Request) {
	nr.sse.Broadcast(SSEEvent{Type: "refresh", Data: map[string]bool{"full": true}})
	respondJSON(w, http.StatusOK, map[string]string{"status": "broadcast"})
}
