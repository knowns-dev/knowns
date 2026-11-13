package storage

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/howznguyen/knowns/internal/registry"
)

// Settings owned by one person or one machine rather than the team (store spec
// D13). In a store-linked project they never enter the synced config.json.
var (
	personalSettingKeys = []string{"defaultAssignee", "platforms"}
	machineSettingKeys  = []string{"serverPort", "lsp"}
)

// projectSettingsKey is the top-level key of ~/.knowns/settings.json holding
// personal settings per store-linked project.
const projectSettingsKey = "projectSettings"

// configSplit knows where a store-linked project's personal and machine
// settings live.
type configSplit struct {
	projectRoot  string
	settingsPath string
	registryPath string
}

func newConfigSplit(projectRoot string) *configSplit {
	global := GlobalRootPath()
	return &configSplit{
		projectRoot:  projectRoot,
		settingsPath: filepath.Join(global, "settings.json"),
		registryPath: filepath.Join(global, "registry.json"),
	}
}

// overlay copies personal and machine settings from their homes into raw's
// settings. A value only present in config.json (written before the split)
// is kept, so existing projects keep their settings until the next write
// moves them.
func (c *configSplit) overlay(raw map[string]any) {
	settings := settingsMap(raw)
	for key, value := range c.readPersonal() {
		settings[key] = value
	}
	if project := c.registryProject(false); project != nil {
		for key, value := range project.Machine {
			var decoded any
			if err := json.Unmarshal(value, &decoded); err == nil {
				settings[key] = decoded
			}
		}
	}
}

// storeOwned moves personal and machine settings out of raw into their homes.
// Their homes are replaced with exactly what raw carries, so clearing a value
// clears it everywhere.
func (c *configSplit) storeOwned(raw map[string]any) error {
	settings := settingsMap(raw)

	personal := map[string]any{}
	for _, key := range personalSettingKeys {
		if value, ok := settings[key]; ok {
			personal[key] = value
			delete(settings, key)
		}
	}
	machine := map[string]json.RawMessage{}
	for _, key := range machineSettingKeys {
		if value, ok := settings[key]; ok {
			data, err := json.Marshal(value)
			if err != nil {
				return fmt.Errorf("save machine setting %s: %w", key, err)
			}
			machine[key] = data
			delete(settings, key)
		}
	}

	if err := c.writePersonal(personal); err != nil {
		return err
	}
	project := c.registryProject(true)
	if project == nil {
		if len(machine) > 0 {
			return fmt.Errorf("save machine settings: %s is not linked to a store in %s", c.projectRoot, c.registryPath)
		}
		return nil
	}
	reg := registry.NewRegistryWithPath(c.registryPath)
	if err := reg.Load(); err != nil {
		return fmt.Errorf("save machine settings: %w", err)
	}
	return reg.SetMachine(project.Path, machine)
}

// personalKey identifies the project in ~/.knowns/settings.json by its
// registry ID, which survives path spellings and moves; the path is the
// fallback for a project the registry does not know.
func (c *configSplit) personalKey() string {
	if project := c.registryProject(false); project != nil && project.ID != "" {
		return project.ID
	}
	return c.projectRoot
}

func (c *configSplit) readPersonal() map[string]any {
	raw, err := readGenericJSON(c.settingsPath)
	if err != nil {
		return nil
	}
	all, _ := raw[projectSettingsKey].(map[string]any)
	mine, _ := all[c.personalKey()].(map[string]any)
	return mine
}

func (c *configSplit) writePersonal(personal map[string]any) error {
	raw, err := readGenericJSON(c.settingsPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("save personal settings: %w", err)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	all, _ := raw[projectSettingsKey].(map[string]any)
	if all == nil {
		all = map[string]any{}
	}
	key := c.personalKey()
	if len(personal) == 0 {
		if _, had := all[key]; !had {
			return nil
		}
		delete(all, key)
	} else {
		all[key] = personal
	}
	if len(all) == 0 {
		delete(raw, projectSettingsKey)
	} else {
		raw[projectSettingsKey] = all
	}
	return writeCanonicalJSON(c.settingsPath, raw)
}

func (c *configSplit) registryProject(repair bool) *registry.Project {
	reg := registry.NewRegistryWithPath(c.registryPath)
	var err error
	if repair {
		err = reg.Load()
	} else {
		err = reg.LoadReadOnly()
	}
	if err != nil {
		return nil
	}
	return reg.FindStoreLinked(c.projectRoot)
}

func settingsMap(raw map[string]any) map[string]any {
	settings, ok := raw["settings"].(map[string]any)
	if !ok {
		settings = map[string]any{}
		raw["settings"] = settings
	}
	return settings
}

// writeCanonicalJSON writes v in the one canonical form every config writer
// shares: object keys sorted, two-space indent, trailing newline. A struct and
// a generic map holding the same content produce the same bytes.
func writeCanonicalJSON(path string, v any) error {
	generic, err := toGeneric(v)
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(generic, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(data, '\n'))
}

func toGeneric(v any) (any, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var generic any
	if err := dec.Decode(&generic); err != nil {
		return nil, err
	}
	return generic, nil
}

func toGenericMap(v any) (map[string]any, error) {
	generic, err := toGeneric(v)
	if err != nil {
		return nil, err
	}
	m, ok := generic.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("expected a JSON object")
	}
	return m, nil
}

func readGenericJSON(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m, err := decodeGenericObject(data)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return m, nil
}

// decodeGenericObject decodes a JSON object keeping numbers exact, so a
// read-modify-write never reformats a number it did not touch.
func decodeGenericObject(data []byte) (map[string]any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}
