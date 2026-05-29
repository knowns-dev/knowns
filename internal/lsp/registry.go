package lsp

import (
	"path/filepath"
	"strings"
)

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
	Language string
	Name     string
	Path     string
	Args     []string
}

type Registry struct {
	languages []Language
	byExt     map[string]Language
}

func NewRegistry(languages []Language) *Registry {
	if len(languages) == 0 {
		languages = BuiltinLanguages()
	}
	r := &Registry{languages: append([]Language(nil), languages...), byExt: make(map[string]Language)}
	for _, lang := range r.languages {
		for _, ext := range lang.Extensions {
			r.byExt[strings.ToLower(ext)] = lang
		}
	}
	return r
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
	}
}

func (r *Registry) Register(lang Language) {
	if len(lang.Extensions) == 0 {
		return
	}
	if _, exists := r.byExt[strings.ToLower(lang.Extensions[0])]; exists {
		return
	}
	r.languages = append(r.languages, lang)
	for _, ext := range lang.Extensions {
		r.byExt[strings.ToLower(ext)] = lang
	}
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
