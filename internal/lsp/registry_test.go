package lsp

import (
	"errors"
	"testing"
)

func TestRegistryForPath(t *testing.T) {
	registry := NewRegistry(nil)
	tests := map[string]string{
		"main.go":   "go",
		"app.ts":    "typescript",
		"view.tsx":  "typescriptreact",
		"script.js": "javascript",
		"view.jsx":  "javascriptreact",
		"test.py":   "python",
		"lib.rs":    "rust",
		"README.md": "",
	}
	for path, want := range tests {
		got, ok := registry.ForPath(path)
		if want == "" {
			if ok {
				t.Fatalf("ForPath(%q) = %q, want none", path, got.ID)
			}
			continue
		}
		if !ok || got.ID != want {
			t.Fatalf("ForPath(%q) = %q %v, want %q", path, got.ID, ok, want)
		}
	}
}

func TestRegistryRegisterOverridesByExactIDRefreshesExtensions(t *testing.T) {
	registry := NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}})

	if err := registry.Register(Language{ID: "go", Name: "Custom Go", Extensions: []string{".gox"}}); err != nil {
		t.Fatalf("Register override returned error: %v", err)
	}

	if _, ok := registry.ForPath("main.go"); ok {
		t.Fatalf("old .go extension still mapped after exact-ID override")
	}
	got, ok := registry.ForPath("main.gox")
	if !ok || got.ID != "go" || got.Name != "Custom Go" {
		t.Fatalf("ForPath(main.gox) = %#v %v, want Custom Go override", got, ok)
	}
	languages := registry.Languages()
	if len(languages) != 1 || languages[0].ID != "go" || len(languages[0].Extensions) != 1 || languages[0].Extensions[0] != ".gox" {
		t.Fatalf("Languages() = %#v, want refreshed go entry", languages)
	}
}

func TestRegistryRegisterRejectsExtensionCollision(t *testing.T) {
	registry := NewRegistry([]Language{{ID: "go", Name: "Go", Extensions: []string{".go"}}})

	err := registry.Register(Language{ID: "other", Name: "Other", Extensions: []string{".go"}})
	if !errors.Is(err, ErrExtensionAlreadyRegistered) {
		t.Fatalf("Register collision error = %v, want ErrExtensionAlreadyRegistered", err)
	}

	got, ok := registry.ForPath("main.go")
	if !ok || got.ID != "go" {
		t.Fatalf("collision changed owner: %#v %v", got, ok)
	}
}
