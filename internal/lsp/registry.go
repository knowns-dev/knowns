package lsp

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

var ErrExtensionAlreadyRegistered = errors.New("extension already registered for another language")

type Language struct {
	ID         string
	Name       string
	Extensions []string
	Binaries   []Binary
}

type Binary struct {
	Name      string
	Args      []string
	CheckArgs []string
}

type ServerCommand struct {
	Language    string
	Name        string
	Path        string
	Args        []string
	Backend     string
	ProjectPath string
	LogPath     string
	Attempts    []BackendAttempt
}

type Registry struct {
	languages []Language
	byID      map[string]Language
	byExt     map[string]Language
}

func NewRegistry(languages []Language) *Registry {
	if languages == nil {
		languages = BuiltinLanguages()
	}
	r := &Registry{byID: make(map[string]Language), byExt: make(map[string]Language)}
	for _, lang := range languages {
		_ = r.Register(lang)
	}
	return r
}

func NewEmptyRegistry() *Registry {
	return NewRegistry([]Language{})
}

func BuiltinLanguages() []Language {
	return []Language{
		{ID: "go", Name: "Go", Extensions: []string{".go"}, Binaries: []Binary{{Name: "gopls", Args: []string{"serve"}, CheckArgs: []string{"version"}}}},
		{ID: "typescript", Name: "TypeScript", Extensions: []string{".ts"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "typescriptreact", Name: "TSX", Extensions: []string{".tsx"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "javascript", Name: "JavaScript", Extensions: []string{".js"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "javascriptreact", Name: "JSX", Extensions: []string{".jsx"}, Binaries: []Binary{{Name: "typescript-language-server", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "python", Name: "Python", Extensions: []string{".py"}, Binaries: []Binary{{Name: "pylsp", CheckArgs: []string{"--version"}}, {Name: "pyright-langserver", Args: []string{"--stdio"}, CheckArgs: []string{"--version"}}}},
		{ID: "rust", Name: "Rust", Extensions: []string{".rs"}, Binaries: []Binary{{Name: "rust-analyzer", CheckArgs: []string{"--version"}}}},
		{ID: DartLanguageID, Name: "Dart", Extensions: []string{".dart"}, Binaries: []Binary{{Name: "dart", Args: []string{"language-server"}, CheckArgs: []string{"--version"}}}},
	}
}

func (r *Registry) Register(lang Language) error {
	lang.ID = strings.TrimSpace(lang.ID)
	lang.Name = strings.TrimSpace(lang.Name)
	lang.Extensions = normalizeRegistryExtensions(lang.Extensions)
	if lang.ID == "" || len(lang.Extensions) == 0 {
		return nil
	}
	if r.byID == nil {
		r.byID = make(map[string]Language)
	}
	if r.byExt == nil {
		r.byExt = make(map[string]Language)
	}

	for _, ext := range lang.Extensions {
		if owner, ok := r.byExt[ext]; ok && owner.ID != lang.ID {
			return fmt.Errorf("%w: %s is owned by %s", ErrExtensionAlreadyRegistered, ext, owner.ID)
		}
	}

	for ext, owner := range r.byExt {
		if owner.ID == lang.ID {
			delete(r.byExt, ext)
		}
	}
	if _, exists := r.byID[lang.ID]; exists {
		for i := range r.languages {
			if r.languages[i].ID == lang.ID {
				r.languages[i] = lang
				break
			}
		}
	} else {
		r.languages = append(r.languages, lang)
	}
	r.byID[lang.ID] = lang
	for _, ext := range lang.Extensions {
		r.byExt[ext] = lang
	}
	return nil
}

func (r *Registry) Languages() []Language {
	return append([]Language(nil), r.languages...)
}

func (r *Registry) ForPath(path string) (Language, bool) {
	lang, ok := r.byExt[strings.ToLower(filepath.Ext(path))]
	return lang, ok
}

func (r *Registry) HasExtension(path string) bool {
	_, ok := r.ForPath(path)
	return ok
}

func normalizeRegistryExtensions(extensions []string) []string {
	if len(extensions) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(extensions))
	out := make([]string, 0, len(extensions))
	for _, ext := range extensions {
		ext = strings.ToLower(strings.TrimSpace(ext))
		if ext == "" {
			continue
		}
		if _, ok := seen[ext]; ok {
			continue
		}
		seen[ext] = struct{}{}
		out = append(out, ext)
	}
	return out
}
