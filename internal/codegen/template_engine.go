// Package codegen implements the Handlebars-compatible template engine for the
// Knowns CLI. It processes .hbs template files and applies variable
// substitution with case-conversion helpers.
package codegen

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"

	"github.com/howznguyen/knowns/internal/models"
	"github.com/howznguyen/knowns/internal/safepath"
)

// Engine executes Knowns code-generation templates.
type Engine struct {
	// ProjectRoot is the absolute path to the project root (not the .knowns
	// directory — one level above it).
	ProjectRoot string
}

// NewEngine creates an Engine anchored to projectRoot.
func NewEngine(projectRoot string) *Engine {
	return &Engine{ProjectRoot: projectRoot}
}

// Run executes tmpl with the supplied vars.
//
// If dryRun is true the engine resolves all paths and renders all templates but
// does not write any files; the result lists what would have been created or
// modified.
func (e *Engine) Run(tmpl *models.Template, vars map[string]string, dryRun bool) (*models.TemplateResult, error) {
	result := &models.TemplateResult{
		Success:  true,
		Created:  []string{},
		Modified: []string{},
		Skipped:  []string{},
	}

	for _, action := range tmpl.Actions {
		if err := e.runAction(tmpl, action, vars, dryRun, result); err != nil {
			result.Success = false
			result.Error = err.Error()
			return result, err
		}
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

func (e *Engine) runAction(
	tmpl *models.Template,
	action models.TemplateAction,
	vars map[string]string,
	dryRun bool,
	result *models.TemplateResult,
) error {
	// Evaluate the optional `when` guard.
	if action.When != "" {
		ok, err := e.evalWhen(action.When, vars)
		if err != nil {
			return fmt.Errorf("when expression %q: %w", action.When, err)
		}
		if !ok {
			return nil
		}
	}

	switch action.Type {
	case "add":
		return e.runAdd(tmpl, action, vars, dryRun, result)
	case "addMany":
		return e.runAddMany(tmpl, action, vars, dryRun, result)
	case "modify":
		return e.runModify(tmpl, action, vars, dryRun, result)
	case "append":
		return e.runAppend(tmpl, action, vars, dryRun, result)
	default:
		return fmt.Errorf("unknown action type: %q", action.Type)
	}
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

func (e *Engine) runAdd(
	tmpl *models.Template,
	action models.TemplateAction,
	vars map[string]string,
	dryRun bool,
	result *models.TemplateResult,
) error {
	if action.Path == "" {
		return fmt.Errorf("add action requires a path")
	}

	// Render the destination path (it may contain Handlebars expressions).
	destPath, err := e.RenderString(action.Path, vars)
	if err != nil {
		return fmt.Errorf("render path %q: %w", action.Path, err)
	}

	// Resolve relative to project root (or template destination when set).
	destPath, err = e.resolveDest(tmpl, destPath)
	if err != nil {
		return fmt.Errorf("resolve destination path: %w", err)
	}

	if action.SkipIfExists {
		if _, err := os.Stat(destPath); err == nil {
			result.Skipped = append(result.Skipped, destPath)
			return nil
		}
	}

	content, err := e.loadAndRenderTemplate(tmpl, action.Template, vars)
	if err != nil {
		return err
	}

	if !dryRun {
		if err := writeFile(destPath, content); err != nil {
			return fmt.Errorf("write %s: %w", destPath, err)
		}
	}
	result.Created = append(result.Created, destPath)
	return nil
}

// ---------------------------------------------------------------------------
// addMany
// ---------------------------------------------------------------------------

func (e *Engine) runAddMany(
	tmpl *models.Template,
	action models.TemplateAction,
	vars map[string]string,
	dryRun bool,
	result *models.TemplateResult,
) error {
	sourceDir := tmpl.Path
	if action.Source != "" {
		var err error
		sourceDir, err = safepath.ResolveProject(tmpl.Path, action.Source)
		if err != nil {
			return fmt.Errorf("invalid source directory %q: %w", action.Source, err)
		}
	}

	globPat := action.GlobPattern
	if globPat == "" {
		globPat = "**/*.hbs"
	}

	// filepath.Glob does not support ** so we do a recursive walk instead.
	matches, err := globDir(sourceDir, globPat)
	if err != nil {
		return fmt.Errorf("glob %q: %w", globPat, err)
	}

	// Render destination base directory.
	destBase := action.Destination
	if destBase == "" {
		destBase = tmpl.Destination
	}
	destBase, err = e.RenderString(destBase, vars)
	if err != nil {
		return fmt.Errorf("render destination %q: %w", action.Destination, err)
	}
	destBase, err = safepath.ResolveProject(e.ProjectRoot, destBase)
	if err != nil {
		return fmt.Errorf("invalid destination base: %w", err)
	}

	for _, srcFile := range matches {
		// Relative path from sourceDir, strip .hbs extension.
		rel, err := filepath.Rel(sourceDir, srcFile)
		if err != nil {
			return err
		}
		// Render each path segment using vars.
		rel, err = e.RenderString(rel, vars)
		if err != nil {
			return fmt.Errorf("render file path %q: %w", rel, err)
		}
		// Strip .hbs suffix from destination file names.
		if strings.HasSuffix(rel, ".hbs") {
			rel = rel[:len(rel)-4]
		}

		destPath, err := safepath.ResolveProject(destBase, rel)
		if err != nil {
			return fmt.Errorf("resolve destination path %q: %w", rel, err)
		}

		if action.SkipIfExists {
			if _, err := os.Stat(destPath); err == nil {
				result.Skipped = append(result.Skipped, destPath)
				continue
			}
		}

		content, err := e.loadAndRenderTemplate(tmpl, srcFile, vars)
		if err != nil {
			return err
		}

		if !dryRun {
			if err := writeFile(destPath, content); err != nil {
				return fmt.Errorf("write %s: %w", destPath, err)
			}
		}
		result.Created = append(result.Created, destPath)
	}
	return nil
}

// ---------------------------------------------------------------------------
// modify
// ---------------------------------------------------------------------------

func (e *Engine) runModify(
	tmpl *models.Template,
	action models.TemplateAction,
	vars map[string]string,
	dryRun bool,
	result *models.TemplateResult,
) error {
	if action.Path == "" {
		return fmt.Errorf("modify action requires a path")
	}
	destPath, err := e.RenderString(action.Path, vars)
	if err != nil {
		return fmt.Errorf("render path %q: %w", action.Path, err)
	}
	destPath, err = e.resolveDest(tmpl, destPath)
	if err != nil {
		return fmt.Errorf("resolve destination path: %w", err)
	}

	existing, err := os.ReadFile(destPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", destPath, err)
	}

	replacement, err := e.loadAndRenderTemplate(tmpl, action.Template, vars)
	if err != nil {
		return err
	}

	re, err := regexp.Compile(action.Pattern)
	if err != nil {
		return fmt.Errorf("compile pattern %q: %w", action.Pattern, err)
	}

	modified := re.ReplaceAll(existing, []byte(replacement))

	if !dryRun {
		if err := writeFile(destPath, string(modified)); err != nil {
			return fmt.Errorf("write %s: %w", destPath, err)
		}
	}
	result.Modified = append(result.Modified, destPath)
	return nil
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

func (e *Engine) runAppend(
	tmpl *models.Template,
	action models.TemplateAction,
	vars map[string]string,
	dryRun bool,
	result *models.TemplateResult,
) error {
	if action.Path == "" {
		return fmt.Errorf("append action requires a path")
	}
	destPath, err := e.RenderString(action.Path, vars)
	if err != nil {
		return fmt.Errorf("render path %q: %w", action.Path, err)
	}
	destPath, err = e.resolveDest(tmpl, destPath)
	if err != nil {
		return fmt.Errorf("resolve destination path: %w", err)
	}

	content, err := e.loadAndRenderTemplate(tmpl, action.Template, vars)
	if err != nil {
		return err
	}

	// Read existing content (may not exist yet — that is fine).
	existing := ""
	if data, err := os.ReadFile(destPath); err == nil {
		existing = string(data)
	}

	if action.Unique && strings.Contains(existing, content) {
		result.Skipped = append(result.Skipped, destPath)
		return nil
	}

	separator := action.Separator
	if separator == "" {
		separator = "\n"
	}

	var final string
	if existing == "" {
		final = content
	} else {
		final = existing + separator + content
	}

	if !dryRun {
		if err := writeFile(destPath, final); err != nil {
			return fmt.Errorf("write %s: %w", destPath, err)
		}
	}
	result.Modified = append(result.Modified, destPath)
	return nil
}

// ---------------------------------------------------------------------------
// Template loading and rendering
// ---------------------------------------------------------------------------

// loadAndRenderTemplate loads the .hbs source (from a path relative to the
// template folder, or from an inline string) and renders it with vars.
func (e *Engine) loadAndRenderTemplate(tmpl *models.Template, src string, vars map[string]string) (string, error) {
	if src == "" {
		return "", nil
	}

	var raw string

	// If src ends in .hbs (or contains a path separator) treat it as a file.
	if strings.HasSuffix(src, ".hbs") || strings.ContainsAny(src, "/\\") {
		// Paths starting with tmpl.Path are already absolute (addMany passes
		// absolute paths).  Otherwise treat as relative to the template folder.
		baseDir := ""
		if tmpl != nil && tmpl.Path != "" {
			baseDir = tmpl.Path
		} else {
			baseDir = e.ProjectRoot
		}
		srcPath, err := safepath.ResolveProject(baseDir, src)
		if err != nil {
			return "", fmt.Errorf("invalid template file path %q: %w", src, err)
		}
		data, err := os.ReadFile(srcPath)
		if err != nil {
			return "", fmt.Errorf("read template file %s: %w", srcPath, err)
		}
		raw = string(data)
	} else {
		// Inline template string.
		raw = src
	}

	return e.RenderString(raw, vars)
}

// ValidateTemplate preprocesses a Handlebars template and checks that it
// parses correctly as a Go text/template. Returns the preprocessed Go template
// string, or an error if parsing fails.
func (e *Engine) ValidateTemplate(hbs string) (string, error) {
	goTpl := preprocessHandlebars(hbs)
	funcMap := buildFuncMap()
	_, err := template.New("").Funcs(funcMap).Parse(goTpl)
	if err != nil {
		return "", err
	}
	return goTpl, nil
}

// RenderString preprocesses a Handlebars template string and executes it
// using Go's text/template with vars as the data.
func (e *Engine) RenderString(hbs string, vars map[string]string) (string, error) {
	goTpl := preprocessHandlebars(hbs)

	funcMap := buildFuncMap()
	t, err := template.New("").Funcs(funcMap).Parse(goTpl)
	if err != nil {
		return "", fmt.Errorf("parse template: %w (source: %q)", err, hbs)
	}

	// Build a string-keyed data map, converting boolean strings to real bools
	// so that {{if var}} works correctly for "false"/"true" values.
	data := make(map[string]interface{}, len(vars))
	for k, v := range vars {
		switch strings.ToLower(v) {
		case "true":
			data[k] = true
		case "false":
			data[k] = false
		default:
			data[k] = v
		}
	}

	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("execute template: %w", err)
	}
	return buf.String(), nil
}

// evalWhen renders the when expression and returns true if the result is
// truthy (non-empty, not "false", not "0").
func (e *Engine) evalWhen(when string, vars map[string]string) (bool, error) {
	// Strip Handlebars braces if present: "{{varName}}" → "varName"
	expr := strings.TrimSpace(when)
	if strings.HasPrefix(expr, "{{") && strings.HasSuffix(expr, "}}") {
		expr = strings.TrimSpace(expr[2 : len(expr)-2])
	}

	processed := preprocessHBSExpr(expr)
	// Wrap multi-token expressions in parens for use with {{if}}.
	if strings.Contains(processed, " ") {
		processed = "(" + processed + ")"
	}

	result, err := e.RenderString("{{if "+processed+"}}true{{else}}false{{end}}", vars)
	if err != nil {
		// Fall back: try rendering the expression as a plain string.
		val, err2 := e.RenderString(when, vars)
		if err2 != nil {
			return false, err
		}
		return isTruthy(val), nil
	}
	return result == "true", nil
}

// isTruthy returns true for non-empty strings that are not "false" or "0".
func isTruthy(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && s != "false" && s != "0"
}

// ---------------------------------------------------------------------------
// Handlebars → Go template preprocessing
// ---------------------------------------------------------------------------

// Regexes used for Handlebars → Go template conversion.
var (
	// Triple-brace raw output: {{{expr}}} → {{expr}} (no HTML escaping needed
	// in text/template, but strip the extra brace).
	reTriple = regexp.MustCompile(`\{\{\{([^}]+)\}\}\}`)

	// {{#if cond}} → {{if .cond}}
	reIfOpen = regexp.MustCompile(`\{\{#if\s+([^}]+)\}\}`)
	// {{#unless cond}} → {{if not .cond}}
	reUnless = regexp.MustCompile(`\{\{#unless\s+([^}]+)\}\}`)
	// {{/if}} / {{/unless}} → {{end}}
	reIfClose = regexp.MustCompile(`\{\{/(if|unless)\}\}`)

	// {{#each items}} → {{range .items}}
	reEachOpen = regexp.MustCompile(`\{\{#each\s+([^}]+)\}\}`)
	// {{/each}} → {{end}}
	reEachClose = regexp.MustCompile(`\{\{/each\}\}`)

	// {{#with obj}} → {{with .obj}}
	reWithOpen = regexp.MustCompile(`\{\{#with\s+([^}]+)\}\}`)
	// {{/with}} → {{end}}
	reWithClose = regexp.MustCompile(`\{\{/with\}\}`)

	// {{helper arg1 arg2 ...}} — matches a known helper name followed by args.
	// Must be checked before the plain variable rule.
	reHelper = regexp.MustCompile(`\{\{(\w+)\s+([^}]+)\}\}`)

	// {{varName}} — bare variable reference.
	reVar = regexp.MustCompile(`\{\{([^#/!][^}]*)\}\}`)
)

// knownHelpers is the set of case-conversion helper names we register.
var knownHelpers = map[string]bool{
	"camelCase":  true,
	"pascalCase": true,
	"kebabCase":  true,
	"snakeCase":  true,
	"upperCase":  true,
	"lowerCase":  true,
	"startCase":  true,
}

// preprocessHandlebars converts a Handlebars template string to a Go
// text/template string.
func preprocessHandlebars(hbs string) string {
	s := hbs

	// 1. Triple-brace raw: {{{expr}}} → {{expr}}
	s = reTriple.ReplaceAllStringFunc(s, func(m string) string {
		inner := reTriple.FindStringSubmatch(m)[1]
		return "{{" + preprocessHBSExpr(strings.TrimSpace(inner)) + "}}"
	})

	// 2. Block helpers.
	s = reIfOpen.ReplaceAllStringFunc(s, func(m string) string {
		cond := strings.TrimSpace(reIfOpen.FindStringSubmatch(m)[1])
		return "{{if " + preprocessHBSExpr(cond) + "}}"
	})
	s = reUnless.ReplaceAllStringFunc(s, func(m string) string {
		cond := strings.TrimSpace(reUnless.FindStringSubmatch(m)[1])
		expr := preprocessHBSExpr(cond)
		// Wrap in parens if multi-token so `not` receives a single argument.
		if strings.Contains(expr, " ") {
			expr = "(" + expr + ")"
		}
		return "{{if not " + expr + "}}"
	})
	s = reIfClose.ReplaceAllString(s, "{{end}}")

	s = reEachOpen.ReplaceAllStringFunc(s, func(m string) string {
		iter := strings.TrimSpace(reEachOpen.FindStringSubmatch(m)[1])
		return "{{range " + preprocessHBSExpr(iter) + "}}"
	})
	s = reEachClose.ReplaceAllString(s, "{{end}}")

	s = reWithOpen.ReplaceAllStringFunc(s, func(m string) string {
		obj := strings.TrimSpace(reWithOpen.FindStringSubmatch(m)[1])
		return "{{with " + preprocessHBSExpr(obj) + "}}"
	})
	s = reWithClose.ReplaceAllString(s, "{{end}}")

	// 3. {{comment}} — strip Handlebars comments {{! ... }}
	s = regexp.MustCompile(`\{\{!--[\s\S]*?--\}\}`).ReplaceAllString(s, "")
	s = regexp.MustCompile(`\{\{![^}]*\}\}`).ReplaceAllString(s, "")

	// 4. Helper calls: {{helperName arg}} → {{helperName (index . "arg")}}
	s = reHelper.ReplaceAllStringFunc(s, func(m string) string {
		parts := reHelper.FindStringSubmatch(m)
		helperName := parts[1]
		argsRaw := strings.TrimSpace(parts[2])
		if !knownHelpers[helperName] {
			// Not a known helper; treat as a Go template expression as-is.
			return m
		}
		// Preprocess each argument, wrapping multi-token expressions in parens
		// so they are treated as a single argument by Go's text/template.
		args := strings.Fields(argsRaw)
		processed := make([]string, len(args))
		for i, a := range args {
			expr := preprocessHBSExpr(a)
			// If the expression contains spaces (e.g. `index . "name"`),
			// wrap in parens so Go template treats it as one argument.
			if strings.Contains(expr, " ") {
				expr = "(" + expr + ")"
			}
			processed[i] = expr
		}
		return "{{" + helperName + " " + strings.Join(processed, " ") + "}}"
	})

	// 5. Bare variable: {{varName}} → {{index . "varName"}} (safe map lookup)
	s = reVar.ReplaceAllStringFunc(s, func(m string) string {
		inner := strings.TrimSpace(reVar.FindStringSubmatch(m)[1])
		// Already a Go template expression (starts with . or is a func call)?
		if strings.HasPrefix(inner, ".") || strings.ContainsAny(inner, " \t") {
			return "{{" + inner + "}}"
		}
		// Go template keywords — leave as-is.
		switch inner {
		case "else", "end", "if", "range", "with", "block", "define", "template", "break", "continue":
			return m
		}
		// Plain identifier — look it up in the map data.
		return `{{index . "` + inner + `"}}`
	})

	return s
}

// preprocessHBSExpr converts a single Handlebars expression token into the
// equivalent Go template expression.
//
// Examples:
//
//	"name"         → `index . "name"`
//	"camelCase"    → "camelCase"  (helper function ref, left as-is)
func preprocessHBSExpr(expr string) string {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return expr
	}
	// Already a Go template expression.
	if strings.HasPrefix(expr, ".") || strings.HasPrefix(expr, "$") {
		return expr
	}
	// Boolean/nil literals.
	switch expr {
	case "true", "false", "nil":
		return expr
	}
	// Numeric literal.
	if len(expr) > 0 && (expr[0] >= '0' && expr[0] <= '9') {
		return expr
	}
	// Known helper names are Go functions — leave them unquoted.
	if knownHelpers[expr] {
		return expr
	}
	// Everything else is a variable lookup in the data map.
	return `index . "` + expr + `"`
}

// ---------------------------------------------------------------------------
// Template function map
// ---------------------------------------------------------------------------

func buildFuncMap() template.FuncMap {
	return template.FuncMap{
		"camelCase":  CamelCase,
		"pascalCase": PascalCase,
		"kebabCase":  KebabCase,
		"snakeCase":  SnakeCase,
		"upperCase":  UpperCase,
		"lowerCase":  LowerCase,
		"startCase":  StartCase,
		// Provide a `not` helper for {{#unless}} translation.
		"not": func(v interface{}) bool {
			if v == nil {
				return true
			}
			switch val := v.(type) {
			case bool:
				return !val
			case string:
				return val == "" || val == "false" || val == "0"
			case int, int64, float64:
				return fmt.Sprintf("%v", val) == "0"
			}
			return false
		},
	}
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

// resolveDest resolves a destination path against the project root, taking
// the template's optional Destination prefix into account. It guarantees
// that the returned path is contained within the project root.
func (e *Engine) resolveDest(tmpl *models.Template, dest string) (string, error) {
	if filepath.IsAbs(dest) {
		return safepath.ResolveProject(e.ProjectRoot, dest)
	}
	target := dest
	if tmpl != nil && tmpl.Destination != "" {
		target = filepath.Join(tmpl.Destination, dest)
	}
	return safepath.ResolveProject(e.ProjectRoot, target)
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

// writeFile writes content to path, creating parent directories as needed.
func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0644)
}

// globDir returns all files under root that match the glob pattern.
// The pattern supports "**" to match any number of path segments.
func globDir(root, pattern string) ([]string, error) {
	var matches []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		matched, err := matchGlob(pattern, rel)
		if err != nil {
			return err
		}
		if matched {
			matches = append(matches, path)
		}
		return nil
	})
	return matches, err
}

// matchGlob checks whether name matches a glob pattern that may contain "**".
func matchGlob(pattern, name string) (bool, error) {
	// Normalise separators for matching.
	pattern = filepath.ToSlash(pattern)
	name = filepath.ToSlash(name)

	// Split on "**" and match each segment independently.
	if !strings.Contains(pattern, "**") {
		return filepath.Match(filepath.FromSlash(pattern), filepath.FromSlash(name))
	}

	parts := strings.SplitN(pattern, "**", 2)
	prefix := parts[0]
	suffix := parts[1]

	// Strip leading separator from suffix.
	suffix = strings.TrimPrefix(suffix, "/")

	if prefix != "" {
		if !strings.HasPrefix(name, prefix) {
			return false, nil
		}
		name = name[len(prefix):]
	}

	if suffix == "" {
		return true, nil
	}
	// The remaining name must match the suffix (which may itself be a glob).
	// Try matching the suffix against any trailing portion of name.
	segments := strings.Split(name, "/")
	for i := range segments {
		candidate := strings.Join(segments[i:], "/")
		ok, err := filepath.Match(filepath.FromSlash(suffix), filepath.FromSlash(candidate))
		if err != nil {
			return false, err
		}
		if ok {
			return true, nil
		}
	}
	return false, nil
}
