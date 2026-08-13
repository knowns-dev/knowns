package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/runtimequeue"
	"github.com/howznguyen/knowns/internal/services"
	"github.com/spf13/cobra"
)

func TestFormatServiceLinesIncludesSemanticRuntimeDetails(t *testing.T) {
	lines := formatServiceLines([]services.ServiceStatus{{
		Name:            "Embedding",
		Type:            "embedding",
		Status:          "running",
		EnabledInConfig: true,
		Details: map[string]string{
			"provider":        "api",
			"model":           "text-embedding-test",
			"dimensions":      "384",
			"runtime_loaded":  "true",
			"active_sessions": "1",
			"consumers":       "/repo/a,/repo/b",
			"queued_jobs":     "3",
			"degraded":        "true",
			"last_error":      "semantic provider unavailable",
			"runtime_log":     "/tmp/knowns-runtime.log",
		},
	}})
	got := strings.Join(lines, "\n")
	for _, want := range []string{
		"provider=api",
		"model=text-embedding-test",
		"dims=384",
		"loaded=true",
		"sessions=1",
		"consumers=2",
		"queued=3",
		"degraded",
		"semantic provider unavailable",
		"log=/tmp/knowns-runtime.log",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in service line, got: %s", want, got)
		}
	}
}

func TestFormatServiceSummaryLinesCompactsLSPInventory(t *testing.T) {
	lines := formatServiceSummaryLines([]services.ServiceStatus{
		{Name: "Embedding", Type: "embedding", Status: "running", Details: map[string]string{"provider": "api"}},
		{Name: "LSP (go)", Type: "lsp", Status: "running", Details: map[string]string{"install_state": "installed"}},
		{Name: "LSP (json)", Type: "lsp", Status: "stopped", Details: map[string]string{"install_state": "not_installed"}},
	})
	got := strings.Join(lines, "\n")
	if strings.Contains(got, "LSP (go)") || strings.Contains(got, "LSP (json)") {
		t.Fatalf("expected compact LSP summary, got: %s", got)
	}
	for _, want := range []string{"Embedding", "LSP", "2 languages", "1 running", "1 not installed", "knowns lsp list"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in service summary, got: %s", want, got)
		}
	}
}

func TestRuntimePsDefaultIsCompactAndGroupsFailures(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	snapshots := []projectSnapshot{{
		Root: "/repo/.knowns",
		Recent: []runtimequeue.JobResult{
			runtimePsResult("a", runtimequeue.JobIndexMemory, "3kno2x", false, "could not index-memory 3kno2x: init onnx runtime: ONNX Runtime is not installed; run `knowns runtime install onnx`", now),
			runtimePsResult("b", runtimequeue.JobIndexMemory, "3kno2x", false, "could not index-memory 3kno2x: init onnx runtime: ONNX Runtime is not installed; run `knowns runtime install onnx`", now.Add(time.Second)),
			runtimePsResult("c", runtimequeue.JobIndexTask, "ozbtct", true, "", now.Add(2*time.Second)),
		},
	}}
	status := &runtimequeue.Status{Running: true, PID: 42, Version: "test", Clients: []runtimequeue.Lease{{ClientKind: "mcp", ProjectRoot: "/repo/.knowns", PID: 99, UpdatedAt: now}}}
	summary := summarizeRuntimePs(status, snapshots, defaultRuntimePsFailureLimit)
	if summary.RecentJobs != 3 || summary.FailedJobs != 2 {
		t.Fatalf("summary = %+v, want 3 recent and 2 failed", summary)
	}
	if len(summary.Failures) != 1 || summary.Failures[0].Count != 2 {
		t.Fatalf("failures = %+v, want one repeated group", summary.Failures)
	}

	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePs(cmd, status, nil, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: defaultRuntimePsFailureLimit}, false)
	got := out.String()
	for _, want := range []string{"Activity", "Recent failures", "repeated 2x", "ONNX Runtime is not installed", "knowns runtime install onnx", "knowns runtime ps --jobs --tail 20"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in compact output, got:\n%s", want, got)
		}
	}
	if strings.Contains(got, "ozbtct") {
		t.Fatalf("default compact output should not dump successful recent jobs, got:\n%s", got)
	}
}

func TestRuntimePsDetailHonorsFailedAndTail(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	snapshots := []projectSnapshot{{
		Root: "/repo/.knowns",
		Recent: []runtimequeue.JobResult{
			runtimePsResult("old-fail", runtimequeue.JobIndexMemory, "old", false, "old failure", now),
			runtimePsResult("ok", runtimequeue.JobIndexTask, "ok-task", true, "", now.Add(time.Second)),
			runtimePsResult("new-fail", runtimequeue.JobIndexDoc, "new", false, "new failure", now.Add(2*time.Second)),
		},
	}}
	lines := formatRuntimeJobDetailLines(snapshots, runtimePsOptions{ShowJobs: true, FailedOnly: true, Tail: 1}, false)
	got := strings.Join(lines, "\n")
	if !strings.Contains(got, "index-doc") || !strings.Contains(got, "new failure") {
		t.Fatalf("expected newest failed detail, got:\n%s", got)
	}
	if strings.Contains(got, "ok-task") || strings.Contains(got, "old failure") {
		t.Fatalf("failed+tail detail included unexpected rows, got:\n%s", got)
	}
}

func TestRuntimePsPlainDefaultDoesNotDumpAllRecentJobs(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	snapshots := []projectSnapshot{{
		Root: "/repo/.knowns",
		Recent: []runtimequeue.JobResult{
			runtimePsResult("a", runtimequeue.JobIndexMemory, "mem", false, "ONNX Runtime is not installed", now),
			runtimePsResult("b", runtimequeue.JobIndexTask, "task", true, "", now.Add(time.Second)),
		},
	}}
	status := &runtimequeue.Status{Running: true, PID: 42, Version: "test"}
	summary := summarizeRuntimePs(status, snapshots, defaultRuntimePsFailureLimit)
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePsPlain(cmd, status, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: defaultRuntimePsFailureLimit})
	got := out.String()
	if !strings.Contains(got, "activity\t") || !strings.Contains(got, "failure\t") {
		t.Fatalf("plain compact summary missing activity/failure, got:\n%s", got)
	}
	if strings.Contains(got, "recent\t") || strings.Contains(got, "task") {
		t.Fatalf("plain compact output dumped recent jobs, got:\n%s", got)
	}
}

func TestRuntimePsCustomClientLimit(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	status := &runtimequeue.Status{
		Running: true,
		PID:     42,
		Version: "test",
		Clients: []runtimequeue.Lease{
			{ClientKind: "mcp", ProjectRoot: "/repo/one/.knowns", PID: 101, UpdatedAt: now},
			{ClientKind: "mcp", ProjectRoot: "/repo/two/.knowns", PID: 102, UpdatedAt: now},
			{ClientKind: "mcp", ProjectRoot: "/repo/three/.knowns", PID: 103, UpdatedAt: now},
		},
	}
	summary := summarizeRuntimePs(status, nil, defaultRuntimePsFailureLimit)
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePs(cmd, status, nil, nil, summary, runtimePsOptions{ClientLimit: 2, FailureLimit: defaultRuntimePsFailureLimit}, false)
	got := out.String()
	for _, want := range []string{"pid=101", "pid=102", "… 1 more clients"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q with client limit, got:\n%s", want, got)
		}
	}
	if strings.Contains(got, "pid=103") {
		t.Fatalf("custom client limit leaked third client, got:\n%s", got)
	}
}

func TestRuntimePsCustomFailureLimit(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	snapshots := []projectSnapshot{{
		Root: "/repo/.knowns",
		Recent: []runtimequeue.JobResult{
			runtimePsResult("a", runtimequeue.JobIndexMemory, "mem", false, "failure one", now),
			runtimePsResult("b", runtimequeue.JobIndexTask, "task", false, "failure two", now.Add(time.Second)),
			runtimePsResult("c", runtimequeue.JobIndexDoc, "doc", false, "failure three", now.Add(2*time.Second)),
		},
	}}
	status := &runtimequeue.Status{Running: true, PID: 42, Version: "test"}
	summary := summarizeRuntimePs(status, snapshots, 2)
	if len(summary.Failures) != 2 {
		t.Fatalf("failure limit produced %d summaries, want 2", len(summary.Failures))
	}
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePs(cmd, status, nil, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: 2}, false)
	got := out.String()
	if strings.Contains(got, "failure one") {
		t.Fatalf("custom failure limit leaked oldest failure, got:\n%s", got)
	}
	for _, want := range []string{"failure two", "failure three"} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q with failure limit, got:\n%s", want, got)
		}
	}
}

func TestRuntimePsPlainHonorsCustomCompactLimits(t *testing.T) {
	now := time.Date(2026, 8, 13, 6, 0, 0, 0, time.UTC)
	status := &runtimequeue.Status{
		Running: true,
		PID:     42,
		Version: "test",
		Clients: []runtimequeue.Lease{
			{ClientKind: "mcp", ProjectRoot: "/repo/one/.knowns", PID: 101, UpdatedAt: now},
			{ClientKind: "mcp", ProjectRoot: "/repo/two/.knowns", PID: 102, UpdatedAt: now},
		},
	}
	snapshots := []projectSnapshot{{
		Root: "/repo/.knowns",
		Recent: []runtimequeue.JobResult{
			runtimePsResult("a", runtimequeue.JobIndexMemory, "mem", false, "failure one", now),
			runtimePsResult("b", runtimequeue.JobIndexTask, "task", false, "failure two", now.Add(time.Second)),
		},
	}}
	summary := summarizeRuntimePs(status, snapshots, 1)
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePsPlain(cmd, status, snapshots, summary, runtimePsOptions{ClientLimit: 1, FailureLimit: 1})
	got := out.String()
	if strings.Count(got, "\nclient\t") != 1 || !strings.Contains(got, "clients-more\tcount=1") {
		t.Fatalf("plain client limit not honored, got:\n%s", got)
	}
	if strings.Count(got, "\nfailure\t") != 1 || strings.Contains(got, "failure one") {
		t.Fatalf("plain failure limit not honored, got:\n%s", got)
	}
}

func TestCLIRuntimeReadinessProbesRuntimeQueueStatus(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(filepath.Dir(runtimequeue.PIDFile()), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runtimequeue.PIDFile(), []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		t.Fatal(err)
	}

	got := cliRuntimeReadiness()
	if !got.Enabled || !got.Running || got.State != "healthy" {
		t.Fatalf("runtime readiness = %+v, want enabled healthy running", got)
	}
}

func runtimePsResult(id string, kind runtimequeue.JobKind, target string, success bool, errText string, completed time.Time) runtimequeue.JobResult {
	return runtimequeue.JobResult{
		JobID:       id,
		Kind:        kind,
		Target:      target,
		Success:     success,
		Error:       errText,
		StartedAt:   completed.Add(-50 * time.Millisecond),
		CompletedAt: completed,
	}
}

func runtimePsRenderTestCmd() (*cobra.Command, *bytes.Buffer) {
	var out bytes.Buffer
	cmd := &cobra.Command{Use: "ps"}
	cmd.SetOut(&out)
	return cmd, &out
}
