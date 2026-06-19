package lsp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

const (
	CSharpLanguageID            = "csharp"
	CSharpBackendAuto           = "auto"
	CSharpBackendRoslyn         = "roslyn-ls"
	CSharpBackendCSharp         = "csharp-ls"
	CSharpBackendOmni           = "omnisharp"
	RoslynLanguageServerVersion = "5.0.0-1.25277.114"
	RoslynNuGetPackagePrefix    = "Microsoft.CodeAnalysis.LanguageServer"
	BackendAttemptFailed        = "failed"
	BackendAttemptChosen        = "selected"
	BackendAttemptSkipped       = "skipped"
)

// BackendAttempt records a C# backend resolver decision.
type BackendAttempt struct {
	Backend string `json:"backend"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Path    string `json:"path,omitempty"`
}

type CSharpBackend struct {
	ID        string
	Binary    Binary
	BuildArgs func(string, CSharpProjectSelection) []string
}

type CSharpProjectSelection struct {
	Path string
	Kind string
}

type CSharpResolveOptions struct {
	LookPath          func(string) (string, error)
	RunCheck          func(context.Context, string, ...string) error
	RunCommand        func(context.Context, string, ...string) ([]byte, error)
	Installer         *Installer
	AutoInstallRoslyn bool
}

func CSharpBackends() []CSharpBackend {
	return []CSharpBackend{
		{ID: CSharpBackendRoslyn, Binary: Binary{Name: "roslyn-ls", CheckArgs: []string{"--version"}}},
		{ID: CSharpBackendCSharp, Binary: Binary{Name: "csharp-ls", CheckArgs: []string{"--version"}}, BuildArgs: csharpLSArgs},
		{ID: CSharpBackendOmni, Binary: Binary{Name: "omnisharp", Args: []string{"--languageserver"}, CheckArgs: []string{"--version"}}},
	}
}

func CSharpBackendIDs() []string {
	backends := CSharpBackends()
	ids := make([]string, 0, len(backends))
	for _, backend := range backends {
		ids = append(ids, backend.ID)
	}
	return ids
}

func IsCSharpBackendID(id string) bool {
	for _, backend := range CSharpBackends() {
		if backend.ID == id {
			return true
		}
	}
	return false
}

func ResolveCSharpBackend(ctx context.Context, root string, cfg Config, lookPath func(string) (string, error), runCheck func(context.Context, string, ...string) error) (ServerCommand, bool) {
	return ResolveCSharpBackendWithOptions(ctx, root, cfg, CSharpResolveOptions{LookPath: lookPath, RunCheck: runCheck})
}

func ResolveCSharpBackendWithOptions(ctx context.Context, root string, cfg Config, opts CSharpResolveOptions) (ServerCommand, bool) {
	if opts.LookPath == nil {
		opts.LookPath = func(name string) (string, error) { return "", fmt.Errorf("%s not found", name) }
	}
	selection := DiscoverCSharpProject(root, cfg.ProjectPathOverride(CSharpLanguageID))
	backendID := cfg.BackendOverride(CSharpLanguageID)
	if backendID == "" {
		backendID = CSharpBackendAuto
	}

	var candidates []CSharpBackend
	autoMode := backendID == CSharpBackendAuto
	if autoMode {
		candidates = CSharpBackends()
	} else {
		backend, ok := csharpBackendByID(backendID)
		if !ok {
			return ServerCommand{Language: CSharpLanguageID, Backend: backendID, ProjectPath: selection.Path, LogPath: CSharpLogPath(root, backendID), Attempts: []BackendAttempt{{Backend: backendID, Status: BackendAttemptFailed, Reason: "unknown backend"}}}, false
		}
		candidates = []CSharpBackend{backend}
	}

	var attempts []BackendAttempt
	for idx, backend := range candidates {
		if backend.ID == CSharpBackendRoslyn && opts.Installer != nil {
			cmd, attempt, ok := resolveManagedRoslyn(ctx, root, cfg, opts, selection)
			attempts = append(attempts, attempt)
			if ok {
				if autoMode {
					for _, skipped := range candidates[idx+1:] {
						attempts = append(attempts, BackendAttempt{Backend: skipped.ID, Status: BackendAttemptSkipped, Reason: "earlier backend selected"})
					}
				}
				cmd.Attempts = attempts
				return cmd, true
			}
			if cmd.Path != "" {
				continue
			}
		}

		path, err := opts.LookPath(backend.Binary.Name)
		if err != nil {
			attempts = append(attempts, BackendAttempt{Backend: backend.ID, Status: BackendAttemptFailed, Reason: err.Error()})
			continue
		}
		if opts.RunCheck != nil && len(backend.Binary.CheckArgs) > 0 {
			checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err = opts.RunCheck(checkCtx, path, backend.Binary.CheckArgs...)
			cancel()
			if err != nil {
				attempts = append(attempts, BackendAttempt{Backend: backend.ID, Status: BackendAttemptFailed, Reason: err.Error(), Path: path})
				continue
			}
		}
		args := append([]string(nil), backend.Binary.Args...)
		if backend.BuildArgs != nil {
			args = append(args, backend.BuildArgs(root, selection)...)
		}
		attempts = append(attempts, BackendAttempt{Backend: backend.ID, Status: BackendAttemptChosen, Path: path})
		if autoMode {
			for _, skipped := range candidates[idx+1:] {
				attempts = append(attempts, BackendAttempt{Backend: skipped.ID, Status: BackendAttemptSkipped, Reason: "earlier backend selected"})
			}
		}
		return ServerCommand{
			Language:    CSharpLanguageID,
			Name:        backend.Binary.Name,
			Path:        path,
			Args:        args,
			Backend:     backend.ID,
			ProjectPath: selection.Path,
			LogPath:     CSharpLogPath(root, backend.ID),
			Attempts:    attempts,
		}, true
	}

	return ServerCommand{Language: CSharpLanguageID, Backend: backendID, ProjectPath: selection.Path, LogPath: CSharpLogPath(root, backendID), Attempts: attempts}, false
}

func CSharpBackendUnavailableError(root string, cmd ServerCommand) *RuntimeError {
	backend := cmd.Backend
	if backend == "" {
		backend = CSharpBackendAuto
	}
	return &RuntimeError{
		Code:        "csharp_backend_unavailable",
		Language:    CSharpLanguageID,
		Backend:     backend,
		Message:     "No C# LSP backend is available",
		Remediation: "Run `knowns lsp install csharp` for managed Roslyn LS, install .NET SDK 10+, or configure backend/path overrides.",
		LogPath:     CSharpLogPath(root, backend),
		Attempts:    cmd.Attempts,
	}
}

func resolveManagedRoslyn(ctx context.Context, root string, cfg Config, opts CSharpResolveOptions, selection CSharpProjectSelection) (ServerCommand, BackendAttempt, bool) {
	dep := CSharpRoslynRuntimeDependency(cfg)
	logPath := CSharpLogPath(root, CSharpBackendRoslyn)
	var serverPath string
	var installReason string
	if opts.Installer != nil {
		adapter := dependencyAdapter{id: CSharpLanguageID, deps: []RuntimeDependency{dep}}
		if path, ok := opts.Installer.IsInstalled(adapter); ok {
			serverPath = path
		} else if opts.AutoInstallRoslyn {
			path, err := opts.Installer.Install(ctx, adapter)
			if err != nil {
				installReason = err.Error()
			} else {
				serverPath = path
			}
		} else {
			installReason = "managed Roslyn LS is not installed; run: knowns lsp install csharp"
		}
	}
	if serverPath != "" {
		dotnetPath, err := ResolveDotnet10(ctx, cfg, opts.LookPath, opts.RunCommand, logPath)
		if err != nil {
			return ServerCommand{Language: CSharpLanguageID, Path: serverPath, Backend: CSharpBackendRoslyn, ProjectPath: selection.Path, LogPath: logPath}, BackendAttempt{
				Backend: CSharpBackendRoslyn,
				Status:  BackendAttemptFailed,
				Reason:  err.Error(),
				Path:    serverPath,
			}, false
		}
		return ServerCommand{
			Language:    CSharpLanguageID,
			Name:        "dotnet",
			Path:        dotnetPath,
			Args:        roslynDotnetArgs(serverPath, selection),
			Backend:     CSharpBackendRoslyn,
			ProjectPath: selection.Path,
			LogPath:     logPath,
		}, BackendAttempt{Backend: CSharpBackendRoslyn, Status: BackendAttemptChosen, Path: serverPath}, true
	}
	if installReason != "" {
		return ServerCommand{}, BackendAttempt{Backend: CSharpBackendRoslyn, Status: BackendAttemptFailed, Reason: installReason}, false
	}
	return ServerCommand{}, BackendAttempt{Backend: CSharpBackendRoslyn, Status: BackendAttemptFailed, Reason: "managed Roslyn LS installer is not configured"}, false
}

func roslynDotnetArgs(serverPath string, _ CSharpProjectSelection) []string {
	return []string{serverPath, "--stdio"}
}

func csharpLSArgs(root string, selection CSharpProjectSelection) []string {
	if selection.Kind != "sln" || selection.Path == "" {
		return nil
	}
	return []string{"--solution", csharpLSProjectPath(root, selection.Path)}
}

func csharpLSProjectPath(root, projectPath string) string {
	rel, err := filepath.Rel(root, projectPath)
	if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return projectPath
	}
	return rel
}

func CSharpRoslynRuntimeDependency(cfg Config) RuntimeDependency {
	version := cfg.VersionOverride(CSharpLanguageID)
	if version == "" {
		version = RoslynLanguageServerVersion
	}
	settings := cfg.LanguageSettings(CSharpLanguageID)
	rid := CSharpRoslynRID(runtime.GOOS, runtime.GOARCH)
	packageName := stringSetting(settings, "roslynPackage")
	if packageName == "" {
		packageName = RoslynNuGetPackagePrefix + "." + rid
	}
	extractPath := stringSetting(settings, "roslynExtractPath")
	if extractPath == "" {
		extractPath = filepath.ToSlash(filepath.Join("content", "LanguageServer", rid, "Microsoft.CodeAnalysis.LanguageServer.dll"))
	}
	return RuntimeDependency{
		ID:            packageName,
		PlatformID:    CurrentPlatformID(),
		Version:       version,
		Source:        "nuget",
		ArchiveType:   "nupkg",
		PackageName:   packageName,
		PackageSource: stringSetting(settings, "roslynPackageSource"),
		URL:           stringSetting(settings, "roslynPackageURL"),
		SHA256:        stringSetting(settings, "roslynSHA256"),
		SHA512:        stringSetting(settings, "roslynSHA512"),
		BinaryName:    "Microsoft.CodeAnalysis.LanguageServer.dll",
		ExtractPath:   extractPath,
	}
}

func CSharpRoslynRID(goos, goarch string) string {
	osPart := goos
	switch goos {
	case "darwin":
		osPart = "osx"
	case "windows":
		osPart = "win"
	}
	archPart := goarch
	switch goarch {
	case "amd64":
		archPart = "x64"
	case "386":
		archPart = "x86"
	}
	return osPart + "-" + archPart
}

func csharpBackendByID(id string) (CSharpBackend, bool) {
	for _, backend := range CSharpBackends() {
		if backend.ID == id {
			return backend, true
		}
	}
	return CSharpBackend{}, false
}

func DiscoverCSharpProject(root, override string) CSharpProjectSelection {
	if override != "" {
		path := override
		if !filepath.IsAbs(path) {
			path = filepath.Join(root, path)
		}
		return CSharpProjectSelection{Path: filepath.Clean(path), Kind: csharpProjectKind(path)}
	}
	if selected := discoverCSharpProjectByExt(root, []string{".sln", ".slnx"}); selected.Path != "" {
		return selected
	}
	return discoverCSharpProjectByExt(root, []string{".csproj"})
}

func discoverCSharpProjectByExt(root string, exts []string) CSharpProjectSelection {
	type dirItem struct {
		path  string
		depth int
	}
	queue := []dirItem{{path: root}}
	allowed := make(map[string]struct{}, len(exts))
	for _, ext := range exts {
		allowed[strings.ToLower(ext)] = struct{}{}
	}
	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]
		entries, err := os.ReadDir(item.path)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name()) })
		var dirs []dirItem
		for _, entry := range entries {
			if entry.IsDir() {
				if item.path != root && isCSharpIgnoredDir(entry.Name()) {
					continue
				}
				if item.path == root && isCSharpIgnoredDir(entry.Name()) {
					continue
				}
				dirs = append(dirs, dirItem{path: filepath.Join(item.path, entry.Name()), depth: item.depth + 1})
				continue
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if _, ok := allowed[ext]; ok {
				path := filepath.Join(item.path, entry.Name())
				return CSharpProjectSelection{Path: path, Kind: csharpProjectKind(path)}
			}
		}
		queue = append(queue, dirs...)
	}
	return CSharpProjectSelection{}
}

func csharpProjectKind(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".sln":
		return "sln"
	case ".slnx":
		return "slnx"
	case ".csproj":
		return "csproj"
	default:
		return ""
	}
}

func isCSharpIgnoredDir(name string) bool {
	switch name {
	case ".git", ".knowns", "bin", "obj", ".vs", "packages", "node_modules", "vendor", "target", "dist", "build":
		return true
	default:
		return false
	}
}

func describeCSharpAttempts(attempts []BackendAttempt) string {
	if len(attempts) == 0 {
		return ""
	}
	parts := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		if attempt.Reason == "" {
			parts = append(parts, fmt.Sprintf("%s:%s", attempt.Backend, attempt.Status))
		} else {
			parts = append(parts, fmt.Sprintf("%s:%s(%s)", attempt.Backend, attempt.Status, attempt.Reason))
		}
	}
	return strings.Join(parts, ", ")
}
