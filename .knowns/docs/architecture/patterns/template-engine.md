---
id: doc-9adc5d5e39eee2b19068a133bf14c4f8
title: Template Engine Architecture
description: Internal architecture of the template engine for developers
createdAt: '2026-01-25T09:48:44.135Z'
updatedAt: '2026-04-24T14:50:54.883Z'
tags: []
---

## Overview

Template Engine is the core module that handles code generation in Knowns. It uses Go's built-in `text/template` package. This document describes the internal architecture for developers.

**Related:**
- @doc/templates/overview - User-facing overview
- @doc/templates/config - Config format

---
## Architecture Diagram

```
internal/codegen/
├── template_engine.go     # Core engine: parsing, rendering, execution
├── helpers.go             # Built-in template functions (FuncMap)
├── skill_sync.go          # Multi-platform skill sync
```

Supporting storage:

```
internal/storage/
└── template_store.go      # Template CRUD, listing, discovery
```

---
## Execution Flow

```
1. User runs:   knowns template run my-template --name UserProfile
                    |
2. Load:        template_engine.go -> load _template.yaml + discover .tmpl files
                    |
3. Validate:    Validate config against expected structure
                    |
4. Prompt:      Collect variable values (skip if pre-filled via --var flags)
                    |
5. Process:     For each action:
                  a. Evaluate "when" condition
                  b. Render paths with template context
                  c. Render template content via text/template
                  d. Write/modify files
                    |
6. Report:      Return TemplateResult (created, modified, skipped, errors)
```

---
## Core Modules

### 1. Types (in `template_engine.go`)

Defines Go structs for template configuration:

```go
// TemplateConfig represents the parsed _template.yaml file.
type TemplateConfig struct {
    Name        string           `yaml:"name"`
    Description string           `yaml:"description,omitempty"`
    Version     string           `yaml:"version,omitempty"`
    Destination string           `yaml:"destination,omitempty"`
    Doc         string           `yaml:"doc,omitempty"`
    Prompts     []TemplatePrompt `yaml:"prompts,omitempty"`
    Actions     []TemplateAction `yaml:"actions"`
    Messages    *TemplateMessages `yaml:"messages,omitempty"`
}

// TemplatePrompt defines a variable to collect from the user.
type TemplatePrompt struct {
    Name     string         `yaml:"name"`
    Type     string         `yaml:"type"` // text, confirm, select, number
    Message  string         `yaml:"message"`
    Initial  interface{}    `yaml:"initial,omitempty"`
    Validate string         `yaml:"validate,omitempty"`
    When     string         `yaml:"when,omitempty"`
    Choices  []PromptChoice `yaml:"choices,omitempty"`
}

// TemplateAction defines a file operation (add, addMany, modify, append).
type TemplateAction struct {
    Type         string `yaml:"type"`
    Template     string `yaml:"template,omitempty"`
    Path         string `yaml:"path,omitempty"`
    Source       string `yaml:"source,omitempty"`
    Destination  string `yaml:"destination,omitempty"`
    Pattern      string `yaml:"pattern,omitempty"`
    When         string `yaml:"when,omitempty"`
    SkipIfExists bool   `yaml:"skipIfExists,omitempty"`
}
```

### 2. Config Validation

Validation is done at parse time:

```go
// validateConfig checks the template config for required fields and valid values.
func validateConfig(config *TemplateConfig) error {
    if config.Name == "" {
        return fmt.Errorf("template name is required")
    }
    if len(config.Actions) == 0 {
        return fmt.Errorf("at least one action is required")
    }
    for i, action := range config.Actions {
        if err := validateAction(action); err != nil {
            return fmt.Errorf("action %d: %w", i, err)
        }
    }
    return nil
}
```

### 3. Parser (in `template_engine.go`)

Loads and discovers template files:

```go
// LoadTemplate loads a template from a directory containing _template.yaml.
func LoadTemplate(dir string) (*TemplateConfig, error) {
    configPath := filepath.Join(dir, "_template.yaml")
    data, err := os.ReadFile(configPath)
    if err != nil {
        return nil, fmt.Errorf("read template config: %w", err)
    }

    var config TemplateConfig
    if err := yaml.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("parse template config: %w", err)
    }

    if err := validateConfig(&config); err != nil {
        return nil, fmt.Errorf("invalid template: %w", err)
    }

    return &config, nil
}
```

### 4. Renderer (in `template_engine.go`)

Uses Go's `text/template` with custom FuncMap:

```go
import "text/template"

// renderString renders a template string with the given context.
func renderString(tmplStr string, context map[string]interface{}) (string, error) {
    tmpl, err := template.New("").Funcs(defaultFuncMap()).Parse(tmplStr)
    if err != nil {
        return "", fmt.Errorf("parse template: %w", err)
    }

    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, context); err != nil {
        return "", fmt.Errorf("execute template: %w", err)
    }
    return buf.String(), nil
}

// renderFile renders a .tmpl file with the given context.
func renderFile(templatePath string, context map[string]interface{}) (string, error) {
    data, err := os.ReadFile(templatePath)
    if err != nil {
        return "", err
    }
    return renderString(string(data), context)
}
```

### 5. Runner (in `template_engine.go`)

Main orchestration -- the entry point:

```go
// RunTemplate executes a template with the given options.
func RunTemplate(config *TemplateConfig, opts RunOptions) (*TemplateResult, error) {
    result := &TemplateResult{}

    for _, action := range config.Actions {
        // Evaluate "when" condition
        if action.When != "" && !evaluateCondition(action.When, opts.Values) {
            continue
        }

        switch action.Type {
        case "add":
            err := executeAddAction(action, opts, result)
        case "addMany":
            err := executeAddManyAction(action, opts, result)
        case "modify":
            err := executeModifyAction(action, opts, result)
        case "append":
            err := executeAppendAction(action, opts, result)
        }
    }

    return result, nil
}

// RunOptions configures template execution.
type RunOptions struct {
    ProjectRoot string
    Values      map[string]interface{} // Pre-filled prompt values
    DryRun      bool                    // Preview only
    Force       bool                    // Overwrite existing
    Silent      bool                    // Suppress output
}

// TemplateResult reports what happened during template execution.
type TemplateResult struct {
    Success  bool     // Overall success
    Created  []string // Files created
    Modified []string // Files modified
    Skipped  []string // Files skipped
    Errors   []string // Error messages
}
```

---
## Design Patterns

### 1. FuncMap Pattern (text/template)

```go
// defaultFuncMap returns the template function map with all built-in helpers.
func defaultFuncMap() template.FuncMap {
    return template.FuncMap{
        "camelCase":    toCamelCase,
        "pascalCase":   toPascalCase,
        "snakeCase":    toSnakeCase,
        "kebabCase":    toKebabCase,
        "upper":        strings.ToUpper,
        "lower":        strings.ToLower,
        "title":        strings.Title,
        "pluralize":    pluralize,
        "singularize":  singularize,
        "contains":     strings.Contains,
        "replace":      strings.ReplaceAll,
        "join":         strings.Join,
        "eq":           reflect.DeepEqual,
    }
}
```

### 2. Switch-Based Action Dispatch

```go
switch action.Type {
case "add":
    err = executeAddAction(action, ctx)
case "addMany":
    err = executeAddManyAction(action, ctx)
case "modify":
    err = executeModifyAction(action, ctx)
case "append":
    err = executeAppendAction(action, ctx)
default:
    err = fmt.Errorf("unknown action type: %s", action.Type)
}
```

### 3. Dry-Run Mode

```go
if opts.DryRun {
    fmt.Printf("[dry-run] Would create: %s
", targetPath)
    result.Created = append(result.Created, targetPath)
    continue
}
// Actually write the file
err := os.WriteFile(targetPath, []byte(rendered), 0644)
```

---
## Built-in Helpers

All helpers are registered in `internal/codegen/helpers.go` as a `template.FuncMap`.

### Case Conversion
| Function | Input | Output | Usage in Template |
|----------|-------|--------|-------------------|
| `camelCase` | "user profile" | "userProfile" | `{{ camelCase .Name }}` |
| `pascalCase` | "user profile" | "UserProfile" | `{{ pascalCase .Name }}` |
| `kebabCase` | "user profile" | "user-profile" | `{{ kebabCase .Name }}` |
| `snakeCase` | "user profile" | "user_profile" | `{{ snakeCase .Name }}` |
| `constantCase` | "user profile" | "USER_PROFILE" | `{{ constantCase .Name }}` |
| `titleCase` | "user profile" | "User Profile" | `{{ titleCase .Name }}` |

### String Manipulation
| Function | Description | Usage |
|----------|-------------|-------|
| `lower` | Convert to lowercase | `{{ lower .Name }}` |
| `upper` | Convert to uppercase | `{{ upper .Name }}` |
| `trim` | Trim whitespace | `{{ trim .Name }}` |
| `replace` | Find and replace | `{{ replace .Name "old" "new" }}` |
| `contains` | Check substring | `{{ if contains .Name "user" }}` |

### Pluralization
| Function | Input | Output | Usage |
|----------|-------|--------|-------|
| `pluralize` | "user" | "users" | `{{ pluralize .Name }}` |
| `singularize` | "users" | "user" | `{{ singularize .Name }}` |

### Comparison and Logic

Go `text/template` has built-in comparison functions:

| Function | Description | Usage |
|----------|-------------|-------|
| `eq` | Equal | `{{ if eq .Type "page" }}` |
| `ne` | Not equal | `{{ if ne .Status "done" }}` |
| `gt` | Greater than | `{{ if gt .Count 0 }}` |
| `lt` | Less than | `{{ if lt .Count 10 }}` |
| `and` | Logical AND | `{{ if and .A .B }}` |
| `or` | Logical OR | `{{ if or .A .B }}` |
| `not` | Logical NOT | `{{ if not .Flag }}` |

### Array/Slice
| Function | Description | Usage |
|----------|-------------|-------|
| `join` | Join slice with separator | `{{ join .Items ", " }}` |
| `contains` | Check if slice contains | `{{ if contains .Labels "auth" }}` |

---
## Skill System

### Skill Parser (in `template_engine.go` or `skill_sync.go`)

Parses SKILL.md files with YAML frontmatter:

```go
// Skill represents a parsed SKILL.md file.
type Skill struct {
    Name        string   `yaml:"name"`
    Description string   `yaml:"description"`
    Triggers    []string `yaml:"triggers,omitempty"`
    Content     string   // Markdown body content
}

// LoadSkill parses a SKILL.md file from the given directory.
func LoadSkill(dir string) (*Skill, error) {
    data, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
    if err != nil {
        return nil, err
    }
    // Parse YAML frontmatter + markdown body
    // ...
    return &skill, nil
}
```

### Multi-Platform Sync (`skill_sync.go`)

Syncs skills to the platform directories Knowns manages:

| Platform | Directory | Format | MCP |
|----------|-----------|--------|-----|
| Claude Code | `.claude/skills/` | SKILL.md | Yes |
| Codex | `.agents/skills/` | SKILL.md | Yes |
| OpenCode | `.agents/skills/` | SKILL.md | Yes |
| Antigravity | `.agents/skills/` | SKILL.md | Yes |
| Kiro | `.kiro/skills/` | SKILL.md | No |
| Generic Agents (legacy) | `.agent/skills/` | SKILL.md | No |

## Error Handling

### TemplateError

```go
// TemplateError wraps template parsing and execution errors with context.
type TemplateError struct {
    Message string
    Path    string // File path where error occurred
    Err     error  // Underlying error
}

func (e *TemplateError) Error() string {
    if e.Path != "" {
        return fmt.Sprintf("%s: %s", e.Path, e.Message)
    }
    return e.Message
}

func (e *TemplateError) Unwrap() error {
    return e.Err
}
```

### Graceful Degradation

```go
// Actions with skipIfExists
if action.SkipIfExists {
    if _, err := os.Stat(targetPath); err == nil {
        result.Skipped = append(result.Skipped, targetPath)
        continue
    }
}

// Conditional actions
if action.When != "" && !evaluateCondition(action.When, context) {
    continue
}
```

---
## Extension Points

### Custom Template Functions

```go
// In internal/codegen/helpers.go
func defaultFuncMap() template.FuncMap {
    fm := template.FuncMap{
        // ... built-in helpers
    }

    // Add custom helper
    fm["myHelper"] = func(value string) string {
        return strings.ToUpper(value)
    }

    return fm
}
```

### Custom Actions

Extend the action type and add a handler in `template_engine.go`:

```go
// Add new action type
case "custom":
    err = executeCustomAction(action, opts, result)

func executeCustomAction(action TemplateAction, opts RunOptions, result *TemplateResult) error {
    // Custom implementation
    return nil
}
```

---
## Testing

```bash
# Run all template engine tests
go test ./internal/codegen/...

# Run with verbose output
go test -v ./internal/codegen/...

# Run specific test
go test -run TestRenderString ./internal/codegen/
```

Test coverage includes:
- Parser: Config loading, file discovery, validation
- Renderer: String/file rendering, path patterns, conditions
- Runner: Full execution flow, dry-run, force mode
- Helpers: All built-in template functions with edge cases

---

## Best Practices

1. **Use typed structs**: All template data flows through well-defined Go structs
2. **Validate early**: Validate config at parse time, before execution
3. **Reuse FuncMap**: Register all helpers once via `defaultFuncMap()`, reuse across renders
4. **Dry-run first**: Test templates with `DryRun: true` before writing files
5. **Handle errors explicitly**: Return `error` values, wrap with context using `fmt.Errorf`
6. **Use text/template**: Not `html/template` -- code generation output is not HTML
