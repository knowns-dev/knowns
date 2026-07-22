package search

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/storage"
)

func TestLegacyTaskLifecycleProjectLoadsAndReindexesWithoutRewrite(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".knowns")
	store := storage.NewStore(root)
	if err := store.Init("legacy-lifecycle"); err != nil {
		t.Fatalf("Init: %v", err)
	}

	legacyConfig := []byte(`{"name":"legacy-lifecycle","id":"legacy-lifecycle","settings":{"defaultPriority":"medium","statuses":["todo","done"]},"futureConfig":{"keep":true}}`)
	paths := map[string][]byte{
		filepath.Join(root, "config.json"):               legacyConfig,
		filepath.Join(root, "tasks", "task-legact.md"):   legacyTaskFixture("legact", "Legacy active migration compatibility needle", "todo", "active body", false),
		filepath.Join(root, "tasks", "task-legdne.md"):   legacyTaskFixture("legdne", "Legacy done migration compatibility needle", "done", "done body", false),
		filepath.Join(root, "archive", "task-legarc.md"): legacyTaskFixture("legarc", "Legacy archived migration compatibility needle", "done", "archived body", true),
	}
	for path, content := range paths {
		if err := os.WriteFile(path, content, 0o644); err != nil {
			t.Fatalf("write legacy fixture %s: %v", path, err)
		}
	}

	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("load legacy config: %v", err)
	}
	if project.Settings.TaskLifecycle != nil {
		t.Fatalf("legacy load materialized lifecycle config: %+v", project.Settings.TaskLifecycle)
	}
	effective := project.Settings.EffectiveTaskLifecycle()
	if !effective.ExcludeDoneFromDefaultRetrieval || !effective.AutoArchive || effective.ArchiveAfter != "30d" || effective.PurgeAfter != nil {
		t.Fatalf("effective legacy defaults = %+v", effective)
	}

	archived, err := store.Tasks.Get("legarc")
	if err != nil {
		t.Fatalf("get legacy archived Task: %v", err)
	}
	if !archived.Archived || archived.LifecycleState() != models.TaskLifecycleArchived || archived.CompletedAt != nil || archived.ArchivedAt != nil {
		t.Fatalf("legacy archived Task = %+v", archived)
	}
	if archived.Description != "archived body" {
		t.Fatalf("legacy archived body = %q", archived.Description)
	}

	now := time.Now().UTC()
	if err := store.Docs.Create(&models.Doc{
		Path:        "guides/legacy-search-control",
		Title:       "Unrelated document sentinel",
		Description: "unrelated document sentinel",
		Content:     "unrelated document sentinel remains searchable",
		CreatedAt:   now,
		UpdatedAt:   now,
	}); err != nil {
		t.Fatalf("create control doc: %v", err)
	}

	engine := NewEngine(store, nil, nil)
	human, err := engine.Search(SearchOptions{Query: "migration compatibility needle", Type: "task", Mode: string(ModeKeyword), Limit: 10})
	if err != nil {
		t.Fatalf("legacy human Search: %v", err)
	}
	assertTaskResultIDs(t, human, []string{"legact", "legdne"})
	defaultAI, err := engine.Retrieve(models.RetrievalOptions{Query: "migration compatibility needle", Mode: string(ModeKeyword), SourceTypes: []string{"task"}, Limit: 10})
	if err != nil {
		t.Fatalf("legacy default Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, defaultAI.Candidates, []string{"legact"})
	historicalKeyword, err := engine.Retrieve(models.RetrievalOptions{Query: "migration compatibility needle", Mode: string(ModeKeyword), SourceTypes: []string{"task"}, IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("legacy historical keyword Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, historicalKeyword.Candidates, []string{"legact", "legdne", "legarc"})
	control, err := engine.Search(SearchOptions{Query: "unrelated document sentinel", Type: "doc", Mode: string(ModeKeyword), Limit: 10})
	if err != nil || len(control) != 1 || control[0].ID != "guides/legacy-search-control" {
		t.Fatalf("unrelated doc Search = %+v, %v", control, err)
	}

	indexed := &recordingVectorStore{hashes: map[string]string{}}
	if err := NewIndexService(store, stubEmbedder{}, indexed).Reindex(nil); err != nil {
		t.Fatalf("legacy semantic Reindex: %v", err)
	}
	for _, id := range []string{"legact", "legdne", "legarc"} {
		if indexed.GetContentHash("task:"+id) == "" {
			t.Fatalf("legacy Reindex omitted Task %s", id)
		}
	}
	scored := make([]ScoredChunk, 0, len(indexed.chunks))
	for _, chunk := range indexed.chunks {
		if chunk.Type == ChunkTypeTask {
			scored = append(scored, ScoredChunk{Chunk: chunk, Score: 0.9})
		}
	}
	semantic := NewEngine(store, stubEmbedder{}, &stubVectorStore{chunks: scored})
	defaultSemantic, err := semantic.Retrieve(models.RetrievalOptions{Query: "migration compatibility needle", Mode: string(ModeSemantic), SourceTypes: []string{"task"}, Limit: 10})
	if err != nil {
		t.Fatalf("legacy default semantic Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, defaultSemantic.Candidates, []string{"legact"})
	historicalSemantic, err := semantic.Retrieve(models.RetrievalOptions{Query: "migration compatibility needle", Mode: string(ModeSemantic), SourceTypes: []string{"task"}, IncludeHistorical: true, Limit: 10})
	if err != nil {
		t.Fatalf("legacy historical semantic Retrieve: %v", err)
	}
	assertTaskCandidateIDs(t, historicalSemantic.Candidates, []string{"legact", "legdne", "legarc"})

	for path, want := range paths {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read fixture after load/reindex %s: %v", path, err)
		}
		if string(got) != string(want) {
			t.Fatalf("load/reindex destructively rewrote %s\nwant: %q\n got: %q", path, want, got)
		}
	}
}

func legacyTaskFixture(id, title, status, description string, crlf bool) []byte {
	content := "---\n" +
		"id: " + id + "\n" +
		"title: \"" + title + "\"\n" +
		"status: " + status + "\n" +
		"priority: medium\n" +
		"labels: []\n" +
		"createdAt: '2026-07-01T10:00:00.000Z'\n" +
		"updatedAt: '2026-07-01T11:00:00.000Z'\n" +
		"timeSpent: 0\n" +
		"customLegacy: keep-me\n" +
		"---\n" +
		"# " + title + "\n\n" +
		"## Description\n\n" +
		"<!-- BEGIN:description -->\n" + description + "\n<!-- END:description -->\n\n" +
		"## Custom Legacy Section\n\nDo not rewrite this body.\n"
	if crlf {
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	return []byte(content)
}
