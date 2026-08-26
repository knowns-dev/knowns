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
	"github.com/howznguyen/knowns/internal/search"
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
			runtimePsResult("a", runtimequeue.JobIndexMemory, "3kno2x", false, "could not index-memory 3kno2x: semantic runtime unavailable: embedding provider could not be reached", now),
			runtimePsResult("b", runtimequeue.JobIndexMemory, "3kno2x", false, "could not index-memory 3kno2x: semantic runtime unavailable: embedding provider could not be reached", now.Add(time.Second)),
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
	renderRuntimePs(cmd, status, nil, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: defaultRuntimePsFailureLimit}, search.SemanticRuntimeStatus{}, runtimequeue.ReloadStatus{}, false)
	got := out.String()
	// The sample failure is a semantic runtime error rather than the ONNX one
	// this test used to carry: that runtime is gone, and so is its
	// `knowns runtime install onnx` remediation. What is under test here is
	// unchanged — repeated failures group, and a known failure renders its
	// remediation.
	for _, want := range []string{"Activity", "Recent failures", "repeated 2x", "semantic runtime unavailable", "knowns search --reindex", "knowns runtime ps --jobs --tail 20"} {
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
			runtimePsResult("a", runtimequeue.JobIndexMemory, "mem", false, "semantic runtime unavailable", now),
			runtimePsResult("b", runtimequeue.JobIndexTask, "task", true, "", now.Add(time.Second)),
		},
	}}
	status := &runtimequeue.Status{Running: true, PID: 42, Version: "test"}
	summary := summarizeRuntimePs(status, snapshots, defaultRuntimePsFailureLimit)
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePsPlain(cmd, status, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: defaultRuntimePsFailureLimit}, search.SemanticRuntimeStatus{}, runtimequeue.ReloadStatus{})
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
	renderRuntimePs(cmd, status, nil, nil, summary, runtimePsOptions{ClientLimit: 2, FailureLimit: defaultRuntimePsFailureLimit}, search.SemanticRuntimeStatus{}, runtimequeue.ReloadStatus{}, false)
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
	renderRuntimePs(cmd, status, nil, snapshots, summary, runtimePsOptions{ClientLimit: defaultRuntimePsClientLimit, FailureLimit: 2}, search.SemanticRuntimeStatus{}, runtimequeue.ReloadStatus{}, false)
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
	renderRuntimePsPlain(cmd, status, snapshots, summary, runtimePsOptions{ClientLimit: 1, FailureLimit: 1}, search.SemanticRuntimeStatus{}, runtimequeue.ReloadStatus{})
	got := out.String()
	if strings.Count(got, "\nclient\t") != 1 || !strings.Contains(got, "clients-more\tcount=1") {
		t.Fatalf("plain client limit not honored, got:\n%s", got)
	}
	if strings.Count(got, "\nfailure\t") != 1 || strings.Contains(got, "failure one") {
		t.Fatalf("plain failure limit not honored, got:\n%s", got)
	}
}

func TestFormatSemanticRuntimePlainLinesIncludesIdentityAndReload(t *testing.T) {
	processedAt := time.Date(2026, 8, 13, 6, 30, 0, 0, time.UTC)
	lines := formatSemanticRuntimePlainLines(search.SemanticRuntimeStatus{
		Enabled:          true,
		LastReloadAt:     processedAt,
		ReloadGeneration: 7,
		ReloadRequestID:  "reload-123",
		Entries: []search.SemanticRuntimeEntryInfo{{
			Provider:         "ollama",
			Model:            "qwen3-embedding:0.6b",
			Dimensions:       1024,
			Loaded:           true,
			ProviderIdentity: "ollama/qwen3-embedding:0.6b/1024",
		}},
	}, runtimequeue.ReloadStatus{})
	got := strings.Join(lines, "\n")
	for _, want := range []string{
		"semantic",
		"provider=ollama",
		"model=qwen3-embedding:0.6b",
		"dimensions=1024",
		"identity=ollama/qwen3-embedding:0.6b/1024",
		"reload",
		"generation=7",
		"requestId=reload-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in semantic runtime plain lines, got:\n%s", want, got)
		}
	}
}

func TestRenderRuntimePsPlainIncludesSemanticReloadIdentity(t *testing.T) {
	processedAt := time.Date(2026, 8, 13, 6, 30, 0, 0, time.UTC)
	status := &runtimequeue.Status{Running: true, PID: 42, Version: "test"}
	semantic := search.SemanticRuntimeStatus{
		Enabled: true,
		Entries: []search.SemanticRuntimeEntryInfo{{
			Provider:         "ollama",
			Model:            "qwen3-embedding:0.6b",
			Dimensions:       1024,
			Loaded:           true,
			ProviderIdentity: "ollama/qwen3-embedding:0.6b/1024",
		}},
	}
	reload := runtimequeue.ReloadStatus{RequestID: "reload-123", Generation: 7, ProcessedAt: processedAt}
	cmd, out := runtimePsRenderTestCmd()
	renderRuntimePsPlain(cmd, status, nil, summarizeRuntimePs(status, nil, defaultRuntimePsFailureLimit), runtimePsOptions{}, semantic, reload)
	got := out.String()
	for _, want := range []string{
		"semantic\t",
		"reload\t",
		"provider=ollama",
		"model=qwen3-embedding:0.6b",
		"dimensions=1024",
		"identity=ollama/qwen3-embedding:0.6b/1024",
		"generation=7",
		"requestId=reload-123",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in runtime ps plain output, got:\n%s", want, got)
		}
	}
}

func TestSemanticReindexRemediation(t *testing.T) {
	for name, readiness := range map[string]search.SemanticIndexReadiness{
		"not-ready": {Enabled: true, Ready: false},
		"stale":     {Enabled: true, Ready: true, Stale: true},
		"degraded":  {Enabled: true, Ready: true, Degraded: true},
	} {
		t.Run(name, func(t *testing.T) {
			if got := semanticReindexRemediation(readiness); got != "knowns search --reindex" {
				t.Fatalf("remediation = %q, want knowns search --reindex", got)
			}
		})
	}

	for name, readiness := range map[string]search.SemanticIndexReadiness{
		"disabled":  {Enabled: false},
		"opted-out": {Enabled: true, OptedOut: true},
		"ready":     {Enabled: true, Ready: true},
	} {
		t.Run(name, func(t *testing.T) {
			if got := semanticReindexRemediation(readiness); got != "" {
				t.Fatalf("remediation = %q, want empty", got)
			}
		})
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
