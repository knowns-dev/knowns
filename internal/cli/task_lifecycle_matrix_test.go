package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/mcp/handlers"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/permissions"
	"github.com/howznguyen/knowns/internal/server/routes"
	"github.com/howznguyen/knowns/internal/storage"
	"github.com/howznguyen/knowns/internal/tasklifecycle"
	mcpserver "github.com/mark3labs/mcp-go/server"
	"github.com/spf13/cobra"
)

func TestTaskLifecycleCrossSurfaceContractMatrix(t *testing.T) {
	const taskID = "matrix-life"
	fixedNow := time.Date(2026, 7, 22, 7, 0, 0, 0, time.UTC)
	root := t.TempDir()
	cliRoot := filepath.Join(root, "cli")
	cliStore := newMatrixLifecycleStore(t, cliRoot, taskID, fixedNow)
	t.Chdir(cliRoot)
	httpRoot := filepath.Join(root, "http")
	httpStore := newMatrixLifecycleStore(t, httpRoot, taskID, fixedNow)
	mcpRoot := filepath.Join(root, "mcp")
	mcpStore := newMatrixLifecycleStore(t, mcpRoot, taskID, fixedNow)

	runners := []matrixSurface{
		{name: "cli", invoke: matrixCLIRunner(t, cliStore)},
		{name: "http", invoke: matrixHTTPRunner(t, httpStore, httpRoot)},
		{name: "mcp_registered", invoke: matrixMCPRunner(t, mcpStore)},
	}
	scenarios := []struct {
		name        string
		request     tasklifecycle.Request
		trusted     bool
		wantFailure bool
		wantReason  tasklifecycle.ReasonCode
		wantHTTP    int
	}{
		{name: "preview_no_side_effect", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: []string{taskID}}},
		{name: "execute", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: []string{taskID}, Execute: true}},
		{name: "idempotent", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: []string{taskID}, Execute: true}, wantReason: tasklifecycle.ReasonAlreadyArchived},
		{name: "batch_unarchive", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchUnarchive, IDs: []string{taskID}, Execute: true}},
		{name: "active_unarchive_preview", request: tasklifecycle.Request{Operation: tasklifecycle.OperationReopen, TaskID: taskID}, wantReason: tasklifecycle.ReasonAlreadyActive},
		{name: "empty_ids", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchUnarchive}, wantFailure: true, wantReason: tasklifecycle.ReasonInvalidRequest, wantHTTP: http.StatusBadRequest},
		{name: "partial_progress", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: []string{"aaa-missing", "zzz-partial"}, Execute: true}, wantFailure: true, wantReason: tasklifecycle.ReasonNotFound, wantHTTP: http.StatusNotFound},
		{name: "partial_retry", request: tasklifecycle.Request{Operation: tasklifecycle.OperationBatchArchive, IDs: []string{"zzz-partial"}, Execute: true}, wantReason: tasklifecycle.ReasonAlreadyArchived},
		{name: "permission", request: tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: taskID, Execute: true, Confirmed: true, Reason: "cleanup"}, wantFailure: true, wantReason: tasklifecycle.ReasonPermissionRequired, wantHTTP: http.StatusForbidden},
		{name: "confirmation", request: tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: taskID, Reason: "cleanup"}, trusted: true, wantFailure: true, wantReason: tasklifecycle.ReasonConfirmationRequired, wantHTTP: http.StatusBadRequest},
		{name: "reason", request: tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: taskID, Execute: true, Confirmed: true}, trusted: true, wantFailure: true, wantReason: tasklifecycle.ReasonDeleteReasonRequired, wantHTTP: http.StatusBadRequest},
		{name: "hard_delete", request: tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: taskID, Execute: true, Confirmed: true, Reason: "cleanup"}, trusted: true},
		{name: "tombstone_conflict", request: tasklifecycle.Request{Operation: tasklifecycle.OperationHardDelete, TaskID: taskID, Execute: true, Confirmed: true, Reason: "different"}, trusted: true, wantFailure: true, wantReason: tasklifecycle.ReasonTombstoneConflict, wantHTTP: http.StatusConflict},
	}

	for _, scenario := range scenarios {
		t.Run(scenario.name, func(t *testing.T) {
			var baseline matrixNormalized
			for index, surface := range runners {
				response, failed, status := surface.invoke(scenario.request, scenario.trusted)
				if failed != scenario.wantFailure {
					t.Fatalf("%s failure=%t response=%+v", surface.name, failed, response)
				}
				if surface.name == "http" {
					wantCode := scenario.wantHTTP
					if wantCode == 0 {
						wantCode = http.StatusOK
					}
					if status != wantCode {
						t.Fatalf("HTTP status=%d want %d", status, wantCode)
					}
				}
				assertMatrixResponseShape(t, surface.name, response)
				normalized := normalizeMatrixResponse(response)
				if scenario.wantReason != "" && !matrixContainsReason(normalized, scenario.wantReason) {
					t.Fatalf("%s response lacks reason %s: %+v", surface.name, scenario.wantReason, normalized)
				}
				if index == 0 {
					baseline = normalized
					continue
				}
				if !reflect.DeepEqual(normalized, baseline) {
					t.Fatalf("contract drift %s=%+v cli=%+v", surface.name, normalized, baseline)
				}
			}
			switch scenario.name {
			case "preview_no_side_effect":
				assertMatrixArchived(t, false, taskID, cliStore, httpStore, mcpStore)
			case "partial_progress":
				assertMatrixArchived(t, true, "zzz-partial", cliStore, httpStore, mcpStore)
			case "hard_delete", "tombstone_conflict":
				assertMatrixTombstones(t, taskID, "cleanup", cliStore, httpStore, mcpStore)
			}
		})
	}
}

type matrixSurface struct {
	name   string
	invoke func(tasklifecycle.Request, bool) (*tasklifecycle.Response, bool, int)
}

type matrixNormalized struct {
	Operation tasklifecycle.Operation
	Execute   bool
	Completed bool
	Processed int
	Changed   int
	FailedID  string
	Items     []matrixItemNormalized
}

type matrixItemNormalized struct {
	TaskID      string
	Operation   tasklifecycle.Operation
	Changed     bool
	Eligible    bool
	Skipped     bool
	Before      models.TaskLifecycleState
	After       models.TaskLifecycleState
	CompletedAt matrixTimeNormalized
	ArchivedAt  matrixTimeNormalized
	Deadline    matrixTimeNormalized
	Reasons     []matrixReasonNormalized
	Warnings    []matrixWarningNormalized
	Event       matrixEventNormalized
}

type matrixTimeNormalized struct {
	Present bool
	UTC     bool
}

type matrixReasonNormalized struct {
	Code          tasklifecycle.ReasonCode
	Message       string
	RelatedTaskID string
	Deadline      matrixTimeNormalized
}

type matrixWarningNormalized struct {
	Code       tasklifecycle.WarningCode
	Message    string
	References []string
}

type matrixEventNormalized struct {
	Present      bool
	IDValid      bool
	At           matrixTimeNormalized
	Type         tasklifecycle.Operation
	TaskID       string
	ActorPresent bool
	Reason       string
	From         models.TaskLifecycleState
	To           models.TaskLifecycleState
	Automatic    bool
}

func normalizeMatrixResponse(response *tasklifecycle.Response) matrixNormalized {
	result := matrixNormalized{Operation: response.Operation, Execute: response.Execute, Completed: response.Completed, Processed: response.Processed, Changed: response.Changed, FailedID: response.FailedTaskID}
	for _, item := range response.Items {
		normalized := matrixItemNormalized{
			TaskID: item.TaskID, Operation: item.Operation, Changed: item.Changed, Eligible: item.Eligible,
			Skipped: !item.Changed && len(item.Reasons) > 0, Before: item.Before, After: item.After,
			CompletedAt: normalizeMatrixTime(item.CompletedAt), ArchivedAt: normalizeMatrixTime(item.ArchivedAt), Deadline: normalizeMatrixTime(item.Deadline),
		}
		for _, reason := range item.Reasons {
			normalized.Reasons = append(normalized.Reasons, matrixReasonNormalized{Code: reason.Code, Message: reason.Message, RelatedTaskID: reason.RelatedTaskID, Deadline: normalizeMatrixTime(reason.Deadline)})
		}
		for _, warning := range item.Warnings {
			normalized.Warnings = append(normalized.Warnings, matrixWarningNormalized{Code: warning.Code, Message: warning.Message, References: append([]string(nil), warning.References...)})
		}
		if item.Event != nil {
			normalized.Event = matrixEventNormalized{
				Present: true, IDValid: strings.HasPrefix(item.Event.ID, "task:"+item.Event.TaskID+":"+string(item.Event.Type)+":"),
				At: normalizeMatrixTime(&item.Event.At), Type: item.Event.Type, TaskID: item.Event.TaskID,
				ActorPresent: item.Event.Actor != "", Reason: item.Event.Reason, From: item.Event.From, To: item.Event.To, Automatic: item.Event.Automatic,
			}
		}
		result.Items = append(result.Items, normalized)
	}
	return result
}

func normalizeMatrixTime(value *time.Time) matrixTimeNormalized {
	return matrixTimeNormalized{Present: value != nil && !value.IsZero(), UTC: value != nil && value.Location() == time.UTC}
}

func matrixContainsReason(response matrixNormalized, code tasklifecycle.ReasonCode) bool {
	for _, item := range response.Items {
		for _, reason := range item.Reasons {
			if reason.Code == code {
				return true
			}
		}
	}
	return false
}

func assertMatrixResponseShape(t *testing.T, surface string, response *tasklifecycle.Response) {
	t.Helper()
	if response == nil {
		t.Fatalf("%s returned nil response", surface)
	}
	for index, item := range response.Items {
		for _, timestamp := range []struct {
			name  string
			value *time.Time
		}{{"completedAt", item.CompletedAt}, {"archivedAt", item.ArchivedAt}, {"deadline", item.Deadline}} {
			if timestamp.value != nil && (timestamp.value.IsZero() || timestamp.value.Location() != time.UTC) {
				t.Fatalf("%s item[%d] invalid %s=%v", surface, index, timestamp.name, timestamp.value)
			}
		}
		for reasonIndex, reason := range item.Reasons {
			if reason.Code == "" || reason.Message == "" {
				t.Fatalf("%s item[%d] reason[%d] missing code/message: %+v", surface, index, reasonIndex, reason)
			}
			if reason.Deadline != nil && (reason.Deadline.IsZero() || reason.Deadline.Location() != time.UTC) {
				t.Fatalf("%s item[%d] reason[%d] invalid deadline=%v", surface, index, reasonIndex, reason.Deadline)
			}
		}
		for warningIndex, warning := range item.Warnings {
			if warning.Code == "" || warning.Message == "" {
				t.Fatalf("%s item[%d] warning[%d] missing code/message: %+v", surface, index, warningIndex, warning)
			}
		}
		if item.Event == nil {
			if item.Changed {
				t.Fatalf("%s item[%d] changed without event: %+v", surface, index, item)
			}
			continue
		}
		event := item.Event
		if event.ID == "" || !strings.HasPrefix(event.ID, "task:"+event.TaskID+":"+string(event.Type)+":") || event.At.IsZero() || event.At.Location() != time.UTC {
			t.Fatalf("%s item[%d] malformed event: %+v", surface, index, event)
		}
		if event.TaskID != item.TaskID || event.Type != item.Operation || event.From != item.Before || event.To != item.After {
			t.Fatalf("%s item[%d] event/result mismatch: event=%+v item=%+v", surface, index, event, item)
		}
	}
}

func assertMatrixArchived(t *testing.T, want bool, taskID string, stores ...*storage.Store) {
	t.Helper()
	for index, store := range stores {
		task, err := store.Tasks.Get(taskID)
		if err != nil || task.Archived != want {
			t.Fatalf("store[%d] Task %s archived=%v, err=%v, want %v", index, taskID, task != nil && task.Archived, err, want)
		}
	}
}

func assertMatrixTombstones(t *testing.T, taskID, reason string, stores ...*storage.Store) {
	t.Helper()
	for index, store := range stores {
		if _, err := store.Tasks.Get(taskID); err == nil {
			t.Fatalf("store[%d] hard-delete left Task %s", index, taskID)
		}
		tombstone, err := store.Tasks.GetTombstone(taskID)
		if err != nil || tombstone.Reason != reason || tombstone.ID != taskID || tombstone.DeletedAt.IsZero() {
			t.Fatalf("store[%d] tombstone=%+v err=%v", index, tombstone, err)
		}
	}
}

func matrixCLIRunner(t *testing.T, _ *storage.Store) func(tasklifecycle.Request, bool) (*tasklifecycle.Response, bool, int) {
	t.Helper()
	return func(request tasklifecycle.Request, trusted bool) (*tasklifecycle.Response, bool, int) {
		resetMatrixCLIFlags(t)
		rootCmd.SetArgs(matrixCLIArgs(request, trusted))
		var callErr error
		var stderr bytes.Buffer
		rootCmd.SetErr(&stderr)
		rootCmd.SetOut(&stderr)
		output := captureStdout(t, func() { callErr = rootCmd.ExecuteContext(context.Background()) })
		rootCmd.SetErr(os.Stderr)
		rootCmd.SetOut(os.Stdout)
		rootCmd.SetArgs(nil)
		var response tasklifecycle.Response
		if err := json.Unmarshal([]byte(output), &response); err != nil {
			t.Fatalf("decode CLI %q: %v", output, err)
		}
		if callErr != nil {
			if !strings.Contains(stderr.String(), callErr.Error()) {
				t.Fatalf("Cobra stderr %q does not contain returned error %q", stderr.String(), callErr.Error())
			}
			return &response, true, 0
		}
		if stderr.Len() != 0 {
			t.Fatalf("successful Cobra command wrote stderr: %q", stderr.String())
		}
		return &response, false, 0
	}
}

func matrixCLIArgs(request tasklifecycle.Request, trusted bool) []string {
	args := []string{"--json", "task"}
	switch request.Operation {
	case tasklifecycle.OperationArchive:
		args = append(args, "archive", request.TaskID)
	case tasklifecycle.OperationReopen:
		args = append(args, "unarchive", request.TaskID)
	case tasklifecycle.OperationBatchArchive:
		args = append(args, "batch-archive")
		if request.Execute {
			args = append(args, "--yes")
		}
		args = append(args, request.IDs...)
		return args
	case tasklifecycle.OperationBatchUnarchive:
		args = append(args, "batch-unarchive")
		if request.Execute {
			args = append(args, "--yes")
		}
		args = append(args, request.IDs...)
		return args
	case tasklifecycle.OperationHardDelete:
		args = append(args, "hard-delete", request.TaskID)
		if request.Confirmed {
			args = append(args, "--yes")
		}
		if request.Reason != "" {
			args = append(args, "--reason", request.Reason)
		}
		if trusted {
			args = append(args, "--allow-hard-delete")
		}
		return args
	}
	if request.Execute {
		args = append(args, "--yes")
	}
	return args
}

func resetMatrixCLIFlags(t *testing.T) {
	t.Helper()
	if err := rootCmd.PersistentFlags().Set("json", "false"); err != nil {
		t.Fatalf("reset root json: %v", err)
	}
	for _, item := range []struct {
		command *cobra.Command
		name    string
		value   string
	}{
		{taskArchiveCmd, "yes", "false"},
		{taskUnarchiveCmd, "yes", "false"},
		{taskBatchArchiveCmd, "yes", "false"},
		{taskBatchUnarchiveCmd, "yes", "false"},
		{taskDeleteCmd, "yes", "false"},
		{taskDeleteCmd, "reason", ""},
		{taskDeleteCmd, "allow-hard-delete", "false"},
	} {
		if err := item.command.Flags().Set(item.name, item.value); err != nil {
			t.Fatalf("reset %s.%s: %v", item.command.Name(), item.name, err)
		}
	}
}

type matrixBroadcaster struct{}

func (matrixBroadcaster) Broadcast(routes.SSEEvent) {}

func matrixHTTPRunner(t *testing.T, store *storage.Store, root string) func(tasklifecycle.Request, bool) (*tasklifecycle.Response, bool, int) {
	t.Helper()
	return func(request tasklifecycle.Request, trusted bool) (*tasklifecycle.Response, bool, int) {
		router := chi.NewRouter()
		routes.SetupRoutesWithCapabilities(router, store, matrixBroadcaster{}, root, nil, routes.TaskRouteCapabilities{HardDelete: trusted})
		path := "/tasks/batch-archive"
		switch request.Operation {
		case tasklifecycle.OperationReopen:
			path = "/tasks/" + request.TaskID + "/unarchive"
		case tasklifecycle.OperationBatchUnarchive:
			path = "/tasks/batch-unarchive"
		case tasklifecycle.OperationHardDelete:
			path = "/tasks/" + request.TaskID + "/hard-delete"
		}
		body, _ := json.Marshal(request)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		var response tasklifecycle.Response
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatalf("decode HTTP status=%d body=%s: %v", w.Code, w.Body.String(), err)
		}
		return &response, w.Code >= 400, w.Code
	}
}

type matrixMCPRegistrar struct{ *mcpserver.MCPServer }

func (*matrixMCPRegistrar) RegisterHelp(string, handlers.HelpEntry) {}

func matrixMCPRunner(t *testing.T, store *storage.Store) func(tasklifecycle.Request, bool) (*tasklifecycle.Response, bool, int) {
	t.Helper()
	server := mcpserver.NewMCPServer("matrix", "test", mcpserver.WithToolHandlerMiddleware(permissions.NewGuardMiddleware(func() *permissions.PermissionConfig {
		config, err := store.Config.Load()
		if err != nil {
			return nil
		}
		return config.Settings.Permissions
	})))
	registrar := &matrixMCPRegistrar{MCPServer: server}
	handlers.RegisterTaskTool(registrar, func() *storage.Store { return store })
	return func(request tasklifecycle.Request, trusted bool) (*tasklifecycle.Response, bool, int) {
		config, err := store.Config.Load()
		if err != nil {
			t.Fatal(err)
		}
		preset := permissions.PresetReadWriteNoDelete
		if trusted {
			preset = permissions.PresetReadWrite
		}
		config.Settings.Permissions = &permissions.PermissionConfig{Preset: preset}
		if err := store.Config.Save(config); err != nil {
			t.Fatal(err)
		}
		action := string(request.Operation)
		if request.Operation == tasklifecycle.OperationReopen {
			action = "unarchive"
		}
		args := map[string]any{"action": action, "taskId": request.TaskID, "ids": request.IDs, "execute": request.Execute, "confirmed": request.Confirmed, "reason": request.Reason}
		message, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "tasks", "arguments": args}})
		result := server.HandleMessage(t.Context(), message)
		data, _ := json.Marshal(result)
		var envelope struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
				IsError bool `json:"isError"`
			} `json:"result"`
		}
		if err := json.Unmarshal(data, &envelope); err != nil || len(envelope.Result.Content) == 0 {
			t.Fatalf("decode MCP %s: %v", data, err)
		}
		var response tasklifecycle.Response
		if err := json.Unmarshal([]byte(envelope.Result.Content[0].Text), &response); err != nil {
			t.Fatalf("decode MCP response: %v", err)
		}
		if envelope.Result.IsError {
			return &response, true, 1
		}
		return &response, false, 0
	}
}

func newMatrixLifecycleStore(t *testing.T, root, taskID string, now time.Time) *storage.Store {
	t.Helper()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	if err := store.Init("matrix"); err != nil {
		t.Fatal(err)
	}
	completed := now.Add(-time.Hour)
	if err := store.Tasks.Create(&models.Task{ID: taskID, Title: taskID, Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: completed, CompletedAt: &completed, ImplementationPlan: "Review durable context in @doc/guide"}); err != nil {
		t.Fatal(err)
	}
	partialCompleted := completed
	if err := store.Tasks.Create(&models.Task{ID: "zzz-partial", Title: "partial", Status: "done", Priority: "medium", CreatedAt: now.Add(-2 * time.Hour), UpdatedAt: partialCompleted, CompletedAt: &partialCompleted, ImplementationNotes: "Preserve @memory/retry-pattern"}); err != nil {
		t.Fatal(err)
	}
	return store
}
