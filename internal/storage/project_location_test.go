package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/registry"
)

// locationFixture isolates the machine registry under a temporary HOME and
// returns the home directory. The temp path is left unresolved on purpose: on
// macOS it sits behind the /var -> /private/var symlink, which is the shape
// safepath must accept for a store outside the project directory.
func locationFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

func initInRepoProject(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, ".knowns"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".knowns", "config.json"), []byte(`{"name":"`+filepath.Base(dir)+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

// linkToStore creates an initialized project folder in store "team" and maps
// the code repository at code to it in the machine registry.
func linkToStore(t *testing.T, home, code string) string {
	t.Helper()
	reg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	if err := reg.Load(); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(reg.StoresRoot(), "team", filepath.Base(code))
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "config.json"), []byte(`{"name":"`+filepath.Base(code)+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.AddStoreLinked(code, registry.StoreMapping{Name: "team", Project: filepath.Base(code)}); err != nil {
		t.Fatal(err)
	}
	return reg.KnowledgeRoot(*reg.FindByPath(code))
}

func mkdir(t *testing.T, dir string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func samePath(a, b string) bool {
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return filepath.Clean(a) == filepath.Clean(b)
	}
	return ra == rb
}

func TestLocateProjectInRepoBehavesAsBefore(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "legacy"))
	initInRepoProject(t, code)
	sub := mkdir(t, filepath.Join(code, "src", "pkg"))

	loc, err := LocateProject(sub)
	if err != nil {
		t.Fatalf("LocateProject: %v", err)
	}
	if loc.KnowledgeRoot != filepath.Join(code, ".knowns") || loc.ProjectRoot != code || loc.Store != nil || loc.IgnoredKnowns != "" {
		t.Fatalf("in-repo location = %+v", loc)
	}
	root, err := FindProjectRoot(sub)
	if err != nil || root != filepath.Join(code, ".knowns") {
		t.Fatalf("FindProjectRoot = %q, %v", root, err)
	}
	if _, err := os.Stat(filepath.Join(home, ".knowns", "registry.json")); !os.IsNotExist(err) {
		t.Fatalf("resolving an in-repo project must not create a registry, stat err = %v", err)
	}
}

func TestEveryResolutionPathAgreesForStoreLinkedProject(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "shop-web"))
	knowledge := linkToStore(t, home, code)
	sub := mkdir(t, filepath.Join(code, "web", "src"))

	walk, err := LocateProject(sub) // cwd walk-up
	if err != nil {
		t.Fatalf("LocateProject: %v", err)
	}
	exact, err := LocateProjectAt(code) // --project, KNOWNS_PROJECT, set_project, browser
	if err != nil {
		t.Fatalf("LocateProjectAt: %v", err)
	}
	found, err := FindProjectRoot(sub)
	if err != nil {
		t.Fatalf("FindProjectRoot: %v", err)
	}
	reopened := NewStore(knowledge) // runtime, reconcilers, qdrant
	switched, err := NewManager(nil, registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))).Switch(code)
	if err != nil {
		t.Fatalf("Manager.Switch: %v", err)
	}
	loadedReg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	if err := loadedReg.Load(); err != nil {
		t.Fatal(err)
	}
	switchedLoaded, err := NewManager(nil, loadedReg).Switch(code)
	if err != nil {
		t.Fatalf("Manager.Switch with a loaded registry: %v", err)
	}

	for name, got := range map[string][2]string{
		"walk-up":         {walk.KnowledgeRoot, walk.ProjectRoot},
		"exact":           {exact.KnowledgeRoot, exact.ProjectRoot},
		"FindProjectRoot": {found, code},
		"NewStore":        {reopened.Root, reopened.ProjectRoot},
		"Manager.Switch":  {switched.Root, switched.ProjectRoot},
		"Switch (loaded)": {switchedLoaded.Root, switchedLoaded.ProjectRoot},
		"walk-up opened":  {walk.Open().Root, walk.Open().ProjectRoot},
	} {
		if !samePath(got[0], knowledge) || !samePath(got[1], code) {
			t.Fatalf("%s resolved knowledge=%q project=%q, want knowledge=%q project=%q", name, got[0], got[1], knowledge, code)
		}
	}
	if _, err := os.Stat(filepath.Join(code, ".knowns")); !os.IsNotExist(err) {
		t.Fatalf("resolution must not create .knowns/ in the code repository, stat err = %v", err)
	}
}

func TestStoreLinkWinsOverInRepoKnownsAndWarns(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "shop-api"))
	initInRepoProject(t, code) // teammate has not migrated yet
	knowledge := linkToStore(t, home, code)

	for _, locate := range []func() (ProjectLocation, error){
		func() (ProjectLocation, error) { return LocateProject(code) },
		func() (ProjectLocation, error) { return LocateProjectAt(code) },
	} {
		loc, err := locate()
		if err != nil {
			t.Fatal(err)
		}
		if !samePath(loc.KnowledgeRoot, knowledge) {
			t.Fatalf("store must win: knowledge root %q, want %q", loc.KnowledgeRoot, knowledge)
		}
		if loc.IgnoredKnowns != filepath.Join(code, ".knowns") {
			t.Fatalf("IgnoredKnowns = %q", loc.IgnoredKnowns)
		}
		msg := loc.IgnoredKnownsWarning()
		if !strings.Contains(msg, filepath.Join(code, ".knowns")) || !strings.Contains(msg, "team") {
			t.Fatalf("warning must name the ignored directory and the store: %q", msg)
		}
	}
}

func TestNearestEnclosingProjectWins(t *testing.T) {
	home := locationFixture(t)
	outer := mkdir(t, filepath.Join(home, "work", "mono"))
	initInRepoProject(t, outer)
	inner := mkdir(t, filepath.Join(outer, "apps", "shop-web"))
	knowledge := linkToStore(t, home, inner)

	loc, err := LocateProject(filepath.Join(inner))
	if err != nil {
		t.Fatal(err)
	}
	if !samePath(loc.KnowledgeRoot, knowledge) || loc.ProjectRoot != inner {
		t.Fatalf("nested store-linked repo should win, got %+v", loc)
	}
	loc, err = LocateProject(mkdir(t, filepath.Join(outer, "docs")))
	if err != nil || loc.ProjectRoot != outer {
		t.Fatalf("sibling path should resolve to the outer in-repo project, got %+v, %v", loc, err)
	}
}

func TestKnowledgeInStoreOutsideProjectIsNotAnEscape(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "shop-app"))
	linkToStore(t, home, code)
	loc, err := LocateProject(code)
	if err != nil {
		t.Fatal(err)
	}
	store := loc.Open()

	doc := &models.Doc{Path: "architecture/overview", Title: "Overview", Content: "# Overview\n"}
	if err := store.Docs.Create(doc); err != nil {
		t.Fatalf("creating a doc in a store outside the project directory: %v", err)
	}
	got, err := store.Docs.Get("architecture/overview")
	if err != nil || got.Title != "Overview" {
		t.Fatalf("reading it back = %+v, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(loc.KnowledgeRoot, "docs", "architecture", "overview.md")); err != nil {
		t.Fatalf("doc should live in the store folder: %v", err)
	}
	if entries, _ := os.ReadDir(code); len(entries) != 0 {
		t.Fatalf("the code repository must stay untouched, found %d entries", len(entries))
	}
}

func TestNewStoreSeesStoreLinkMadeAfterEarlierLookup(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "late"))
	reg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	reg.Load()
	folder := filepath.Join(reg.StoresRoot(), "team", "late")
	mkdir(t, folder)
	os.WriteFile(filepath.Join(folder, "config.json"), []byte(`{"name":"late"}`), 0o644)
	if err := reg.Save(); err != nil {
		t.Fatal(err)
	}

	if got := NewStore(folder).ProjectRoot; samePath(got, code) {
		t.Fatalf("before linking, the store folder must not resolve to the repository")
	}
	if _, err := reg.AddStoreLinked(code, registry.StoreMapping{Name: "team", Project: "late"}); err != nil {
		t.Fatal(err)
	}
	if got := NewStore(folder).ProjectRoot; !samePath(got, code) {
		t.Fatalf("after linking, ProjectRoot = %q, want %q", got, code)
	}
}
