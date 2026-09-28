package util

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type InstallMetadata struct {
	Method         string `json:"method,omitempty"`
	ManagedBy      string `json:"managedBy,omitempty"`
	UpdateStrategy string `json:"updateStrategy,omitempty"`
	Channel        string `json:"channel,omitempty"`
	Platform       string `json:"platform,omitempty"`
	Arch           string `json:"arch,omitempty"`
	BinaryPath     string `json:"binaryPath,omitempty"`
	// LinkPaths are the symlinks the shell installer placed in a PATH
	// directory. Kept here so a self-update rewrite does not drop them
	// before the uninstaller reads them.
	LinkPaths   []string `json:"linkPaths,omitempty"`
	Version     string   `json:"version,omitempty"`
	InstalledAt string   `json:"installedAt,omitempty"`
}

func InstallMetadataPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".knowns", "install.json")
}

func LoadInstallMetadata() (*InstallMetadata, error) {
	path := InstallMetadataPath()
	if path == "" {
		return nil, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var meta InstallMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func SaveInstallMetadata(meta *InstallMetadata) error {
	if meta == nil {
		return nil
	}
	path := InstallMetadataPath()
	if path == "" {
		return nil
	}
	if meta.Platform == "" {
		meta.Platform = runtime.GOOS
	}
	if meta.Arch == "" {
		meta.Arch = runtime.GOARCH
	}
	if meta.InstalledAt == "" {
		meta.InstalledAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0644)
}

func (m *InstallMetadata) IsScriptManaged() bool {
	if m == nil {
		return false
	}
	return strings.EqualFold(m.Method, "script") || strings.EqualFold(m.UpdateStrategy, "self-update")
}

func NormalizeVersionTag(version string) string {
	version = strings.TrimSpace(version)
	if version == "" {
		return version
	}
	if strings.HasPrefix(version, "v") {
		return version
	}
	return "v" + version
}
