package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/safepath"
	"gopkg.in/yaml.v3"
)

// TemplateStore reads templates from .knowns/templates/ and .knowns/imports/*/templates/.
type TemplateStore struct {
	root string
}

func (ts *TemplateStore) templatesDir() string { return filepath.Join(ts.root, "templates") }
func (ts *TemplateStore) importsDir() string   { return filepath.Join(ts.root, "imports") }

// templateYAML is the raw parsed form of _template.yaml, using the exact field
// structure that matches the TypeScript _template.yaml format.
type templateYAML struct {
	Name        string                   `yaml:"name"`
	Description string                   `yaml:"description"`
	Version     string                   `yaml:"version"`
	Author      string                   `yaml:"author"`
	Doc         string                   `yaml:"doc"`
	Destination string                   `yaml:"destination"`
	Prompts     []models.TemplatePrompt  `yaml:"prompts"`
	Actions     []models.TemplateAction  `yaml:"actions"`
	Messages    *models.TemplateMessages `yaml:"messages"`
}

// List returns all templates (local + imported).
func (ts *TemplateStore) List() ([]*models.Template, error) {
	var templates []*models.Template

	local, err := ts.listDir(ts.templatesDir(), false, "")
	if err != nil {
		return nil, err
	}
	templates = append(templates, local...)

	imported, err := ts.listImported()
	if err != nil {
		// Non-fatal: return what we have.
		return templates, nil
	}
	templates = append(templates, imported...)

	return templates, nil
}

func (ts *TemplateStore) listDir(dir string, imported bool, importName string) ([]*models.Template, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list templates %s: %w", dir, err)
	}
	var templates []*models.Template
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		templateDir := filepath.Join(dir, e.Name())
		configPath := filepath.Join(templateDir, "_template.yaml")
		if _, err := os.Stat(configPath); err != nil {
			continue
		}
		tmpl, err := ts.parseTemplate(e.Name(), templateDir, imported, importName)
		if err != nil {
			continue
		}
		templates = append(templates, tmpl)
	}
	return templates, nil
}

func (ts *TemplateStore) listImported() ([]*models.Template, error) {
	entries, err := os.ReadDir(ts.importsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var templates []*models.Template
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		importName := e.Name()
		importTemplatesDir := filepath.Join(ts.importsDir(), importName, "templates")
		imported, err := ts.listDir(importTemplatesDir, true, importName)
		if err != nil {
			continue
		}
		templates = append(templates, imported...)
	}
	return templates, nil
}

// Get returns a single template by name.
// An import-prefixed name like "importName/templateName" is supported.
func (ts *TemplateStore) Get(name string) (*models.Template, error) {
	if idx := strings.Index(name, "/"); idx != -1 {
		importName := name[:idx]
		templateName := name[idx+1:]
		importDir, err := safepath.Resolve(ts.importsDir(), importName)
		if err != nil {
			return nil, fmt.Errorf("invalid import template name: %w", err)
		}
		templateDir, err := safepath.Resolve(filepath.Join(importDir, "templates"), templateName)
		if err != nil {
			return nil, fmt.Errorf("invalid import template name: %w", err)
		}
		return ts.parseTemplate(templateName, templateDir, true, importName)
	}
	templateDir, err := safepath.Resolve(ts.templatesDir(), name)
	if err != nil {
		return nil, fmt.Errorf("invalid template name: %w", err)
	}
	return ts.parseTemplate(name, templateDir, false, "")
}

// parseTemplate reads and parses a _template.yaml file.
func (ts *TemplateStore) parseTemplate(name, dir string, imported bool, importName string) (*models.Template, error) {
	configPath := filepath.Join(dir, "_template.yaml")
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("read template %s: %w", name, err)
	}

	raw := string(data)

	// The first line may be a YAML comment with the template title
	// (e.g., "# Template: knowns-command").  Strip it before parsing YAML.
	lines := strings.SplitN(raw, "\n", 3)
	if len(lines) > 0 && strings.HasPrefix(lines[0], "# ") {
		if len(lines) > 1 {
			raw = strings.Join(lines[1:], "\n")
		} else {
			raw = ""
		}
	}

	var ty templateYAML
	if err := yaml.Unmarshal([]byte(raw), &ty); err != nil {
		return nil, fmt.Errorf("parse template %s: %w", name, err)
	}

	// Use the yaml `name` field if set, otherwise use the directory name.
	tmplName := name
	if ty.Name != "" {
		tmplName = ty.Name
	}

	tmpl := &models.Template{
		Name:        tmplName,
		Description: ty.Description,
		Version:     ty.Version,
		Author:      ty.Author,
		Doc:         ty.Doc,
		Destination: ty.Destination,
		Prompts:     ty.Prompts,
		Actions:     ty.Actions,
		Messages:    ty.Messages,
		Path:        dir,
		IsImported:  imported,
		ImportName:  importName,
	}
	return tmpl, nil
}

// Create scaffolds a new template directory with a _template.yaml and a
// starter .hbs file.
func (ts *TemplateStore) Create(name string, description string) error {
	templateDir, err := safepath.Resolve(ts.templatesDir(), name)
	if err != nil {
		return fmt.Errorf("invalid template name: %w", err)
	}
	if err := os.MkdirAll(templateDir, 0755); err != nil {
		return fmt.Errorf("create template dir: %w", err)
	}

	configPath := filepath.Join(templateDir, "_template.yaml")
	if _, err := os.Stat(configPath); err == nil {
		return fmt.Errorf("template %q already exists", name)
	}

	configContent := fmt.Sprintf(`# Template: %s
name: %s
description: %s
version: 1.0.0

# Link to documentation (optional)
doc: ""

# Base destination path relative to project root
destination: src

# Interactive prompts
prompts:
  - name: name
    type: text
    message: "Name?"
    validate: required

# File generation actions
actions:
  - type: add
    template: "main.hbs"
    path: "{{kebabCase name}}.ts"
    skipIfExists: true

# Success/failure messages
messages:
  success: |
    Created: {{name}}
`, name, name, description)

	if err := atomicWrite(configPath, []byte(configContent)); err != nil {
		return fmt.Errorf("write _template.yaml: %w", err)
	}

	// Create a starter Handlebars template.
	hbsContent := "// Generated: {{name}}\n// Created by Knowns template: " + name + "\n"
	return atomicWrite(filepath.Join(templateDir, "main.hbs"), []byte(hbsContent))
}
