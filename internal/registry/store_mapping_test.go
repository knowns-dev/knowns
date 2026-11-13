package registry

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// createStoreProjectFolder simulates an initialized project folder inside a
// store clone next to the registry file.
func createStoreProjectFolder(t *testing.T, reg *Registry, store, project string) string {
	t.Helper()
	dir := filepath.Join(reg.StoresRoot(), store, project)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"name":"`+project+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRegistryLoadsPreStoreFileUnchanged(t *testing.T) {
	tmp := canonicalTempDir(t)
	proj := createFakeProject(t, tmp, "legacy")
	regFile := filepath.Join(tmp, "registry.json")
	legacy := `[
  {
    "id": "abc123",
    "name": "legacy",
    "path": ` + jsonString(proj) + `,
    "lastUsed": "2026-01-02T03:04:05Z"
  }
]`
	if err := os.WriteFile(regFile, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	reg := NewRegistryWithPath(regFile)
	if err := reg.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	after, _ := os.ReadFile(regFile)
	if string(after) != legacy {
		t.Fatalf("loading a pre-store registry rewrote it:\n%s", after)
	}
	if len(reg.Projects) != 1 || reg.Projects[0].Store != nil {
		t.Fatalf("expected one project with no store mapping, got %+v", reg.Projects)
	}
	if got, want := reg.KnowledgeRoot(reg.Projects[0]), filepath.Join(proj, ".knowns"); got != want {
		t.Fatalf("KnowledgeRoot = %q, want %q", got, want)
	}
	if !reg.IsValid(reg.Projects[0]) {
		t.Fatal("in-repo project should be valid")
	}
}

func TestRegistryAddStoreLinkedAcceptsRepoWithoutKnowns(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "shop-web")
	if err := os.MkdirAll(code, 0o755); err != nil {
		t.Fatal(err)
	}
	reg := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	reg.Load()
	knowledge := createStoreProjectFolder(t, reg, "team", "shop-web")

	p, err := reg.AddStoreLinked(code, StoreMapping{Name: "team", Project: "shop-web", Remote: "git@example.com:team/knowledge.git"})
	if err != nil {
		t.Fatalf("AddStoreLinked: %v", err)
	}
	if p.Store == nil || p.Store.Name != "team" || p.Store.Project != "shop-web" {
		t.Fatalf("mapping not recorded: %+v", p)
	}
	if got := reg.KnowledgeRoot(*p); got != knowledge {
		t.Fatalf("KnowledgeRoot = %q, want %q", got, knowledge)
	}
	if !reg.IsValid(*p) {
		t.Fatal("store-linked project should be valid without a local .knowns/")
	}
	if _, err := os.Stat(filepath.Join(code, ".knowns")); !os.IsNotExist(err) {
		t.Fatalf("registering must not create .knowns/ in the code repository, stat err = %v", err)
	}

	reloaded := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if got := reloaded.FindByPath(code); got == nil || got.Store == nil || got.Store.Remote != "git@example.com:team/knowledge.git" {
		t.Fatalf("mapping did not survive a reload: %+v", got)
	}

	// Add on the same path keeps the store-linked entry instead of failing
	// for the missing .knowns/.
	again, err := reg.Add(code)
	if err != nil || again.ID != p.ID {
		t.Fatalf("Add on a store-linked path = %+v, %v; want the existing entry", again, err)
	}
}

func TestRegistryAddStoreLinkedRejectsUninitializedStoreFolder(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "shop-web")
	os.MkdirAll(code, 0o755)
	reg := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	reg.Load()

	_, err := reg.AddStoreLinked(code, StoreMapping{Name: "team", Project: "shop-web"})
	if err == nil {
		t.Fatal("expected an error for a store folder that does not exist")
	}
	if len(reg.Projects) != 0 {
		t.Fatalf("nothing should be registered, got %+v", reg.Projects)
	}
}

func TestRegistryAddWithNeitherNamesBothRemedies(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "bare")
	os.MkdirAll(code, 0o755)
	reg := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	reg.Load()

	_, err := reg.Add(code)
	if err == nil {
		t.Fatal("expected an error for a path with neither .knowns/ nor a store")
	}
	for _, want := range []string{"knowns init", "knowns store link"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q should name %q", err, want)
		}
	}
}

func TestRegistryClearStoreKeepsEntryAndStoreFolder(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "shop-web")
	os.MkdirAll(code, 0o755)
	reg := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	reg.Load()
	knowledge := createStoreProjectFolder(t, reg, "team", "shop-web")
	p, err := reg.AddStoreLinked(code, StoreMapping{Name: "team", Project: "shop-web"})
	if err != nil {
		t.Fatal(err)
	}

	if err := reg.ClearStore(code); err != nil {
		t.Fatalf("ClearStore: %v", err)
	}
	got := reg.FindByPath(code)
	if got == nil || got.ID != p.ID || got.Store != nil {
		t.Fatalf("entry after ClearStore = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(knowledge, "config.json")); err != nil {
		t.Fatalf("ClearStore must leave the store folder intact: %v", err)
	}
	if err := reg.ClearStore(code); err == nil {
		t.Fatal("ClearStore on an unlinked project should fail")
	}
}

func TestRegistryScanDoesNotDisturbStoreLinkedProject(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "repos", "shop-web")
	os.MkdirAll(code, 0o755)
	createFakeProject(t, filepath.Join(tmp, "repos"), "legacy")
	reg := NewRegistryWithPath(filepath.Join(tmp, "registry.json"))
	reg.Load()
	createStoreProjectFolder(t, reg, "team", "shop-web")
	if _, err := reg.AddStoreLinked(code, StoreMapping{Name: "team", Project: "shop-web"}); err != nil {
		t.Fatal(err)
	}

	added, err := reg.Scan([]string{filepath.Join(tmp, "repos")})
	if err != nil {
		t.Fatal(err)
	}
	if len(added) != 1 || added[0].Name != "legacy" {
		t.Fatalf("Scan added %+v, want only the in-repo project", added)
	}
	linked := reg.FindByPath(code)
	if linked == nil || linked.Store == nil || !reg.IsValid(*linked) {
		t.Fatalf("store-linked project changed or became invalid after Scan: %+v", linked)
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func TestRegistryAddStoreLinkedRejectsMappingsThatEscapeStoresRoot(t *testing.T) {
	tmp := canonicalTempDir(t)
	code := filepath.Join(tmp, "shop-web")
	os.MkdirAll(code, 0o755)
	reg := NewRegistryWithPath(filepath.Join(tmp, "state", "registry.json"))
	reg.Load()
	// An initialized folder outside the stores directory must stay unreachable.
	outside := filepath.Join(tmp, "outside")
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, "config.json"), []byte(`{}`), 0o644)

	for _, m := range []StoreMapping{
		{Name: "..", Project: "outside"},
		{Name: "team", Project: "../../outside"},
		{Name: "team/sub", Project: "shop-web"},
		{Name: "", Project: "shop-web"},
	} {
		if _, err := reg.AddStoreLinked(code, m); err == nil {
			t.Fatalf("mapping %+v should be rejected", m)
		}
	}
	if len(reg.Projects) != 0 {
		t.Fatalf("nothing should be registered, got %+v", reg.Projects)
	}
}
