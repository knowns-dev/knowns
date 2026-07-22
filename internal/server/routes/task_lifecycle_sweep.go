package routes

import (
	"context"
	"time"

	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
)

const DefaultTaskAutoArchiveInterval = time.Hour

// StartTaskAutoArchiveSweeper runs one bounded startup sweep and then repeats
// at interval until ctx is cancelled. It only invokes AutoArchive; it never
// purges or hard-deletes Tasks.
func StartTaskAutoArchiveSweeper(ctx context.Context, getStore func() *storage.Store, sse Broadcaster, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultTaskAutoArchiveInterval
	}
	run := func() {
		store := getStore()
		if store == nil {
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		service := tasklifecycle.New(store, tasklifecycle.WithHooks(tasklifecycle.Hooks{
			IndexTask:  func(id string) error { return search.ReconcileTaskIndex(store, id) },
			RemoveTask: func(id string) error { return search.ReconcileTaskRemoval(store, id) },
			Emit: func(event tasklifecycle.Event) error {
				if sse != nil {
					sse.Broadcast(SSEEvent{Type: "tasks:lifecycle", Data: event})
				}
				return nil
			},
		}))
		result, err := service.AutoArchive(runCtx, "auto-archive")
		if sse != nil && result != nil {
			sse.Broadcast(SSEEvent{Type: "tasks:lifecycle-sweep", Data: map[string]any{"result": result, "error": errorString(err)}})
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				run()
			}
		}
	}()
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
