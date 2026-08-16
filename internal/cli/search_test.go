package cli

import (
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
)

func TestSearchCommandPublicCompatibilityFlags(t *testing.T) {
	if searchCmd.Flags().Lookup("keyword") == nil {
		t.Fatal("expected search --keyword compatibility flag")
	}
	if searchCmd.Flags().Lookup("mode") != nil {
		t.Fatal("search should not expose a public --mode flag")
	}
	if searchCmd.Flags().Lookup("bm25") != nil {
		t.Fatal("search should not expose BM25 as a public flag")
	}
}

func TestSearchIndexCommandExposesBlockingWait(t *testing.T) {
	cmd := newSearchIndexCmd()
	if cmd.Use != "index" || cmd.Flags().Lookup("wait") == nil {
		t.Fatalf("search index --wait command not wired: use=%q", cmd.Use)
	}
}

func TestSprintPlainRetrieval(t *testing.T) {
	resp := &models.RetrievalResponse{
		Query: "rag retrieval foundation",
		Mode:  "keyword",
		Candidates: []models.RetrievalCandidate{
			{
				Type:        "doc",
				ID:          "specs/rag-retrieval-foundation",
				Title:       "RAG Retrieval Foundation",
				Score:       1,
				DirectMatch: true,
				Citation: models.Citation{
					Type: "doc",
					Path: "specs/rag-retrieval-foundation",
				},
				Snippet: "Specification for retrieval foundation across docs, tasks, and memories",
			},
		},
		ContextPack: models.ContextPack{
			Items: []models.ContextItem{
				{
					Type:        "doc",
					ID:          "specs/rag-retrieval-foundation",
					Title:       "RAG Retrieval Foundation",
					DirectMatch: true,
					Citation: models.Citation{
						Type: "doc",
						Path: "specs/rag-retrieval-foundation",
					},
					Content: "Build a shared retrieval foundation for Knowns.",
				},
			},
		},
	}

	got := sprintPlainRetrieval(resp)
	for _, want := range []string{
		"Query: rag retrieval foundation",
		"Candidates: 1",
		"[DOC] RAG Retrieval Foundation (specs/rag-retrieval-foundation)",
		"Citation: doc:specs/rag-retrieval-foundation",
		"Context Pack:",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected output to contain %q, got:\n%s", want, got)
		}
	}
}

func TestFormatSearchSemanticIndexReadinessLinesShowsReindexGuidance(t *testing.T) {
	indexedAt := time.Date(2026, 8, 13, 7, 0, 0, 0, time.UTC)
	lines := formatSearchSemanticIndexReadinessLines(search.SemanticIndexReadiness{
		Enabled:      true,
		Backend:      "qdrant",
		Mode:         "managed",
		Ready:        false,
		Stale:        true,
		Model:        "old-model",
		Dimensions:   384,
		ChunkVersion: 2,
		ChunkCount:   12,
		IndexedAt:    &indexedAt,
		Reason:       "embedding identity mismatch",
	})
	got := strings.Join(lines, "\n")
	for _, want := range []string{
		"stale",
		"qdrant",
		"managed",
		"old-model",
		"384",
		"12 chunks",
		"embedding identity mismatch",
		"knowns search --reindex",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected %q in search readiness lines, got:\n%s", want, got)
		}
	}
}
