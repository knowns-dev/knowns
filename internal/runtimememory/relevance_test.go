package runtimememory

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/search"
	"github.com/howznguyen/knowns/internal/storage"
)

func relevanceStore(t *testing.T, entries ...*models.MemoryEntry) (*storage.Store, string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	root := t.TempDir()
	store := storage.NewStore(filepath.Join(root, ".knowns"))
	if err := store.Init("runtime-memory"); err != nil {
		t.Fatalf("init store: %v", err)
	}
	for _, entry := range entries {
		if err := store.Memory.Create(entry); err != nil {
			t.Fatalf("create memory %q: %v", entry.Title, err)
		}
	}
	return store, root
}

func stubHybrid(t *testing.T, ok bool, hits ...hybridCandidate) {
	t.Helper()
	lookupHybridCandidates = func(*storage.Store, Input, int) ([]hybridCandidate, bool) { return hits, ok }
	t.Cleanup(func() { lookupHybridCandidates = defaultHybridCandidates })
}

func buildFor(t *testing.T, store *storage.Store, root, prompt string, maxItems int) Pack {
	t.Helper()
	pack, err := Build(store, Input{
		Runtime: "claude-code", ProjectRoot: root, WorkingDir: root,
		ActionType: "user-prompt-submit", UserPrompt: prompt, Mode: ModeAuto,
		MaxItems: maxItems, MaxBytes: 8000,
	})
	if err != nil {
		t.Fatalf("build %q: %v", prompt, err)
	}
	return pack
}

func itemIDs(items []Item) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func sameIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestParaphraseDoesNotChangeWhatIsSelectedOrItsOrder is AC-2 and AC-3 on the
// real data shape. The same memory scored 0.77 for "em dash" and 2.52 for a
// full-sentence paraphrase of the same request, because the score was a raw
// count of shared words. The short prompt was rejected and the long one pulled
// in a second, unrelated memory. A share of the prompt's content words is the
// same for a faithful paraphrase, so both must select the same thing.
func TestParaphraseDoesNotChangeWhatIsSelectedOrItsOrder(t *testing.T) {
	now := time.Now().UTC()
	emdash := &models.MemoryEntry{
		ID: "emdash", Title: "Không dùng em dash trong nội dung", Category: "preference",
		Layer: models.MemoryLayerProject, Status: models.MemoryStatusActive,
		Content:   "Khi viết hoặc chỉnh sửa nội dung cho người dùng, không dùng ký tự em dash.\n\n**Why:** đọc giống máy viết.",
		CreatedAt: now, UpdatedAt: now,
	}
	writing := &models.MemoryEntry{
		ID: "writing", Title: "Commit messages explain why", Category: "convention",
		Layer: models.MemoryLayerProject, Status: models.MemoryStatusActive,
		Content:   "Viết commit message cho người đọc sau này.",
		CreatedAt: now, UpdatedAt: now,
	}
	hashes := &models.MemoryEntry{
		ID: "hashes", Title: "Two hash functions over one record always drift", Category: "failure",
		Layer: models.MemoryLayerProject, Status: models.MemoryStatusActive,
		Content:   "When a stored hash validates on write but fails on read, suspect two implementations.",
		CreatedAt: now, UpdatedAt: now,
	}
	store, root := relevanceStore(t, emdash, writing, hashes)
	stubHybrid(t, false) // semantic unavailable: judge the keyword path on its own

	short := buildFor(t, store, root, "em dash", 5)
	long := buildFor(t, store, root, "Khi viết nội dung cho người dùng thì không dùng ký tự em dash", 5)

	want := []string{"emdash"}
	if got := itemIDs(short.Items); !sameIDs(got, want) {
		t.Fatalf("short prompt selected %v (skip=%q), want %v", got, short.SkipReason, want)
	}
	if got := itemIDs(long.Items); !sameIDs(got, want) {
		t.Fatalf("paraphrase selected %v, want %v: saying the same thing at greater length changed the answer", got, want)
	}
}

// TestSemanticAnswerIsNotOverruledByKeywordMatching guards "ok cảm ơn". When
// the semantic layer ran and nothing it found cleared the floor, that IS the
// answer. The old path fell back to keyword matching whenever no hybrid
// candidate survived, so an unrelated prompt could still inject whatever
// shared a word with it.
func TestSemanticAnswerIsNotOverruledByKeywordMatching(t *testing.T) {
	now := time.Now().UTC()
	queue := &models.MemoryEntry{
		Title: "Runtime queue decision", Category: "pattern", Layer: models.MemoryLayerProject,
		Status: models.MemoryStatusActive, Content: "Use the runtime queue pattern for prompt injection jobs.",
		CreatedAt: now, UpdatedAt: now,
	}
	store, root := relevanceStore(t, queue)
	unrelated := &models.MemoryEntry{
		ID: "colors", Title: "Playful colors", Category: "preference", Layer: models.MemoryLayerProject,
		Status: models.MemoryStatusActive, Content: "Use playful colors in marketing pages.", UpdatedAt: now,
	}
	stubHybrid(t, true, hybridCandidate{entry: unrelated, score: 0.05, semantic: 0.30, matchedBy: []string{"semantic"}})

	pack := buildFor(t, store, root, "runtime queue", 5)
	if len(pack.Items) != 0 {
		t.Fatalf("injected %v: keyword matching overruled a semantic layer that found nothing relevant", itemIDs(pack.Items))
	}
	if pack.SkipReason != SkipReasonBelowThreshold {
		t.Fatalf("skipReason = %q, want %q", pack.SkipReason, SkipReasonBelowThreshold)
	}
	if pack.RetrievalMode != "hybrid" {
		t.Fatalf("retrievalMode = %q, want hybrid: the keyword fallback must not have run", pack.RetrievalMode)
	}
}

// TestSingleStrongHybridMatchIsInjectedAlone is AC-4. A lone match used to need
// a SUM of 1.1, a threshold on an unbounded total, so one genuinely relevant
// memory with nothing else nearby could be rejected for being alone.
func TestSingleStrongHybridMatchIsInjectedAlone(t *testing.T) {
	store, root := relevanceStore(t)
	backoff := &models.MemoryEntry{
		ID: "backoff", Title: "Retry backoff", Category: "pattern", Layer: models.MemoryLayerProject,
		Status: models.MemoryStatusActive, Content: "Retries use jittered backoff.", UpdatedAt: time.Now().UTC(),
	}
	stubHybrid(t, true, hybridCandidate{entry: backoff, score: 0.60, semantic: 0.60, matchedBy: []string{"semantic"}})

	pack := buildFor(t, store, root, "how should a failed network call be attempted again", 5)
	if got := itemIDs(pack.Items); !sameIDs(got, []string{"backoff"}) {
		t.Fatalf("items = %v (skip=%q), want the single strong match injected", got, pack.SkipReason)
	}
}

// TestFloorAppliesBeforeTheItemCap: tie-breakers can rank a below-floor entry
// above an eligible one. If the cap ran first, that entry would take the only
// slot and then be rejected, leaving nothing.
func TestFloorAppliesBeforeTheItemCap(t *testing.T) {
	store, root := relevanceStore(t)
	now := time.Now().UTC()
	nearMiss := &models.MemoryEntry{
		ID: "near-miss", Title: "Runtime queue", Category: "pattern", Layer: models.MemoryLayerProject,
		Status: models.MemoryStatusActive, Content: "runtime queue", UpdatedAt: now,
	}
	eligible := &models.MemoryEntry{
		ID: "eligible", Title: "Job dispatch", Category: "pattern", Layer: models.MemoryLayerGlobal,
		Status: models.MemoryStatusActive, Content: "Background jobs dispatch through one worker.", UpdatedAt: now.Add(-200 * 24 * time.Hour),
	}
	stubHybrid(t, true,
		hybridCandidate{entry: nearMiss, score: 1.0, semantic: 0.54, matchedBy: []string{"semantic", "keyword"}},
		hybridCandidate{entry: eligible, score: 0.9, semantic: 0.58, matchedBy: []string{"semantic"}},
	)

	pack := buildFor(t, store, root, "runtime queue", 1)
	if got := itemIDs(pack.Items); !sameIDs(got, []string{"eligible"}) {
		t.Fatalf("items = %v (skip=%q), want the eligible entry: the floor must run before the cap", got, pack.SkipReason)
	}
}

// TestVietnameseContentWordsTakePartInMatching: tokenRE only knows ASCII, so
// before folding "cách viết tài liệu" shredded into fragments shorter than the
// length filter and the prompt had NO content words at all.
func TestVietnameseContentWordsTakePartInMatching(t *testing.T) {
	entry := &models.MemoryEntry{
		ID: "docs", Title: "Tài liệu tiếng Việt", Category: "preference", Layer: models.MemoryLayerGlobal,
		Status: models.MemoryStatusActive, Content: "Khi viết tài liệu cho người dùng, giữ nguyên tên tính năng.",
	}
	_, _, match := scoreEntry(entry, Input{UserPrompt: "cách viết tài liệu"}, false)
	if match.total == 0 {
		t.Fatal("the prompt produced no content words; diacritics are still shredding Vietnamese")
	}
	if match.overlaps < 2 {
		t.Fatalf("overlaps = %d of %d, want viet/tai/lieu to match", match.overlaps, match.total)
	}
}

// TestFunctionWordsDoNotCountAsSharedWords: "khi", "cho" and "the" appear in
// nearly every memory, and counting them is how one function word plus a
// rank-based boost pulled an em-dash rule into a prompt about hash drift.
func TestFunctionWordsDoNotCountAsSharedWords(t *testing.T) {
	if got := uniqueTokens("khi cho thi the and with"); len(got) != 0 {
		t.Fatalf("function words survived tokenizing: %v", got)
	}
	if got := uniqueTokens("runtime queue"); len(got) != 2 {
		t.Fatalf("content words were dropped: %v", got)
	}
}

// TestSameMemoryIsNeverInjectedTwice: a memory is indexed once per store, and
// one that moved between layers leaves a stale chunk behind (r7upz8, demoted
// to project, still in the global index). Both copies resolve to the same
// entry, and the hook injected it twice on the real store.
func TestSameMemoryIsNeverInjectedTwice(t *testing.T) {
	store, root := relevanceStore(t)
	entry := &models.MemoryEntry{
		ID: "r7upz8", Title: "Document history storage architecture", Category: "pattern",
		Layer: models.MemoryLayerProject, Status: models.MemoryStatusActive,
		Content: "Document history uses stable document IDs.", UpdatedAt: time.Now().UTC(),
	}
	stubHybrid(t, true,
		hybridCandidate{entry: entry, score: 1.0, semantic: 0.58, matchedBy: []string{"semantic"}},
		hybridCandidate{entry: entry, score: 0.9, semantic: 0.61, matchedBy: []string{"semantic"}},
	)

	pack := buildFor(t, store, root, "doc history", 5)
	if got := itemIDs(pack.Items); !sameIDs(got, []string{"r7upz8"}) {
		t.Fatalf("items = %v, want r7upz8 exactly once", got)
	}
	if pack.Items[0].Semantic != 0.61 {
		t.Fatalf("kept the copy with cosine %.2f, want the stronger 0.61", pack.Items[0].Semantic)
	}
}

type fakeMemorySearcher struct {
	results  []models.SearchResult
	degraded *search.SearchDegradation
}

func (f fakeMemorySearcher) SearchWithDegradation(search.SearchOptions) ([]models.SearchResult, *search.SearchDegradation, error) {
	return f.results, f.degraded, nil
}

// TestDegradedSemanticSearchFallsBackToKeywords covers 2026-09-25: Ollama had
// quit while Qdrant stayed up. The engine still reported semantic search as
// available, its semantic leg failed, and it returned keyword-only hits with
// no cosine. The relevance floor dropped all of them, so every prompt got no
// memory at all instead of the keyword fallback.
func TestDegradedSemanticSearchFallsBackToKeywords(t *testing.T) {
	entry := &models.MemoryEntry{Title: "No em dash", Category: "preference", Layer: "project", Status: "active", Content: "Never use the em dash."}
	store, _ := relevanceStore(t, entry)
	keywordOnly := []models.SearchResult{{Type: "memory", ID: entry.ID, Score: 0.9, MatchedBy: []string{"keyword"}}}

	degraded := fakeMemorySearcher{results: keywordOnly, degraded: &search.SearchDegradation{Err: errors.New("embedder unreachable")}}
	if hits, ok := hybridCandidatesFrom(store, degraded, Input{UserPrompt: "em dash"}, 20); ok {
		t.Fatalf("a degraded search was treated as the semantic answer: %+v", hits)
	}

	healthy := fakeMemorySearcher{results: []models.SearchResult{{Type: "memory", ID: entry.ID, Score: 0.9, SemanticScore: 0.7, MatchedBy: []string{"semantic", "keyword"}}}}
	if hits, ok := hybridCandidatesFrom(store, healthy, Input{UserPrompt: "em dash"}, 20); !ok || len(hits) != 1 {
		t.Fatalf("a healthy search was not used: ok=%v hits=%+v", ok, hits)
	}
}
