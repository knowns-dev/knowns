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
	ID                   string   `json:"id,omitempty"`
	PlatformID           string   `json:"platform_id,omitempty"` // "darwin-arm64", "linux-amd64", etc.
	Version              string   `json:"version,omitempty"`
	RecommendedVersion   string   `json:"recommended_version,omitempty"`
	RecommendedIntegrity string   `json:"recommended_integrity,omitempty"`
	Source               string   `json:"source,omitempty"` // "archive", "binary", "npm", "nuget", etc.
	URL                  string   `json:"url,omitempty"`
	SHA256               string   `json:"sha256,omitempty"`
	SHA512               string   `json:"sha512,omitempty"`
	PackageSource        string   `json:"package_source,omitempty"`
	ArchiveType          string   `json:"archive_type,omitempty"` // "tar.gz", "zip", "binary", "npm", "nupkg"
	BinaryName           string   `json:"binary_name,omitempty"`
	ExtractPath          string   `json:"extract_path,omitempty"`
	PackageName          string   `json:"package_name,omitempty"`
	Packages             []string `json:"packages,omitempty"`
}

// InstallSelector identifies the version requested by a managed install. The
// zero value selects the adapter's recommended known-good version.
type InstallSelector struct {
	Latest  bool   `json:"latest,omitempty"`
	Version string `json:"version,omitempty"`
}

// InstallOptions configures a managed dependency install. Resolver hooks are
// intentionally per-call so tests and adapters can resolve npm tags or release
// assets without mutating shared installer state.
type InstallOptions struct {
	Selector        InstallSelector    `json:"selector"`
	NPMResolver     DependencyResolver `json:"-"`
	ReleaseResolver DependencyResolver `json:"-"`
	BeforeCleanup   func(string) error `json:"-"`
}

// DependencyResolution is the immutable result recorded as install
// provenance before a dependency is selected for use.
type DependencyResolution struct {
	Dependency       RuntimeDependency `json:"dependency"`
	RequestedVersion string            `json:"requested_version"`
	ResolvedVersion  string            `json:"resolved_version"`
	Source           string            `json:"source"`
	Integrity        string            `json:"integrity,omitempty"`
	Verified         bool              `json:"verified"`
}

// DependencyResolver resolves a selector to concrete, installable dependency
// metadata. Release adapters can provide a hook for upstream-specific APIs;
// npm has a built-in registry resolver.
type DependencyResolver func(context.Context, RuntimeDependency, InstallSelector) (DependencyResolution, error)

// RuntimeDependencyResolverProvider is an optional adapter capability used by
// release-based servers whose latest/tag APIs and asset naming are upstream
// specific. The CLI and Manager discover it automatically.
type RuntimeDependencyResolverProvider interface {
	ResolveRuntimeDependency(context.Context, RuntimeDependency, InstallSelector) (DependencyResolution, error)
}

// ManagedDependencyStatus reports the selected managed dependency state for a
// language server.
type ManagedDependencyStatus struct {
	LanguageID        string `json:"language_id"`
	Version           string `json:"version,omitempty"`
	RequestedVersion  string `json:"requested_version,omitempty"`
	ResolvedVersion   string `json:"resolved_version,omitempty"`
	Source            string `json:"source,omitempty"`
	SourceLocation    string `json:"source_location,omitempty"`
	Integrity         string `json:"integrity,omitempty"`
	InstalledAt       string `json:"installed_at,omitempty"`
	Verified          bool   `json:"verified"`
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

// DocumentSyncOptions describes how a path should participate in LSP document
// synchronization. Suppressed paths remain routable to the server for
// workspace/disk-indexed operations, but must not emit didOpen, didChange, or
// didClose notifications.
type DocumentSyncOptions struct {
	LanguageID string
	Suppress   bool
}

// PathDocumentSyncAdapter optionally customizes document synchronization for a
// routed path. Adapters that do not implement it keep the language adapter ID
// and the existing synchronization behavior.
type PathDocumentSyncAdapter interface {
	DocumentSyncForPath(path string) DocumentSyncOptions
}

// PathCapabilityDecision describes the effective capability view for one path
// and action. The second return value from PathCapabilityForAction indicates
// whether the adapter made a path-specific decision; false preserves the
// server-wide capability contract.
type PathCapabilityDecision struct {
	Supported              bool
	Capabilities           []string
	AdvertisedCapabilities []string
	Explanation            string
}

// PathCapabilityAdapter optionally gates actions whose upstream support varies
// by routed path. The empty action/capability pair asks whether all document
// actions are unavailable, allowing callers to avoid unnecessary server start.
type PathCapabilityAdapter interface {
	PathCapabilityForAction(path, action, capability string) (PathCapabilityDecision, bool)
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
