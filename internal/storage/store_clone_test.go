package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureStoreGitignoreWritesManagedBlockOnce(t *testing.T) {
	clone := t.TempDir()

	changed, err := EnsureStoreGitignore(clone)
	if err != nil || !changed {
		t.Fatalf("first call = %v, %v; want a written file", changed, err)
	}
	data, _ := os.ReadFile(filepath.Join(clone, ".gitignore"))
	for _, p := range StoreIgnorePatterns {
		if !strings.Contains(string(data), p+"\n") {
			t.Fatalf(".gitignore misses %q:\n%s", p, data)
		}
	}

	changed, err = EnsureStoreGitignore(clone)
	if err != nil || changed {
		t.Fatalf("second call = %v, %v; want no change", changed, err)
	}
}

func TestEnsureStoreGitignoreKeepsTeamLinesAndRefreshesBlock(t *testing.T) {
	clone := t.TempDir()
	path := filepath.Join(clone, ".gitignore")
	stale := "drafts/\n" + storeIgnoreBegin + "\n**/.search/\n" + storeIgnoreEnd + "\nscratch.md"
	os.WriteFile(path, []byte(stale), 0o644)

	if _, err := EnsureStoreGitignore(clone); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	got := string(data)
	if !strings.HasPrefix(got, "drafts/\n") || !strings.HasSuffix(got, "scratch.md") {
		t.Fatalf("team lines must survive:\n%s", got)
	}
	if strings.Count(got, storeIgnoreBegin) != 1 || !strings.Contains(got, "**/chats.json") {
		t.Fatalf("managed block must be refreshed in place:\n%s", got)
	}
}

func TestEnsureStoreGitignoreRejectsUnterminatedBlock(t *testing.T) {
	clone := t.TempDir()
	os.WriteFile(filepath.Join(clone, ".gitignore"), []byte(storeIgnoreBegin+"\n**/.search/\n"), 0o644)
	if _, err := EnsureStoreGitignore(clone); err == nil {
		t.Fatal("an unterminated block must be reported, not rewritten")
	}
}

func TestBrokenStoreMappingIsReportedNotSkipped(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "shop-web"))
	folder := linkToStore(t, home, code)
	if err := os.Remove(filepath.Join(folder, "config.json")); err != nil {
		t.Fatal(err)
	}

	_, err := LocateProject(code)
	if err == nil || !strings.Contains(err.Error(), `"team"`) || !strings.Contains(err.Error(), folder) {
		t.Fatalf("a broken mapping with no fallback must error naming the store and folder, got %v", err)
	}

	initInRepoProject(t, code)
	loc, err := LocateProject(code)
	if err != nil {
		t.Fatal(err)
	}
	if loc.KnowledgeRoot != filepath.Join(code, ".knowns") || loc.BrokenStore == nil {
		t.Fatalf("expected the in-repo fallback with the broken store recorded, got %+v", loc)
	}
	warnings := strings.Join(loc.Warnings(), "\n")
	if !strings.Contains(warnings, `"team"`) || !strings.Contains(warnings, folder) {
		t.Fatalf("warning must name the store and folder, got %q", warnings)
	}
}
