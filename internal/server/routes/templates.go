package routes

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/safepath"
	"github.com/howznguyen/knowns/internal/storage"
)

// Case conversion helpers for template variable substitution.

func toSnakeCase(s string) string {
	var result []byte
	for i, c := range s {
		if c >= 'A' && c <= 'Z' {
			if i > 0 {
				result = append(result, '_')
			}
			result = append(result, byte(c+32))
		} else if c == '-' || c == ' ' {
			result = append(result, '_')
		} else {
			result = append(result, byte(c))
		}
	}
	return string(result)
}

func toKebabCase(s string) string {
	var result []byte
	for i, c := range s {
		if c >= 'A' && c <= 'Z' {
			if i > 0 {
				result = append(result, '-')
			}
			result = append(result, byte(c+32))
		} else if c == '_' || c == ' ' {
			result = append(result, '-')
		} else {
			result = append(result, byte(c))
		}
	}
	return string(result)
}

func toCamelCase(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == '-' || r == '_' || r == ' '
	})
	for i, p := range parts {
		if i == 0 {
			parts[i] = strings.ToLower(p)
		} else {
			parts[i] = strings.ToUpper(p[:1]) + strings.ToLower(p[1:])
		}
	}
	return strings.Join(parts, "")
}

func toPascalCase(s string) string {
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == '-' || r == '_' || r == ' '
	})
	for i, p := range parts {
		parts[i] = strings.ToUpper(p[:1]) + strings.ToLower(p[1:])
	}
	return strings.Join(parts, "")
}

// TemplateRoutes handles /api/templates endpoints.
type TemplateRoutes struct {
	store *storage.Store
	mgr   *storage.Manager
	sse   Broadcaster
}

func (tr *TemplateRoutes) getStore() *storage.Store {
	if tr.mgr != nil {
		return tr.mgr.GetStore()
	}
	return tr.store
}

// Register wires the template routes onto r.
func (tr *TemplateRoutes) Register(r chi.Router) {
	r.Get("/templates", tr.list)
	r.Post("/templates", tr.create)
	r.Post("/templates/preview", tr.preview)
	r.Get("/templates/{name}", tr.get)
	r.Post("/templates/{name}/run", tr.run)
}

// templateListItem is the UI-friendly shape for template list items.
type templateListItem struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Doc         string `json:"doc,omitempty"`
	PromptCount int    `json:"promptCount"`
	FileCount   int    `json:"fileCount"`
	IsImported  bool   `json:"isImported,omitempty"`
	Source      string `json:"source,omitempty"`
}

// templateFile is the UI-friendly shape for template actions/files.
type templateFile struct {
	Type         string `json:"type"`
	Template     string `json:"template,omitempty"`
	Destination  string `json:"destination,omitempty"`
	Path         string `json:"path,omitempty"`
	Source       string `json:"source,omitempty"`
	GlobPattern  string `json:"globPattern,omitempty"`
	SkipIfExists bool   `json:"skipIfExists,omitempty"`
	When         string `json:"when,omitempty"`
}

// uiPrompt is the UI-friendly shape for template prompts.
type uiPrompt struct {
	Name     string           `json:"name"`
	Message  string           `json:"message"`
	Type     string           `json:"type"`
	Required bool             `json:"required"`
	Default  string           `json:"default,omitempty"`
	Choices  []uiPromptChoice `json:"choices,omitempty"`
}

type uiPromptChoice struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

func toUIPrompts(prompts []models.TemplatePrompt) []uiPrompt {
	result := make([]uiPrompt, len(prompts))
	for i, p := range prompts {
		var choices []uiPromptChoice
		for _, c := range p.Choices {
			choices = append(choices, uiPromptChoice{Value: c.Value, Label: c.Title})
		}
		result[i] = uiPrompt{
			Name:     p.Name,
			Message:  p.Message,
			Type:     p.Type,
			Required: p.Validate == "required",
			Default:  p.Initial,
			Choices:  choices,
		}
	}
	return result
}

func toTemplateFiles(actions []models.TemplateAction) []templateFile {
	files := make([]templateFile, len(actions))
	for i, a := range actions {
		files[i] = templateFile{
			Type:         a.Type,
			Template:     a.Template,
			Destination:  a.Path,
			Path:         a.Path,
			Source:       a.Source,
			GlobPattern:  a.GlobPattern,
			SkipIfExists: a.SkipIfExists,
			When:         a.When,
		}
	}
	return files
}

// list returns all available templates.
//
// GET /api/templates
func (tr *TemplateRoutes) list(w http.ResponseWriter, r *http.Request) {
	templates, err := tr.getStore().Templates.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if templates == nil {
		templates = []*models.Template{}
	}
	items := make([]templateListItem, len(templates))
	for i, t := range templates {
		items[i] = templateListItem{
			Name:        t.Name,
			Description: t.Description,
			Doc:         t.Doc,
			PromptCount: len(t.Prompts),
			FileCount:   len(t.Actions),
			IsImported:  t.IsImported,
			Source:      t.ImportName,
		}
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"templates": items,
		"count":     len(items),
	})
}

// get retrieves a single template by name.
//
// GET /api/templates/{name}
func (tr *TemplateRoutes) get(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	tmpl, err := tr.getStore().Templates.Get(name)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	uiPrompts := toUIPrompts(tmpl.Prompts)
	if uiPrompts == nil {
		uiPrompts = []uiPrompt{}
	}
	files := toTemplateFiles(tmpl.Actions)
	if files == nil {
		files = []templateFile{}
	}
	detail := map[string]interface{}{
		"name":        tmpl.Name,
		"description": tmpl.Description,
		"doc":         tmpl.Doc,
		"destination": tmpl.Destination,
		"prompts":     uiPrompts,
		"files":       files,
	}
	if tmpl.Messages != nil {
		detail["messages"] = tmpl.Messages
	}
	respondJSON(w, http.StatusOK, map[string]interface{}{
		"template": detail,
	})
}

// createTemplateRequest is the body for POST /api/templates.
type createTemplateRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// create scaffolds a new template directory.
//
// POST /api/templates
func (tr *TemplateRoutes) create(w http.ResponseWriter, r *http.Request) {
	var req createTemplateRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if req.Name == "" {
		respondError(w, http.StatusBadRequest, "name is required")
		return
	}

	if err := tr.getStore().Templates.Create(req.Name, req.Description); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	tmpl, err := tr.getStore().Templates.Get(req.Name)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	tr.sse.Broadcast(SSEEvent{Type: "templates:created", Data: map[string]string{"name": req.Name}})
	respondJSON(w, http.StatusCreated, tmpl)
}

// previewTemplateRequest is the body for POST /api/templates/preview.
type previewTemplateRequest struct {
	Name         string            `json:"name"`
	Variables    map[string]string `json:"variables"`
	TemplateFile string            `json:"templateFile"`
}

// previewFileResult is a single file preview entry.
type previewFileResult struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// preview renders a template file with variables without writing to disk.
//
// POST /api/templates/preview
func (tr *TemplateRoutes) preview(w http.ResponseWriter, r *http.Request) {
	var req previewTemplateRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	tmpl, err := tr.getStore().Templates.Get(req.Name)
	if err != nil {
		respondError(w, http.StatusNotFound, "template not found: "+err.Error())
		return
	}

	templateFile := req.TemplateFile
	if templateFile == "" {
		templateFile = "main.hbs"
	}

	hbsPath, err := safepath.Resolve(tmpl.Path, templateFile)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid template file path")
		return
	}
	hbsContent, err := os.ReadFile(hbsPath)
	if err != nil {
		respondError(w, http.StatusNotFound, "template file not found: "+templateFile)
		return
	}

	// Simple variable replacement: {{varName}} → value
	rendered := string(hbsContent)
	if req.Variables != nil {
		for k, v := range req.Variables {
			rendered = strings.ReplaceAll(rendered, "{{"+k+"}}", v)
		}
	}

	// Compute destination path from template actions if available.
	destPath := templateFile
	for _, action := range tmpl.Actions {
		if action.Template == templateFile && action.Path != "" {
			destPath = action.Path
			if req.Variables != nil {
				for k, v := range req.Variables {
					destPath = strings.ReplaceAll(destPath, "{{"+k+"}}", v)
					// Also handle helpers like {{kebabCase name}} as simple replacement
					destPath = strings.ReplaceAll(destPath, "{{kebabCase "+k+"}}", v)
					destPath = strings.ReplaceAll(destPath, "{{camelCase "+k+"}}", v)
					destPath = strings.ReplaceAll(destPath, "{{pascalCase "+k+"}}", v)
				}
			}
			if tmpl.Destination != "" {
				destPath = filepath.Join(tmpl.Destination, destPath)
			}
			break
		}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"files": []previewFileResult{
			{Path: destPath, Content: rendered},
		},
	})
}

// runTemplateRequest is the body for POST /api/templates/{name}/run.
type runTemplateRequest struct {
	Variables map[string]string `json:"variables"`
	DryRun    bool              `json:"dryRun"`
}

// run executes a template with the supplied variables.
// This is a stub; full Handlebars execution lives in the codegen package.
//
// POST /api/templates/{name}/run
func (tr *TemplateRoutes) run(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")

	var req runTemplateRequest
	if err := decodeJSON(r, &req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}

	tmpl, err := tr.getStore().Templates.Get(name)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	// Build file list from template actions with variable substitution
	type runFileResult struct {
		Path       string `json:"path"`
		Action     string `json:"action"`
		Skipped    bool   `json:"skipped,omitempty"`
		SkipReason string `json:"skipReason,omitempty"`
	}

	var files []runFileResult
	for _, action := range tmpl.Actions {
		path := action.Path
		// Substitute variables in path
		if req.Variables != nil {
			for k, v := range req.Variables {
				path = strings.ReplaceAll(path, "{{"+k+"}}", v)
				path = strings.ReplaceAll(path, "{{snakeCase "+k+"}}", toSnakeCase(v))
				path = strings.ReplaceAll(path, "{{kebabCase "+k+"}}", toKebabCase(v))
				path = strings.ReplaceAll(path, "{{camelCase "+k+"}}", toCamelCase(v))
				path = strings.ReplaceAll(path, "{{pascalCase "+k+"}}", toPascalCase(v))
			}
		}
		if tmpl.Destination != "" {
			path = filepath.Join(tmpl.Destination, path)
		}

		skipped := false
		skipReason := ""
		if action.SkipIfExists && !req.DryRun {
			projectRoot := filepath.Dir(tr.getStore().Root)
			if _, statErr := os.Stat(filepath.Join(projectRoot, path)); statErr == nil {
				skipped = true
				skipReason = "file exists"
			}
		}

		files = append(files, runFileResult{
			Path:       path,
			Action:     action.Type,
			Skipped:    skipped,
			SkipReason: skipReason,
		})
	}
	if files == nil {
		files = []runFileResult{}
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"dryRun":    req.DryRun,
		"template":  name,
		"variables": req.Variables,
		"files":     files,
		"message":   "Template executed successfully",
	})
}
