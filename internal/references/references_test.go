package references

import (
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestParse_TaskSemanticRef(t *testing.T) {
	ref, ok := Parse("@task-rag001{blocked-by}")
	if !ok {
		t.Fatal("expected parse success")
	}
	if ref.Type != "task" || ref.Target != "rag001" {
		t.Fatalf("unexpected task ref: %+v", ref)
	}
	if ref.Relation != "blocked-by" || !ref.ExplicitRelation || !ref.ValidRelation {
		t.Fatalf("unexpected task relation parsing: %+v", ref)
	}
	if !ref.Legacy || ref.Canonical != "@task/rag001{blocked-by}" {
		t.Fatalf("unexpected legacy canonical task ref: %+v", ref)
	}
}

func TestParse_CanonicalSlashRefs(t *testing.T) {
	tests := []struct {
		raw       string
		wantType  string
		wantID    string
		canonical string
	}{
		{"@task/rag001{blocked-by}", "task", "rag001", "@task/rag001{blocked-by}"},
		{"@memory/mem001{follows}", "memory", "mem001", "@memory/mem001{follows}"},
		{"@decision/20260618-1024-use-qdrant-as-default-vector-db", "decision", "20260618-1024-use-qdrant-as-default-vector-db", "@decision/20260618-1024-use-qdrant-as-default-vector-db"},
		{"@template/go-feature", "template", "go-feature", "@template/go-feature"},
	}

	for _, tt := range tests {
		ref, ok := Parse(tt.raw)
		if !ok {
			t.Fatalf("Parse(%q) failed", tt.raw)
		}
		if ref.Type != tt.wantType || ref.Target != tt.wantID {
			t.Fatalf("Parse(%q) = %+v", tt.raw, ref)
		}
		if ref.Legacy {
			t.Fatalf("Parse(%q) unexpectedly marked legacy: %+v", tt.raw, ref)
		}
		if ref.Canonical != tt.canonical {
			t.Fatalf("canonical = %q, want %q", ref.Canonical, tt.canonical)
		}
	}
}

func TestParse_DocRefDefaultsToReferences(t *testing.T) {
	ref, ok := Parse("@doc/guides/setup")
	if !ok {
		t.Fatal("expected parse success")
	}
	if ref.Type != "doc" || ref.Target != "guides/setup" {
		t.Fatalf("unexpected doc ref: %+v", ref)
	}
	if ref.Relation != models.SemanticReferenceRelationReferences || ref.ExplicitRelation {
		t.Fatalf("expected default references relation, got %+v", ref)
	}
}

func TestParse_DocRefWithHeadingAndRelation(t *testing.T) {
	ref, ok := Parse("@doc/guides/setup#overview{implements}")
	if !ok {
		t.Fatal("expected parse success")
	}
	if ref.Target != "guides/setup" {
		t.Fatalf("target = %q, want guides/setup", ref.Target)
	}
	if ref.Fragment == nil || ref.Fragment.Heading != "overview" {
		t.Fatalf("expected heading fragment, got %+v", ref.Fragment)
	}
	if ref.Relation != "implements" {
		t.Fatalf("relation = %q, want implements", ref.Relation)
	}
}

func TestParse_DocRefWithLineRange(t *testing.T) {
	ref, ok := Parse("@doc/guides/setup:10-25{related}")
	if !ok {
		t.Fatal("expected parse success")
	}
	if ref.Fragment == nil || ref.Fragment.RangeStart != 10 || ref.Fragment.RangeEnd != 25 {
		t.Fatalf("expected line range fragment, got %+v", ref.Fragment)
	}
}

func TestParse_InvalidRelation(t *testing.T) {
	ref, ok := Parse("@memory-mem001{owns}")
	if !ok {
		t.Fatal("expected parse success")
	}
	if ref.ValidRelation {
		t.Fatalf("expected invalid relation, got %+v", ref)
	}
}

func TestExtract_MixedSemanticRefs(t *testing.T) {
	refs := Extract("See @doc/guides/setup{implements}, @task/rag001, @task-legacy, @memory/mem001, @memory-old{follows}, and @decision/20260618-1024-use-qdrant-as-default-vector-db.")
	if len(refs) != 6 {
		t.Fatalf("ref count = %d, want 6: %+v", len(refs), refs)
	}
	if refs[1].Relation != models.SemanticReferenceRelationReferences {
		t.Fatalf("plain task ref should default to references, got %+v", refs[1])
	}
	if refs[2].Canonical != "@task/legacy" || !refs[2].Legacy {
		t.Fatalf("legacy task ref not normalized: %+v", refs[2])
	}
	if refs[4].Canonical != "@memory/old{follows}" || !refs[4].Legacy {
		t.Fatalf("legacy memory ref not normalized: %+v", refs[4])
	}
	if refs[5].Type != "decision" {
		t.Fatalf("decision ref not extracted: %+v", refs[5])
	}
}
