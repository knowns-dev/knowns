package lsp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

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
			switch entry.Name() {
			case ".git", ".knowns", "node_modules", "vendor", "target", "dist", "build":
				if path != root {
					return filepath.SkipDir
				}
			}
			return nil
		}
		lang, ok := d.Registry.ForPath(path)
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

func (d *Detector) resolve(ctx context.Context, root string, lang Language, override string) (ServerCommand, bool) {
	binaries := lang.Binaries
	if override != "" {
		binaries = []Binary{{Name: override}}
	}
	for _, binary := range binaries {
		path, err := d.LookPath(binary.Name)
		if err != nil {
			continue
		}
		if d.RunCheck != nil {
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
