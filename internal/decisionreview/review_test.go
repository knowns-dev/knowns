package decisionreview

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestAddNoMatchCreatesDraftDecision(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	svc := New(store)
	svc.Now = func() time.Time { return fixedDecisionReviewTime() }

	result, err := svc.Add(&models.DecisionEntry{
		Title:    "Use review gates for new decisions",
		Decision: "Decision writes should go through a review gate.",
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultCreated || result.Decision == nil {
		t.Fatalf("result = %+v, want created decision", result)
	}
	if result.Decision.Status != models.DecisionStatusDraft {
		t.Fatalf("decision status = %q, want draft", result.Decision.Status)
	}
}

func TestAddDuplicateReturnsReviewRequiredAndDoesNotWrite(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	existing := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	})

	before := countReviewDecisions(t, store)
	result, err := New(store).Add(&models.DecisionEntry{
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultReviewRequired {
		t.Fatalf("status = %q, want %q", result.Status, ResultReviewRequired)
	}
	if !reflect.DeepEqual(result.AllowedResolutions, AllowedResolutions) {
		t.Fatalf("AllowedResolutions = %#v, want %#v", result.AllowedResolutions, AllowedResolutions)
	}
	if len(result.Matches) != 1 || result.Matches[0].ID != existing.ID || result.Matches[0].Kind != MatchDuplicate {
		t.Fatalf("matches = %+v, want duplicate %s", result.Matches, existing.ID)
	}
	if after := countReviewDecisions(t, store); after != before {
		t.Fatalf("decision count changed on review: before=%d after=%d", before, after)
	}
}

func TestAddConflictReturnsReviewRequired(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	existing := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Chroma as default vector DB",
		Decision: "Use Chroma as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	})

	result, err := New(store).Add(&models.DecisionEntry{
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultReviewRequired {
		t.Fatalf("status = %q, want %q", result.Status, ResultReviewRequired)
	}
	if len(result.Matches) != 1 || result.Matches[0].ID != existing.ID || result.Matches[0].Kind != MatchConflict {
		t.Fatalf("matches = %+v, want conflict %s", result.Matches, existing.ID)
	}
}

func TestResolveSupersedeExistingCreatesCurrentDecision(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	oldDecision := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Chroma as default vector DB",
		Decision: "Use Chroma as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	})
	svc := New(store)
	svc.Now = func() time.Time { return fixedDecisionReviewTime().Add(time.Hour) }

	result, err := svc.Resolve(&models.DecisionEntry{
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
	}, ResolveOptions{Resolution: ResolutionSupersedeExisting, TargetID: oldDecision.ID})
	if err != nil {
		t.Fatalf("Resolve supersede: %v", err)
	}
	if result.Status != ResultResolved || result.Current == nil || result.Superseded == nil {
		t.Fatalf("result = %+v, want resolved supersession", result)
	}
	if result.Superseded.Status != models.DecisionStatusSuperseded {
		t.Fatalf("old status = %q, want superseded", result.Superseded.Status)
	}
	if result.Current.Status != models.DecisionStatusAccepted {
		t.Fatalf("new status = %q, want accepted", result.Current.Status)
	}
	if result.Current.Supersedes[0] != oldDecision.ID || result.Superseded.SupersededBy[0] != result.Current.ID {
		t.Fatalf("supersession result = %+v", result)
	}
	loadedOld, err := store.Decisions.Get(oldDecision.ID)
	if err != nil {
		t.Fatalf("get old: %v", err)
	}
	if loadedOld.Title != oldDecision.Title || loadedOld.Decision != oldDecision.Decision {
		t.Fatalf("old decision content was overwritten: %+v", loadedOld)
	}
}

func TestResolveCreateDraftAndLinkAsRelatedAreNonDestructive(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	existing := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Chroma as default vector DB",
		Decision: "Use Chroma as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	})

	draftResult, err := New(store).Resolve(&models.DecisionEntry{
		Title:    "Alternative vector DB",
		Decision: "Keep evaluating vector database options.",
		Sources:  []string{"@doc/specs/vector"},
	}, ResolveOptions{Resolution: ResolutionCreateDraft})
	if err != nil {
		t.Fatalf("Resolve create draft: %v", err)
	}
	if draftResult.Decision.Status != models.DecisionStatusDraft {
		t.Fatalf("draft status = %q, want draft", draftResult.Decision.Status)
	}

	relatedResult, err := New(store).Resolve(&models.DecisionEntry{
		ID:       existing.ID,
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
	}, ResolveOptions{Resolution: ResolutionLinkAsRelated, TargetID: existing.ID})
	if err != nil {
		t.Fatalf("Resolve link related: %v", err)
	}
	if relatedResult.Decision.Status != models.DecisionStatusDraft {
		t.Fatalf("related status = %q, want draft", relatedResult.Decision.Status)
	}
	if !reflect.DeepEqual(relatedResult.Decision.Sources, []string{models.DecisionRef(existing.ID)}) {
		t.Fatalf("related sources = %#v", relatedResult.Decision.Sources)
	}
	loadedExisting, err := store.Decisions.Get(existing.ID)
	if err != nil {
		t.Fatalf("get existing: %v", err)
	}
	if loadedExisting.Status != models.DecisionStatusAccepted || len(loadedExisting.SupersededBy) != 0 {
		t.Fatalf("existing decision was changed: %+v", loadedExisting)
	}
}

func TestSemanticReviewUsesRuntimeSearchPath(t *testing.T) {
	calls := reviewSelectorCalls(t)
	if calls["search.InitSemantic"] {
		t.Fatal("decision review must not initialize semantic providers inline")
	}
	if !calls["search.SearchWithRuntime"] {
		t.Fatal("decision review should route semantic matching through search.SearchWithRuntime")
	}
}

func newDecisionReviewTestStore(t *testing.T) *storage.Store {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	store := storage.NewStore(filepath.Join(t.TempDir(), ".knowns"))
	if err := store.Init("decision-review-test"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	return store
}

func createReviewDecision(t *testing.T, store *storage.Store, entry *models.DecisionEntry) *models.DecisionEntry {
	t.Helper()
	if len(entry.Sources) == 0 && len(entry.RelatedDocs) == 0 && len(entry.RelatedTasks) == 0 {
		entry.Sources = []string{"@doc/specs/decision-review"}
	}
	if err := store.Decisions.Create(entry, storage.DecisionCreateOptions{Now: fixedDecisionReviewTime()}); err != nil {
		t.Fatalf("create decision %q: %v", entry.Title, err)
	}
	return entry
}

func countReviewDecisions(t *testing.T, store *storage.Store) int {
	t.Helper()
	entries, err := store.Decisions.List()
	if err != nil {
		t.Fatalf("list decisions: %v", err)
	}
	return len(entries)
}

func fixedDecisionReviewTime() time.Time {
	return time.Date(2026, 6, 18, 10, 24, 0, 0, time.FixedZone("ICT", 7*60*60))
}

func reviewSelectorCalls(t *testing.T) map[string]bool {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "review.go", nil, 0)
	if err != nil {
		t.Fatalf("parse review.go: %v", err)
	}
	calls := make(map[string]bool)
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		ident, ok := selector.X.(*ast.Ident)
		if !ok {
			return true
		}
		calls[ident.Name+"."+selector.Sel.Name] = true
		return true
	})
	return calls
}
