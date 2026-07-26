package search

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
)

func TestEvaluationDoesNotChangeProductionRetrievalOrProjectState(t *testing.T) {
	store := newSearchTestStore(t)
	now := time.Now().UTC()
	for _, doc := range []*models.Doc{
		{
			Path:      "specs/retrieval-alpha",
			Title:     "Retrieval Alpha",
			Content:   "alpha retrieval contract references @doc/specs/retrieval-beta{references}",
			CreatedAt: now,
			UpdatedAt: now,
		},
		{
			Path:      "specs/retrieval-beta",
			Title:     "Retrieval Beta",
			Content:   "beta reference expansion context",
			CreatedAt: now,
			UpdatedAt: now,
		},
	} {
		if err := store.Docs.Create(doc); err != nil {
			t.Fatalf("create doc %s: %v", doc.Path, err)
		}
	}
	opts := models.RetrievalOptions{
		Query:            "retrieval alpha",
		Mode:             string(ModeKeyword),
		Limit:            10,
		SourceTypes:      []string{"doc"},
		ExpandReferences: true,
	}
	before, err := NewEngine(store, nil, nil).Retrieve(opts)
	if err != nil {
		t.Fatalf("production retrieval before evaluation: %v", err)
	}
	if len(before.Candidates) == 0 || before.Mode != string(ModeKeyword) {
		t.Fatalf("unexpected production response: %+v", before)
	}
	stateBefore := evaluationTestTreeFingerprint(t, store.Root)

	fixture := &RetrievalEvaluationFixture{
		SchemaVersion: EvaluationFixtureSchemaVersion,
		Cases: []RetrievalEvaluationCase{{
			ID:                "production-parity",
			Category:          "integration",
			Query:             opts.Query,
			Qrels:             []EvaluationQrel{{Source: before.Candidates[0].ID, Relevance: 3}},
			ExpectedCitations: []string{evaluationCitationKey(before.ContextPack.Items[0].Citation)},
			Modes:             []string{string(ModeKeyword)},
			Limit:             opts.Limit,
			SourceTypes:       append([]string{}, opts.SourceTypes...),
			ExpandReferences:  opts.ExpandReferences,
		}},
	}
	report, err := EvaluateRetrievalFixture(
		fixture,
		func(tc RetrievalEvaluationCase, mode string) (*models.RetrievalResponse, error) {
			return NewEngine(store, nil, nil).Retrieve(models.RetrievalOptions{
				Query:            tc.Query,
				Mode:             mode,
				Limit:            tc.Limit,
				SourceTypes:      append([]string{}, tc.SourceTypes...),
				ExpandReferences: tc.ExpandReferences,
			})
		},
		RetrievalEvaluationOptions{Mode: string(ModeKeyword)},
	)
	if err != nil {
		t.Fatalf("evaluation: %v", err)
	}
	if report.Outcome != EvaluationOutcomePass {
		t.Fatalf("evaluation outcome = %q, failures=%+v", report.Outcome, report.Failures)
	}

	after, err := NewEngine(store, nil, nil).Retrieve(opts)
	if err != nil {
		t.Fatalf("production retrieval after evaluation: %v", err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("production retrieval changed after evaluation\nbefore=%+v\nafter=%+v", before, after)
	}
	stateAfter := evaluationTestTreeFingerprint(t, store.Root)
	if stateBefore != stateAfter {
		t.Fatalf("project/index state changed during read-only evaluation\nbefore=%s\nafter=%s", stateBefore, stateAfter)
	}
}

func evaluationTestTreeFingerprint(t *testing.T, root string) string {
	t.Helper()
	entries := make([]string, 0)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		data, err := fs.ReadFile(osDirFS(root), filepath.ToSlash(rel))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		entries = append(entries, filepath.ToSlash(rel)+":"+hex.EncodeToString(sum[:]))
		return nil
	})
	if err != nil {
		t.Fatalf("fingerprint project state: %v", err)
	}
	sort.Strings(entries)
	sum := sha256.Sum256([]byte(strings.Join(entries, "\n")))
	return hex.EncodeToString(sum[:])
}

func osDirFS(root string) fs.FS {
	return os.DirFS(root)
}
