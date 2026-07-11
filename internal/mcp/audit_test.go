package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	gomcp "github.com/mark3labs/mcp-go/mcp"
)

type blockingAuditAppender struct {
	started chan *models.AuditEvent
	release chan struct{}
}

func (s *blockingAuditAppender) Append(event *models.AuditEvent) error {
	s.started <- event
	<-s.release
	return nil
}

func TestAuditRecorderWaitsForPersistence(t *testing.T) {
	store := &blockingAuditAppender{
		started: make(chan *models.AuditEvent, 1),
		release: make(chan struct{}),
	}
	root := t.TempDir()
	recorder := &auditRecorder{
		auditStore: store,
		getRoot:    func() string { return root },
		pending:    make(map[any]*pendingCall),
	}
	request := &gomcp.CallToolRequest{Params: gomcp.CallToolParams{
		Name: "tasks",
		Arguments: map[string]any{
			"action": "list",
		},
	}}

	recorder.beforeCallTool(context.Background(), 1, request)
	done := make(chan struct{})
	go func() {
		recorder.afterCallTool(context.Background(), 1, request, &gomcp.CallToolResult{})
		close(done)
	}()

	var event *models.AuditEvent
	select {
	case event = <-store.started:
	case <-time.After(time.Second):
		t.Fatal("audit append did not start")
	}
	select {
	case <-done:
		t.Fatal("audit hook returned before persistence completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(store.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("audit hook did not return after persistence completed")
	}

	if event.ToolName != "tasks" || event.Action != "list" {
		t.Fatalf("audit event = %s/%s, want tasks/list", event.ToolName, event.Action)
	}
}
