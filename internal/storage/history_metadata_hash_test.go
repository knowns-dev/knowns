package storage

import (
	"encoding/json"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

// TestMetadataHashMatchesWriterForNestedChangeValues pins the defect that made
// an intact history read as corrupt.
//
// `TaskChange.OldValue` and `NewValue` are `any`, so a nested object round-trips
// as `map[string]any`, whose keys Go marshals sorted. On disk the same value
// keeps the field order of the struct it was written from. Hashing the file's
// bytes verbatim therefore disagrees with the hash the writer computed, and
// only for records whose changes carry a nested object - which is why records
// holding nothing but scalar changes validated fine and hid this for weeks.
func TestMetadataHashMatchesWriterForNestedChangeValues(t *testing.T) {
	record := models.HistoryRecord{
		SchemaVersion: 1,
		EntityType:    "task",
		EntityID:      "abc123",
		Revision:      1,
		TaskChanges: []models.TaskChange{{
			Field:    "acceptanceCriteria",
			OldValue: nil,
			// Text is declared before Completed, so the on-disk bytes read
			// {"text":...,"completed":...} while a map re-marshal sorts them
			// the other way round.
			NewValue: []models.AcceptanceCriterion{{Text: "criterion", Completed: false}},
		}},
	}
	record.RecordHash = historyRecordHash(record)

	line, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}

	computed, err := metadataRecordHash(raw)
	if err != nil {
		t.Fatalf("metadataRecordHash: %v", err)
	}
	if computed != record.RecordHash {
		t.Fatalf("metadata hash = %s, writer hash = %s; the reader must use the writer's normalization", computed, record.RecordHash)
	}
}

// TestMetadataHashStillDetectsTampering makes sure the fix did not turn the
// integrity check into a formality that accepts anything.
func TestMetadataHashStillDetectsTampering(t *testing.T) {
	record := models.HistoryRecord{
		SchemaVersion: 1,
		EntityType:    "task",
		EntityID:      "abc123",
		Revision:      1,
		TaskChanges: []models.TaskChange{{
			Field:    "acceptanceCriteria",
			NewValue: []models.AcceptanceCriterion{{Text: "criterion"}},
		}},
	}
	record.RecordHash = historyRecordHash(record)

	record.TaskChanges[0].NewValue = []models.AcceptanceCriterion{{Text: "tampered"}}
	line, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(line, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	computed, err := metadataRecordHash(raw)
	if err != nil {
		t.Fatalf("metadataRecordHash: %v", err)
	}
	if computed == record.RecordHash {
		t.Fatal("a tampered payload produced the stored hash")
	}
}
