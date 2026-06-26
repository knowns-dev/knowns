package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestRenderPlainDocHistoryIncludesRevisionMetadata(t *testing.T) {
	history := &models.DocVersionHistory{
		DocID:          "doc-123",
		DocPath:        "guides/history",
		CurrentVersion: 2,
		RetentionGaps: []models.DocHistoryGap{{
			Type:          "purged",
			Reason:        "max_versions",
			Count:         1,
			BeforeVersion: "v1",
			AfterVersion:  "v2",
			AppliedAt:     time.Date(2026, 6, 26, 1, 2, 3, 0, time.UTC),
		}},
		Versions: []models.DocVersion{{
			ID:           "v2",
			Version:      2,
			Timestamp:    time.Date(2026, 6, 26, 4, 5, 6, 0, time.UTC),
			Actor:        "cli",
			Source:       "cli",
			AuditEventID: "audit-1",
			SessionID:    "session-1",
			BaseHash:     "basehash",
			NewHash:      "newhash",
			Checkpoint:   true,
			ChangedScopes: []models.DocChangeScope{{
				Type:       "section",
				Field:      "content",
				Section:    "Scope",
				Summary:    "Section: Scope",
				OldBytes:   5,
				NewBytes:   7,
				DeltaBytes: 2,
			}},
			Changes: []models.DocChange{{
				Field:    "content",
				OldValue: "old",
				NewValue: "new",
			}},
		}},
	}

	output := renderPlainDocHistory("guides/history", history)
	for _, want := range []string{
		"DOC_ID: doc-123",
		"RETENTION_GAP: type=purged reason=max_versions count=1 before=v1 after=v2",
		"CHECKPOINT: true",
		"ACTOR: cli",
		"SOURCE: cli",
		"AUDIT_EVENT_ID: audit-1",
		"SESSION_ID: session-1",
		"SCOPE: section:content:\"Scope\" summary=\"Section: Scope\" bytes=5->7 (+2)",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("plain history output missing %q:\n%s", want, output)
		}
	}
}
