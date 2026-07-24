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
	if result.Decision.ReviewState != models.DecisionReviewStateNeedsEvidence || len(result.Decision.ReviewBlockers) == 0 {
		t.Fatalf("review metadata = %+v, want needs_evidence with repair guidance", result.Decision)
	}
}

func TestAddRejectsDirectAcceptedCreation(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	_, err := New(store).Add(&models.DecisionEntry{
		Title:   "Bypass verification",
		Status:  models.DecisionStatusAccepted,
		Sources: []string{"https://example.com/source"},
	}, AddOptions{})
	if err == nil {
		t.Fatal("Add accepted decision succeeded, want draft-first error")
	}
	if entries := countReviewDecisions(t, store); entries != 0 {
		t.Fatalf("accepted bypass wrote %d decisions, want 0", entries)
	}
}

func TestAddDuplicateWithoutEvidencePersistsNeedsEvidenceCandidate(t *testing.T) {
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
	if result.Status != ResultCreated || result.Decision == nil {
		t.Fatalf("status = %q, want persisted created candidate", result.Status)
	}
	if result.Decision.ReviewState != models.DecisionReviewStateNeedsEvidence || len(result.Decision.ReviewBlockers) == 0 {
		t.Fatalf("candidate = %+v, want needs_evidence", result.Decision)
	}
	if len(result.Decision.ReviewMatches) != 1 || result.Decision.ReviewMatches[0].ID != existing.ID || result.Decision.ReviewMatches[0].Kind != MatchDuplicate {
		t.Fatalf("persisted matches = %+v, want duplicate %s", result.Decision.ReviewMatches, existing.ID)
	}
	if after := countReviewDecisions(t, store); after != before+1 {
		t.Fatalf("decision count after persisted review: before=%d after=%d", before, after)
	}
	reloaded, err := store.Decisions.Get(result.Decision.ID)
	if err != nil {
		t.Fatalf("reload persisted candidate: %v", err)
	}
	if !reflect.DeepEqual(reloaded.ReviewMatches, result.Decision.ReviewMatches) || !reflect.DeepEqual(reloaded.ReviewBlockers, result.Decision.ReviewBlockers) {
		t.Fatalf("reloaded candidate lost review metadata: %+v", reloaded)
	}
}

func TestAddConflictReturnsReviewRequired(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review01")
	existing := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Chroma as default vector DB",
		Decision: "Use Chroma as the default vector database.",
		Sources:  []string{"@doc/specs/vector"},
	})

	result, err := New(store).Add(&models.DecisionEntry{
		Title:        "Use Qdrant as default vector DB",
		Decision:     "Use Qdrant as the default vector database.",
		Sources:      []string{"https://example.com/vector"},
		RelatedTasks: []string{task.ID},
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
	if result.Candidate == nil || result.Candidate.ReviewState != models.DecisionReviewStateNeedsResolution ||
		!reflect.DeepEqual(result.Candidate.ReviewAllowedResolutions, AllowedResolutions) {
		t.Fatalf("candidate review metadata = %+v, want needs_resolution", result.Candidate)
	}
	reloaded, err := store.Decisions.Get(result.Candidate.ID)
	if err != nil {
		t.Fatalf("reload conflict candidate: %v", err)
	}
	if reloaded.ReviewState != models.DecisionReviewStateNeedsResolution || len(reloaded.ReviewMatches) != 1 {
		t.Fatalf("reloaded conflict candidate = %+v", reloaded)
	}
}

func TestAddVerifiedCandidatePersistsReadyForReview(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review02")
	result, err := New(store).Add(&models.DecisionEntry{
		Title:        "Use a durable Decision review inbox",
		Decision:     "Persist review state with the candidate.",
		Sources:      []string{"https://example.com/decision-flow"},
		RelatedTasks: []string{task.ID},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if result.Status != ResultCreated || result.Decision == nil {
		t.Fatalf("result = %+v, want created draft", result)
	}
	if result.Decision.ReviewState != models.DecisionReviewStateReadyForReview ||
		len(result.Decision.ReviewBlockers) != 0 ||
		!reflect.DeepEqual(result.Decision.ReviewAllowedResolutions, ReadyResolutions) {
		t.Fatalf("ready candidate = %+v", result.Decision)
	}
	if result.Decision.CurrentForDefaultRetrieval() {
		t.Fatal("ready candidate became current without explicit acceptance")
	}
}

func TestResolvePersistedCandidateAcceptsOnlyReadyCandidate(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review03")
	result, err := New(store).Add(&models.DecisionEntry{
		Title:        "Accept persisted candidate by ID",
		Decision:     "Use the persisted candidate ID during review.",
		Sources:      []string{"https://example.com/accept-candidate"},
		RelatedTasks: []string{task.ID},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	resolved, err := New(store).Resolve(nil, ResolveOptions{
		CandidateID: result.Decision.ID,
		Resolution:  ResolutionAcceptNew,
	})
	if err != nil {
		t.Fatalf("Resolve accept_new: %v", err)
	}
	if resolved.Current == nil || !resolved.Current.CurrentForDefaultRetrieval() || resolved.Resolution != ResolutionAcceptNew {
		t.Fatalf("resolved = %+v, want current accepted candidate", resolved)
	}
	if resolved.Current.ReviewState != "" || len(resolved.Current.ReviewMatches) != 0 {
		t.Fatalf("accepted Decision retained actionable review state: %+v", resolved.Current)
	}
}

func TestResolvePersistedCandidateReplacesCurrentAtomically(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review04")
	current := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Chroma as default vector DB",
		Decision: "Use Chroma as the default vector database.",
	})
	review, err := New(store).Add(&models.DecisionEntry{
		Title:        "Use Qdrant as default vector DB",
		Decision:     "Use Qdrant as the default vector database.",
		Sources:      []string{"https://example.com/qdrant"},
		RelatedTasks: []string{task.ID},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if review.Candidate == nil || review.Candidate.ReviewState != models.DecisionReviewStateNeedsResolution {
		t.Fatalf("review = %+v, want persisted conflict candidate", review)
	}

	resolved, err := New(store).Resolve(nil, ResolveOptions{
		CandidateID: review.Candidate.ID,
		Resolution:  ResolutionSupersedeExisting,
		TargetID:    current.ID,
	})
	if err != nil {
		t.Fatalf("Resolve replace: %v", err)
	}
	if resolved.Current == nil || resolved.Superseded == nil ||
		resolved.Current.Status != models.DecisionStatusAccepted ||
		resolved.Superseded.Status != models.DecisionStatusSuperseded ||
		!containsReviewString(resolved.Current.Supersedes, current.ID) ||
		!containsReviewString(resolved.Superseded.SupersededBy, resolved.Current.ID) {
		t.Fatalf("atomic replacement result = %+v", resolved)
	}
}

func TestResolvePersistedCandidateLinksProvenanceAndRejectsDuplicate(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review05")
	current := createReviewDecision(t, store, &models.DecisionEntry{
		Title:    "Use Qdrant as default vector DB",
		Decision: "Use Qdrant as the default vector database.",
	})
	review, err := New(store).Add(&models.DecisionEntry{
		Title:        current.Title,
		Decision:     current.Decision,
		Sources:      []string{"https://example.com/new-provenance"},
		RelatedTasks: []string{task.ID},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	opts := ResolveOptions{
		CandidateID: review.Candidate.ID,
		Resolution:  ResolutionLinkAsRelated,
		TargetID:    current.ID,
	}
	resolved, err := New(store).Resolve(nil, opts)
	if err != nil {
		t.Fatalf("Resolve link: %v", err)
	}
	if resolved.Decision == nil || resolved.Decision.Status != models.DecisionStatusRejected ||
		resolved.Current == nil ||
		!containsReviewString(resolved.Current.Sources, "https://example.com/new-provenance") ||
		!containsReviewString(resolved.Current.Sources, models.DecisionRef(review.Candidate.ID)) {
		t.Fatalf("link result = %+v", resolved)
	}
	retried, err := New(store).Resolve(nil, opts)
	if err != nil {
		t.Fatalf("retry link: %v", err)
	}
	if retried.Decision.ID != resolved.Decision.ID || retried.Current.ID != resolved.Current.ID {
		t.Fatalf("retry changed resolution identity: %+v", retried)
	}
}

func TestResolvePersistedCandidateRejectIsIdempotentAndLeavesInbox(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := createDoneReviewTask(t, store, "review06")
	candidate, err := New(store).Add(&models.DecisionEntry{
		Title:        "Reject this candidate",
		Sources:      []string{"https://example.com/reject"},
		RelatedTasks: []string{task.ID},
	}, AddOptions{})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	opts := ResolveOptions{CandidateID: candidate.Decision.ID, Resolution: ResolutionRejectNew}
	first, err := New(store).Resolve(nil, opts)
	if err != nil {
		t.Fatalf("Resolve reject: %v", err)
	}
	second, err := New(store).Resolve(nil, opts)
	if err != nil {
		t.Fatalf("retry reject: %v", err)
	}
	if first.Decision.Status != models.DecisionStatusRejected || second.Decision.Status != models.DecisionStatusRejected {
		t.Fatalf("reject results = %+v / %+v", first, second)
	}
	inbox, err := New(store).ReviewCandidates()
	if err != nil {
		t.Fatalf("ReviewCandidates: %v", err)
	}
	if len(inbox) != 0 {
		t.Fatalf("rejected candidate remained in inbox: %+v", inbox)
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
	if result.Status != ResultResolved || result.Current == nil || result.Decision == nil || !result.PendingVerification {
		t.Fatalf("result = %+v, want draft replacement pending verification", result)
	}
	if result.Current.ID != oldDecision.ID || result.Current.Status != models.DecisionStatusAccepted {
		t.Fatalf("current result = %+v, want unchanged old decision", result.Current)
	}
	if result.Decision.Status != models.DecisionStatusDraft {
		t.Fatalf("replacement status = %q, want draft", result.Decision.Status)
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
	verifiedAt := fixedDecisionReviewTime()
	entry.Status = models.DecisionStatusAccepted
	entry.Verification = []string{"task:@task-review:done"}
	entry.VerifiedAt = &verifiedAt
	if err := store.Decisions.Create(entry, storage.DecisionCreateOptions{Now: fixedDecisionReviewTime()}); err != nil {
		t.Fatalf("create decision %q: %v", entry.Title, err)
	}
	return entry
}

func createDoneReviewTask(t *testing.T, store *storage.Store, id string) *models.Task {
	t.Helper()
	task := &models.Task{
		ID:       id,
		Title:    "Verify Decision candidate",
		Status:   "done",
		Priority: "medium",
		Labels:   []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{
			Text:      "Verified",
			Completed: true,
		}},
	}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatalf("create task %q: %v", id, err)
	}
	return task
}

func TestAcceptRequiresCompletedLinkedTasksAndRecordsEvidence(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	task := &models.Task{
		ID:                 "abc123",
		Title:              "Implement decision",
		Status:             "in-progress",
		Priority:           "medium",
		Labels:             []string{},
		AcceptanceCriteria: []models.AcceptanceCriterion{{Text: "Verified", Completed: true}},
	}
	if err := store.Tasks.Create(task); err != nil {
		t.Fatalf("create task: %v", err)
	}
	entry := &models.DecisionEntry{
		Title:        "Verified lifecycle",
		Sources:      []string{"https://example.com/source"},
		RelatedTasks: []string{task.ID},
	}
	if err := store.Decisions.Create(entry, storage.DecisionCreateOptions{Now: fixedDecisionReviewTime()}); err != nil {
		t.Fatalf("create decision: %v", err)
	}
	svc := New(store)
	svc.Now = func() time.Time { return fixedDecisionReviewTime().Add(time.Hour) }
	if _, err := svc.Accept(entry.ID, AcceptOptions{}); err == nil {
		t.Fatal("Accept succeeded with incomplete linked task")
	}
	task.Status = "done"
	if err := store.Tasks.Update(task); err != nil {
		t.Fatalf("update task: %v", err)
	}
	result, err := svc.Accept(entry.ID, AcceptOptions{})
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if !result.Decision.CurrentForDefaultRetrieval() || result.Decision.VerifiedAt == nil || len(result.Decision.Verification) < 2 {
		t.Fatalf("accepted decision missing verified evidence: %+v", result.Decision)
	}
}

func TestVerifySourceAcceptsCanonicalTaskReference(t *testing.T) {
	store := newDecisionReviewTestStore(t)
	if err := store.Tasks.Create(&models.Task{
		ID:       "source01",
		Title:    "Canonical source task",
		Status:   "done",
		Priority: "medium",
		Labels:   []string{},
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}

	svc := New(store)
	if err := svc.verifySource("@task/source01"); err != nil {
		t.Fatalf("verify canonical task source: %v", err)
	}
	if err := svc.verifySource("@task/missing"); err == nil {
		t.Fatal("verifySource accepted a missing canonical task source")
	}
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

func containsReviewString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
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
