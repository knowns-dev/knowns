---
id: doc-4f4269e42abce064272a242d02ff1829
title: Template Examples
createdAt: '2026-01-23T04:00:57.742Z'
updatedAt: '2026-03-09T06:40:45.079Z'
description: 'Example templates: Go service, HTTP handler, CLI command'
tags:
  - feature
  - template
  - examples
  - go-template
---
## Overview

Example templates for Knowns CLI (Go projects).

**Related docs:**
- @doc/templates/overview - Overview
- @doc/templates/config - Configuration

---

## Go Service

### `_template.yaml`

```yaml
name: go-service
description: Create a Go service with interface and implementation
destination: internal/services

prompts:
  - name: name
    type: text
    message: "Service name?"
    validate: required

  - name: withTest
    type: confirm
    message: "Include tests?"
    initial: true

  - name: withInterface
    type: confirm
    message: "Generate interface?"
    initial: true

actions:
  - type: add
    template: "{{snakeCase name}}.go.hbs"
    path: "{{snakeCase name}}.go"

  - type: add
    template: "{{snakeCase name}}_test.go.hbs"
    path: "{{snakeCase name}}_test.go"
    when: "{{withTest}}"

  - type: append
    path: "../registry.go"
    template: |
      _ = {{snakeCase name}}.New{{pascalCase name}}Service
    unique: true
```

### `{{snakeCase name}}.go.hbs`

```handlebars
// Package {{snakeCase name}} provides the {{startCase name}} service.
package {{snakeCase name}}

import "context"

{{#if withInterface}}
// {{pascalCase name}}Service defines the service contract.
type {{pascalCase name}}Service interface {
	List(ctx context.Context) ([]{{pascalCase name}}, error)
	GetByID(ctx context.Context, id string) (*{{pascalCase name}}, error)
	Create(ctx context.Context, input Create{{pascalCase name}}Input) (*{{pascalCase name}}, error)
	Delete(ctx context.Context, id string) error
}

{{/if}}
// {{pascalCase name}} is the domain model.
type {{pascalCase name}} struct {
	ID   string
	Name string
}

// Create{{pascalCase name}}Input holds parameters for creating a {{startCase name}}.
type Create{{pascalCase name}}Input struct {
	Name string
}

// service implements {{pascalCase name}}Service.
type service struct{}

// New{{pascalCase name}}Service creates a new service instance.
func New{{pascalCase name}}Service() {{#if withInterface}}{{pascalCase name}}Service{{else}}*service{{/if}} {
	return &service{}
}

func (s *service) List(ctx context.Context) ([]{{pascalCase name}}, error) {
	// TODO: Implement
	return nil, nil
}

func (s *service) GetByID(ctx context.Context, id string) (*{{pascalCase name}}, error) {
	// TODO: Implement
	return nil, nil
}

func (s *service) Create(ctx context.Context, input Create{{pascalCase name}}Input) (*{{pascalCase name}}, error) {
	// TODO: Implement
	return nil, nil
}

func (s *service) Delete(ctx context.Context, id string) error {
	// TODO: Implement
	return nil
}
```

### `{{snakeCase name}}_test.go.hbs`

```handlebars
package {{snakeCase name}}

import (
	"context"
	"testing"
)

func TestNew{{pascalCase name}}Service(t *testing.T) {
	svc := New{{pascalCase name}}Service()
	if svc == nil {
		t.Fatal("expected non-nil service")
	}
}

func Test{{pascalCase name}}Service_List(t *testing.T) {
	svc := New{{pascalCase name}}Service()
	items, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = items
}

func Test{{pascalCase name}}Service_Create(t *testing.T) {
	svc := New{{pascalCase name}}Service()
	input := Create{{pascalCase name}}Input{Name: "test"}
	result, err := svc.Create(context.Background(), input)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_ = result
}
```

---

## HTTP Handler

### `_template.yaml`

```yaml
name: http-handler
description: Create HTTP handler with routes and middleware
destination: internal/handlers

prompts:
  - name: name
    type: text
    message: "Resource name? (e.g., users, products)"
    validate: required

  - name: withMiddleware
    type: confirm
    message: "Include auth middleware?"
    initial: true

actions:
  - type: add
    template: "{{snakeCase name}}_handler.go.hbs"
    path: "{{snakeCase name}}_handler.go"

  - type: add
    template: "{{snakeCase name}}_handler_test.go.hbs"
    path: "{{snakeCase name}}_handler_test.go"

  - type: modify
    path: "../server/router.go"
    pattern: "// ROUTE_REGISTER"
    template: |
      // ROUTE_REGISTER
      {{snakeCase name}}Handler := handlers.New{{pascalCase name}}Handler()
      r.Route("/{{kebabCase name}}", {{snakeCase name}}Handler.Routes)
```

### `{{snakeCase name}}_handler.go.hbs`

```handlebars
package handlers

import (
	"encoding/json"
	"net/http"
)

// {{pascalCase name}}Handler handles HTTP requests for {{startCase name}} resources.
type {{pascalCase name}}Handler struct{}

// New{{pascalCase name}}Handler creates a new handler.
func New{{pascalCase name}}Handler() *{{pascalCase name}}Handler {
	return &{{pascalCase name}}Handler{}
}

// Routes registers all {{startCase name}} routes on the given mux.
func (h *{{pascalCase name}}Handler) Routes(r *http.ServeMux) {
{{#if withMiddleware}}
	// Protected routes
{{/if}}
	r.HandleFunc("GET /", h.List)
	r.HandleFunc("GET /{id}", h.GetByID)
	r.HandleFunc("POST /", h.Create)
	r.HandleFunc("DELETE /{id}", h.Delete)
}

func (h *{{pascalCase name}}Handler) List(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement list
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
}

func (h *{{pascalCase name}}Handler) GetByID(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// TODO: Implement get by ID
	json.NewEncoder(w).Encode(map[string]string{"id": id})
}

func (h *{{pascalCase name}}Handler) Create(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement create
	w.WriteHeader(http.StatusCreated)
}

func (h *{{pascalCase name}}Handler) Delete(w http.ResponseWriter, r *http.Request) {
	// TODO: Implement delete
	w.WriteHeader(http.StatusNoContent)
}
```

### `{{snakeCase name}}_handler_test.go.hbs`

```handlebars
package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNew{{pascalCase name}}Handler(t *testing.T) {
	h := New{{pascalCase name}}Handler()
	if h == nil {
		t.Fatal("expected non-nil handler")
	}
}

func Test{{pascalCase name}}Handler_List(t *testing.T) {
	h := New{{pascalCase name}}Handler()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()

	h.List(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}
}
```

---

## CLI Command (Cobra)

### `_template.yaml`

```yaml
name: cli-command
description: Create a new CLI command using Cobra
destination: cmd

prompts:
  - name: name
    type: text
    message: "Command name?"
    validate: required

  - name: description
    type: text
    message: "Command description?"

  - name: hasSubcommands
    type: confirm
    message: "Has subcommands?"
    initial: false

actions:
  - type: add
    template: "{{snakeCase name}}.go.hbs"
    path: "{{snakeCase name}}.go"

  - type: modify
    path: "root.go"
    pattern: "// COMMAND_REGISTER"
    template: |
      // COMMAND_REGISTER
      rootCmd.AddCommand({{camelCase name}}Cmd)
```

### `{{snakeCase name}}.go.hbs`

```handlebars
package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
)

{{#if hasSubcommands}}
var {{camelCase name}}Cmd = &cobra.Command{
	Use:   "{{kebabCase name}}",
	Short: "{{description}}",
}

var {{camelCase name}}ListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all {{startCase name}}",
	RunE: func(cmd *cobra.Command, args []string) error {
		// TODO: Implement list
		fmt.Println("listing {{kebabCase name}}...")
		return nil
	},
}

func init() {
	{{camelCase name}}Cmd.AddCommand({{camelCase name}}ListCmd)
}
{{else}}
var {{camelCase name}}Cmd = &cobra.Command{
	Use:   "{{kebabCase name}} [arg]",
	Short: "{{description}}",
	Args:  cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// TODO: Implement {{kebabCase name}} command
		fmt.Println("{{kebabCase name}} executed")
		return nil
	},
}

func init() {
	{{camelCase name}}Cmd.Flags().StringP("output", "o", "", "Output format")
}
{{/if}}
```

---

## Feature Module

### `_template.yaml`

```yaml
name: feature-module
description: Complete feature module with model, service, handler, and tests
destination: internal

prompts:
  - name: name
    type: text
    message: "Feature name?"
    validate: required

actions:
  - type: addMany
    source: "{{snakeCase name}}/"
    destination: "{{snakeCase name}}/"
    globPattern: "**/*.hbs"
```

### Structure

```
feature-module/
├── _template.yaml
└── {{snakeCase name}}/
    ├── model.go.hbs
    ├── service.go.hbs
    ├── service_test.go.hbs
    ├── handler.go.hbs
    └── handler_test.go.hbs
```

---

## Usage Examples

```bash
# Create Go service
$ knowns template run go-service
? Service name? user-profile
? Include tests? Yes
? Generate interface? Yes
  Created internal/services/user_profile.go
  Created internal/services/user_profile_test.go

# Create HTTP handler
$ knowns template run http-handler
? Resource name? products
? Include auth middleware? Yes
  Created internal/handlers/products_handler.go
  Created internal/handlers/products_handler_test.go

# Create CLI command
$ knowns template run cli-command
? Command name? export
? Command description? Export data to file
? Has subcommands? No
  Created cmd/export.go

# Create feature module
$ knowns template run feature-module
? Feature name? shopping-cart
  Created internal/shopping_cart/model.go
  Created internal/shopping_cart/service.go
  Created internal/shopping_cart/service_test.go
  Created internal/shopping_cart/handler.go
  Created internal/shopping_cart/handler_test.go
```
