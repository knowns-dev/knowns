package cli

import (
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/services"
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
