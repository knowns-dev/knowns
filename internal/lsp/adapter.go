package lsp

import "context"

// ServerStatus represents the lifecycle state of a language server.
type ServerStatus int

const (
	StatusNotInstalled ServerStatus = iota
	StatusInstalled
	StatusStarting
	StatusRunning
	StatusCrashed
	StatusDisabled
)

func (s ServerStatus) String() string {
	switch s {
	case StatusNotInstalled:
		return "not_installed"
	case StatusInstalled:
		return "installed"
	case StatusStarting:
		return "starting"
	case StatusRunning:
		return "running"
	case StatusCrashed:
		return "crashed"
	case StatusDisabled:
		return "disabled"
	default:
		return "unknown"
	}
}

// InstallGuide provides user-facing installation instructions for a language server.
type InstallGuide struct {
	Command   string `json:"command,omitempty"`    // e.g. "go install golang.org/x/tools/gopls@latest"
	URL       string `json:"url,omitempty"`        // e.g. "https://pkg.go.dev/golang.org/x/tools/gopls"
	KnownsCmd string `json:"knowns_cmd,omitempty"` // e.g. "knowns lsp install go" (empty if not downloadable)
	Notes     string `json:"notes,omitempty"`      // e.g. "Requires Go 1.21+ installed"
}

// RuntimeDependency describes a downloadable binary dependency for a language server.
type RuntimeDependency struct {
	ID            string   `json:"id,omitempty"`
	PlatformID    string   `json:"platform_id,omitempty"` // "darwin-arm64", "linux-amd64", etc.
	Version       string   `json:"version,omitempty"`
	Source        string   `json:"source,omitempty"` // "archive", "binary", "npm", "nuget", etc.
	URL           string   `json:"url,omitempty"`
	SHA256        string   `json:"sha256,omitempty"`
	SHA512        string   `json:"sha512,omitempty"`
	PackageSource string   `json:"package_source,omitempty"`
	ArchiveType   string   `json:"archive_type,omitempty"` // "tar.gz", "zip", "binary", "npm", "nupkg"
	BinaryName    string   `json:"binary_name,omitempty"`
	ExtractPath   string   `json:"extract_path,omitempty"`
	PackageName   string   `json:"package_name,omitempty"`
	Packages      []string `json:"packages,omitempty"`
}

// ManagedDependencyStatus reports the selected managed dependency state for a
// language server.
type ManagedDependencyStatus struct {
	LanguageID        string `json:"language_id"`
	Version           string `json:"version,omitempty"`
	Source            string `json:"source,omitempty"`
	CachePath         string `json:"cache_path,omitempty"`
	SelectedPath      string `json:"selected_path,omitempty"`
	CleanupEligible   bool   `json:"cleanup_eligible"`
	InstallError      string `json:"install_error,omitempty"`
	UpdateError       string `json:"update_error,omitempty"`
	Installed         bool   `json:"installed"`
	Installable       bool   `json:"installable"`
	SelectedVersionID string `json:"selected_version_id,omitempty"`
}

// Prerequisite describes a system requirement that must be satisfied before a language server can run.
type Prerequisite struct {
	Name        string `json:"name,omitempty"`         // "Java JDK 17+"
	CheckCmd    string `json:"check_cmd,omitempty"`    // "java -version"
	InstallHint string `json:"install_hint,omitempty"` // "Install from https://..."
}

// BinaryCandidate describes a possible binary name and arguments for a language server.
type BinaryCandidate struct {
	Name      string   `json:"name,omitempty"`
	Args      []string `json:"args,omitempty"`
	CheckArgs []string `json:"check_args,omitempty"`
}

// LanguageAdapter defines the interface that each language server adapter must implement.
type LanguageAdapter interface {
	// Identity
	ID() string
	Name() string
	Extensions() []string

	// Detection & Install Guidance
	Binaries() []BinaryCandidate
	Prerequisites() []Prerequisite
	CheckPrerequisites(ctx context.Context) error
	InstallGuide() InstallGuide

	// User-initiated download
	CanInstall() bool
	RuntimeDeps() []RuntimeDependency
	Install(ctx context.Context, targetDir string) (string, error)
	InstalledPath() (string, bool)

	// Configuration
	DefaultArgs() []string
	InitializeParams(root string, settings map[string]any) map[string]any
	InitializationOptions(settings map[string]any) map[string]any

	// Quirks
	IsIgnoredDir(name string) bool
	NormalizeSymbolName(name string) string
	SupportsImplementation() bool
	SupportsReferences() bool
}

// BaseAdapter provides default implementations for common LanguageAdapter methods.
// Language-specific adapters can embed this struct to inherit sensible defaults.
type BaseAdapter struct{}

// IsIgnoredDir returns false by default (no directories are ignored).
func (b BaseAdapter) IsIgnoredDir(_ string) bool {
	return false
}

// NormalizeSymbolName returns the name unchanged by default.
func (b BaseAdapter) NormalizeSymbolName(name string) string {
	return name
}

// SupportsImplementation returns true by default.
func (b BaseAdapter) SupportsImplementation() bool {
	return true
}

// SupportsReferences returns true by default.
func (b BaseAdapter) SupportsReferences() bool {
	return true
}
