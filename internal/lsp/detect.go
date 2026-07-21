package lsp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

var autoDetectionIgnoredDirs = map[string]struct{}{
	".git":         {},
	".hg":          {},
	".knowns":      {},
	".svn":         {},
	"build":        {},
	"dist":         {},
	"fixture":      {},
	"fixtures":     {},
	"gen":          {},
	"generated":    {},
	"node_modules": {},
	"out":          {},
	"target":       {},
	"test-data":    {},
	"testdata":     {},
	"third_party":  {},
	"vendor":       {},
	"vendored":     {},
}

type Detector struct {
	Registry   *Registry
	LookPath   func(string) (string, error)
	RunCheck   func(context.Context, string, ...string) error
	RunCommand func(context.Context, string, ...string) ([]byte, error)
	Installer  *Installer
}

func NewDetector(registry *Registry) *Detector {
	if registry == nil {
		registry = NewRegistry(nil)
	}
	return &Detector{
		Registry:   registry,
		LookPath:   exec.LookPath,
		RunCheck:   runVersionCheck,
		RunCommand: defaultRunCommand,
		Installer:  NewInstaller(DefaultLSPBaseDir()),
	}
}

func (d *Detector) Detect(ctx context.Context, root string, cfg Config) ([]ServerCommand, error) {
	languages, err := d.DetectedLanguages(root, cfg)
	if err != nil {
		return nil, err
	}

	var commands []ServerCommand
	for _, lang := range languages {
		if lang.ID == CSharpLanguageID && cfg.BinaryOverride(lang.ID) == "" {
			cmd, ok := ResolveCSharpBackendWithOptions(ctx, root, cfg, CSharpResolveOptions{
				LookPath:   d.LookPath,
				RunCheck:   d.RunCheck,
				RunCommand: d.RunCommand,
				Installer:  d.Installer,
			})
			if ok {
				commands = append(commands, cmd)
			}
			continue
		}
		cmd, ok := d.resolve(ctx, root, lang, cfg.BinaryOverride(lang.ID))
		if ok {
			if lang.ID == CSharpLanguageID {
				cmd.Backend = cfg.BackendOverride(lang.ID)
				if cmd.Backend == "" {
					cmd.Backend = "custom"
				}
				cmd.ProjectPath = DiscoverCSharpProject(root, cfg.ProjectPathOverride(lang.ID)).Path
			}
			commands = append(commands, cmd)
		}
	}
	return commands, nil
}

// DetectedLanguages returns enabled languages with matching project files.
func (d *Detector) DetectedLanguages(root string, cfg Config) ([]Language, error) {
	seen := make(map[string]bool)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			if path != root && isAutoDetectionIgnoredDir(entry.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		lang, ok := d.Registry.ForDetection(path)
		if ok {
			seen[lang.ID] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	var languages []Language
	for _, lang := range d.Registry.Languages() {
		if seen[lang.ID] && cfg.Enabled(lang.ID) {
			languages = append(languages, lang)
		}
	}
	return languages, nil
}

func isAutoDetectionIgnoredDir(name string) bool {
	_, ignored := autoDetectionIgnoredDirs[strings.ToLower(strings.TrimSpace(name))]
	return ignored
}

func (d *Detector) resolve(ctx context.Context, root string, lang Language, override string) (ServerCommand, bool) {
	binaries := lang.Binaries
	if override != "" {
		binary := Binary{Name: override}
		if len(binaries) > 0 {
			binary.CheckArgs = append([]string(nil), binaries[0].CheckArgs...)
		}
		binaries = []Binary{binary}
	}
	for _, binary := range binaries {
		path, err := d.LookPath(binary.Name)
		if err != nil {
			continue
		}
		if d.RunCheck != nil && len(binary.CheckArgs) > 0 {
			checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err = d.RunCheck(checkCtx, path, binary.CheckArgs...)
			cancel()
			if err != nil {
				continue
			}
		}
		return ServerCommand{Language: lang.ID, Name: binary.Name, Path: path, Args: append([]string(nil), binary.Args...), LogPath: LanguageLogPath(root, lang.ID)}, true
	}
	return ServerCommand{}, false
}

func runVersionCheck(ctx context.Context, path string, args ...string) error {
	cmd := exec.CommandContext(ctx, path, args...)
	return cmd.Run()
}
