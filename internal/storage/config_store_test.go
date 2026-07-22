package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/howznguyen/knowns/internal/models"
)

func TestConfigStoreLoadsLegacyLifecycleDefaultsWithoutRewriting(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	legacy := `{"name":"legacy","id":"legacy","settings":{"defaultPriority":"medium","statuses":["todo","done"]}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile legacy config: %v", err)
	}
	store := NewStore(root)
	project, err := store.Config.Load()
	if err != nil {
		t.Fatalf("Load legacy config: %v", err)
	}
	if project.Settings.TaskLifecycle != nil {
		t.Fatalf("Load materialized legacy lifecycle block: %#v", project.Settings.TaskLifecycle)
	}
	effective := project.Settings.EffectiveTaskLifecycle()
	if !effective.AutoArchive || effective.ArchiveAfter != "30d" {
		t.Fatalf("effective legacy lifecycle = %#v, want built-in defaults", effective)
	}
	if err := store.Config.Save(project); err != nil {
		t.Fatalf("Save legacy config: %v", err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile saved config: %v", err)
	}
	if strings.Contains(string(data), "taskLifecycle") {
		t.Fatalf("unrelated save rewrote legacy lifecycle config:\n%s", data)
	}
}

func TestConfigStoreRejectsInvalidLifecycleDurations(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.json")
	invalid := `{"name":"invalid","settings":{"taskLifecycle":{"archiveAfter":"-1d"}}}`
	if err := os.WriteFile(configPath, []byte(invalid), 0o644); err != nil {
		t.Fatalf("WriteFile invalid config: %v", err)
	}
	store := NewStore(root)
	if _, err := store.Config.Load(); err == nil || !strings.Contains(err.Error(), "archiveAfter") {
		t.Fatalf("Load invalid lifecycle error = %v, want archiveAfter validation", err)
	}

	settings := models.DefaultProjectSettings()
	settings.TaskLifecycle.ArchiveAfter = "tomorrow"
	if err := store.Config.Save(&models.Project{Name: "invalid", Settings: settings}); err == nil {
		t.Fatal("Save invalid lifecycle config succeeded, want error")
	}
}

func TestConfigStoreSetRejectsInvalidLifecycleWithoutMutation(t *testing.T) {
	root := t.TempDir()
	store := NewStore(root)
	if err := store.Init("config-set"); err != nil {
		t.Fatalf("Init: %v", err)
	}
	configPath := filepath.Join(root, "config.json")
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile before Set: %v", err)
	}
	if err := store.Config.Set("settings.taskLifecycle.archiveAfter", "-2h"); err == nil {
		t.Fatal("Set invalid lifecycle duration succeeded, want error")
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile after Set: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("invalid Set mutated config:\nbefore=%s\nafter=%s", before, after)
	}
}
