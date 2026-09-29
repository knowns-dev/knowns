package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/registry"
)

func readTeamConfig(t *testing.T, store *Store) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(store.Root, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func teamSetting(m map[string]any, key string) (any, bool) {
	settings, _ := m["settings"].(map[string]any)
	v, ok := settings[key]
	return v, ok
}

// openLinked links a fresh repository to a store folder initialized with the
// default config and returns its Store.
func openLinked(t *testing.T, home, name string) *Store {
	t.Helper()
	code := mkdir(t, filepath.Join(home, "work", name))
	folder := linkToStore(t, home, code)
	os.Remove(filepath.Join(folder, "config.json"))
	store := NewStoreWithProjectRoot(folder, code)
	if err := store.Init(name); err != nil {
		t.Fatal(err)
	}
	loc, err := LocateProjectAt(code)
	if err != nil {
		t.Fatal(err)
	}
	return loc.Open()
}

func TestPersonalAndMachineSettingsNeverEnterTheTeamFile(t *testing.T) {
	home := locationFixture(t)
	store := openLinked(t, home, "shop-web")

	project, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	project.Settings.DefaultAssignee = "@alice"
	project.Settings.Platforms = []string{"claude"}
	project.Settings.ServerPort = 4555
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.Config.Set("settings.defaultPriority", "high"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	team := readTeamConfig(t, store)
	for _, key := range []string{"defaultAssignee", "platforms", "serverPort", "lsp"} {
		if _, ok := teamSetting(team, key); ok {
			t.Fatalf("team config.json must not carry %s: %v", key, team["settings"])
		}
	}
	if v, _ := teamSetting(team, "defaultPriority"); v != "high" {
		t.Fatalf("team setting lost: %v", team["settings"])
	}

	reloaded, err := store.Config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Settings.DefaultAssignee != "@alice" || reloaded.Settings.ServerPort != 4555 || len(reloaded.Settings.Platforms) != 1 {
		t.Fatalf("merged view lost owned settings: %+v", reloaded.Settings)
	}
	if got, _ := store.Config.Get("settings.defaultAssignee"); got != "@alice" {
		t.Fatalf("Get(settings.defaultAssignee) = %v", got)
	}
	if !strings.Contains(string(mustRead(t, filepath.Join(home, ".knowns", "settings.json"))), "@alice") {
		t.Fatal("personal settings should be written to ~/.knowns/settings.json")
	}
	reg := registry.NewRegistryWithPath(filepath.Join(home, ".knowns", "registry.json"))
	reg.Load()
	if p := reg.FindStoreLinked(store.ProjectRoot); p == nil || string(p.Machine["serverPort"]) != "4555" {
		t.Fatalf("machine settings should be in the registry entry, got %+v", p)
	}
}

// Two machines share the synced team file; each keeps its own assignee.
func TestTwoMachinesKeepTheirOwnAssignee(t *testing.T) {
	homeA := locationFixture(t)
	storeA := openLinked(t, homeA, "shop-web")
	pA, _ := storeA.Config.Load()
	pA.Settings.DefaultAssignee = "@alice"
	if err := storeA.Config.Save(pA); err != nil {
		t.Fatal(err)
	}
	synced := mustRead(t, filepath.Join(storeA.Root, "config.json"))

	homeB := locationFixture(t) // machine B: another HOME
	storeB := openLinked(t, homeB, "shop-web")
	if err := os.WriteFile(filepath.Join(storeB.Root, "config.json"), synced, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := storeB.Config.Set("settings.defaultAssignee", "@bob"); err != nil {
		t.Fatal(err)
	}
	pB, _ := storeB.Config.Load()
	if pB.Settings.DefaultAssignee != "@bob" {
		t.Fatalf("machine B assignee = %q, want @bob", pB.Settings.DefaultAssignee)
	}
	if string(mustRead(t, filepath.Join(storeB.Root, "config.json"))) != string(synced) {
		t.Fatal("setting a personal value on machine B must not change the synced team file")
	}

	t.Setenv("HOME", homeA)
	pA, _ = storeA.Config.Load()
	if pA.Settings.DefaultAssignee != "@alice" {
		t.Fatalf("machine A assignee = %q, want @alice", pA.Settings.DefaultAssignee)
	}
}

func TestSaveAndSetWriteByteIdenticalTeamFiles(t *testing.T) {
	for name, open := range map[string]func(t *testing.T) *Store{
		"in-repo": func(t *testing.T) *Store {
			home := locationFixture(t)
			code := mkdir(t, filepath.Join(home, "work", "legacy"))
			s := NewStore(filepath.Join(code, ".knowns"))
			if err := s.Init("legacy"); err != nil {
				t.Fatal(err)
			}
			return s
		},
		"store-linked": func(t *testing.T) *Store {
			return openLinked(t, locationFixture(t), "shop-web")
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := open(t)
			project, _ := store.Config.Load()
			if err := store.Config.Save(project); err != nil {
				t.Fatal(err)
			}
			viaSave := mustRead(t, filepath.Join(store.Root, "config.json"))
			if err := store.Config.Set("settings.defaultPriority", project.Settings.DefaultPriority); err != nil {
				t.Fatal(err)
			}
			viaSet := mustRead(t, filepath.Join(store.Root, "config.json"))
			if string(viaSave) != string(viaSet) {
				t.Fatalf("Save and Set disagree on identical content:\n--- Save\n%s\n--- Set\n%s", viaSave, viaSet)
			}
		})
	}
}

func TestLegacyOwnedSettingsSurviveAndMoveOnWrite(t *testing.T) {
	home := locationFixture(t)
	store := openLinked(t, home, "shop-api")
	path := filepath.Join(store.Root, "config.json")
	team := readTeamConfig(t, store)
	settings := team["settings"].(map[string]any)
	settings["defaultAssignee"] = "@carol"
	settings["serverPort"] = 4777
	data, _ := json.Marshal(team)
	os.WriteFile(path, data, 0o644)

	p, err := store.Config.Load()
	if err != nil || p.Settings.DefaultAssignee != "@carol" || p.Settings.ServerPort != 4777 {
		t.Fatalf("legacy values must keep working before any write: %+v, %v", p, err)
	}
	if err := store.Config.Set("settings.defaultPriority", "low"); err != nil {
		t.Fatal(err)
	}
	after := readTeamConfig(t, store)
	if _, ok := teamSetting(after, "defaultAssignee"); ok {
		t.Fatal("the first write must move legacy personal settings out of the team file")
	}
	p, _ = store.Config.Load()
	if p.Settings.DefaultAssignee != "@carol" || p.Settings.ServerPort != 4777 {
		t.Fatalf("moved settings must still apply: %+v", p.Settings)
	}
}

func TestInRepoProjectKeepsEverySettingInConfig(t *testing.T) {
	home := locationFixture(t)
	code := mkdir(t, filepath.Join(home, "work", "legacy"))
	store := NewStore(filepath.Join(code, ".knowns"))
	if err := store.Init("legacy"); err != nil {
		t.Fatal(err)
	}
	if err := store.Config.Set("settings.defaultAssignee", "@dave"); err != nil {
		t.Fatal(err)
	}
	if v, _ := teamSetting(readTeamConfig(t, store), "defaultAssignee"); v != "@dave" {
		t.Fatal("an in-repo project keeps defaultAssignee in config.json")
	}
	if _, err := os.Stat(filepath.Join(home, ".knowns", "settings.json")); !os.IsNotExist(err) {
		t.Fatal("an in-repo project must not write ~/.knowns/settings.json for its config")
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
