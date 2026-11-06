---
id: doc-997292d807149ba0f9c234e445254891
title: Command Pattern
createdAt: '2025-12-29T07:01:51.223Z'
updatedAt: '2026-03-08T18:19:48.970Z'
description: Documentation for the Command Pattern used in CLI architecture
tags:
  - architecture
  - patterns
  - cli
---
## Overview

The Command Pattern is the primary pattern used to build the Knowns CLI. Each command is defined using the Cobra library (`github.com/spf13/cobra`) as an independent module that can be extended and tested separately.
## Structure

```text
internal/cli/
├── root.go            # Root command, PersistentPreRun, global flags
├── task.go            # Task CRUD (largest command file)
├── doc.go             # Document management
├── time.go            # Time tracking
├── search.go          # Full-text search
├── browser.go         # Web UI launcher
├── config.go          # Configuration
├── init.go            # Project initialization
├── board.go           # Kanban board commands
├── agents.go          # AI agent coordination
├── validate.go        # Validation commands
├── template.go        # Template/codegen commands
├── helpers.go         # Shared CLI helpers (formatting, output)
├── styles.go          # Terminal styling (lipgloss)
└── pager.go           # Pager support for long output
```
## Pattern Implementation

### 1. Command Definition

Each command is defined as a `*cobra.Command` and registered in an `init()` function:

```go
// internal/cli/task.go
package cli

import (
    "fmt"
    "github.com/spf13/cobra"
)

var taskCreateCmd = &cobra.Command{
    Use:   "create <title>",
    Short: "Create a new task",
    Args:  cobra.ExactArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        title := args[0]
        description, _ := cmd.Flags().GetString("description")
        labels, _ := cmd.Flags().GetStringSlice("labels")
        priority, _ := cmd.Flags().GetString("priority")
        ac, _ := cmd.Flags().GetStringSlice("ac")

        store := storage.NewStore(projectRoot)
        task, err := store.CreateTask(storage.CreateTaskInput{
            Title:       title,
            Description: description,
            Labels:      labels,
            Priority:    priority,
            AcceptanceCriteria: ac,
        })
        if err != nil {
            return fmt.Errorf("failed to create task: %w", err)
        }
        fmt.Printf("Created task %s
", task.ID)
        return nil
    },
}

func init() {
    taskCreateCmd.Flags().StringP("description", "d", "", "Task description")
    taskCreateCmd.Flags().StringSlice("ac", nil, "Acceptance criterion (repeatable)")
    taskCreateCmd.Flags().StringP("labels", "l", "", "Comma-separated labels")
    taskCreateCmd.Flags().String("priority", "medium", "Task priority")
    taskCmd.AddCommand(taskCreateCmd)
}
```

### 2. Subcommand Aggregation

Commands are grouped by domain using parent commands:

```go
// internal/cli/task.go
var taskCmd = &cobra.Command{
    Use:   "task",
    Short: "Manage tasks",
}

func init() {
    taskCmd.AddCommand(taskCreateCmd)
    taskCmd.AddCommand(taskListCmd)
    taskCmd.AddCommand(taskViewCmd)
    taskCmd.AddCommand(taskEditCmd)
    taskCmd.AddCommand(taskDeleteCmd)
}
```

### 3. Root Command Registration

All top-level commands are registered to the root command:

```go
// internal/cli/root.go
package cli

import (
    "github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
    Use:   "knowns",
    Short: "Knowledge layer for development teams",
}

func init() {
    rootCmd.AddCommand(taskCmd)
    rootCmd.AddCommand(docCmd)
    rootCmd.AddCommand(timeCmd)
    rootCmd.AddCommand(searchCmd)
    rootCmd.AddCommand(browserCmd)
    rootCmd.AddCommand(configCmd)
    rootCmd.AddCommand(initCmd)
}

func Execute() error {
    return rootCmd.Execute()
}
```
## Key Patterns

### Repeatable Flags (StringSlice)

To collect multiple values for the same flag:

```go
cmd.Flags().StringSlice("ac", nil, "Add acceptance criterion")
// Usage: --ac "First" --ac "Second" --ac "Third"

// Retrieve in RunE:
ac, _ := cmd.Flags().GetStringSlice("ac")
```

### Plain Output Mode

Support output for AI agents:

```go
var taskViewCmd = &cobra.Command{
    Use:   "view <id>",
    Short: "View task details",
    RunE: func(cmd *cobra.Command, args []string) error {
        plain, _ := cmd.Flags().GetBool("plain")
        task, err := store.GetTask(args[0])
        if err != nil {
            return err
        }

        if plain {
            // Plain text format for AI consumption
            fmt.Printf("Task %s - %s
", task.ID, task.Title)
            fmt.Printf("Status: %s
", task.Status)
            fmt.Printf("Priority: %s
", task.Priority)
        } else {
            // Rich formatted output with colors (lipgloss)
            renderTaskRich(task)
        }
        return nil
    },
}

func init() {
    taskViewCmd.Flags().Bool("plain", false, "Output in plain text (for AI)")
}
```

### Error Handling

Consistent error handling using `RunE` (returns error instead of calling `os.Exit`):

```go
var taskViewCmd = &cobra.Command{
    Use:  "view <id>",
    RunE: func(cmd *cobra.Command, args []string) error {
        task, err := store.GetTask(args[0])
        if err != nil {
            return fmt.Errorf("task %s not found: %w", args[0], err)
        }
        // ... render task
        return nil
    },
}
```
## Benefits

1. **Modularity**: Each command is a separate file, easy to maintain

2. **Extensibility**: Adding new commands only requires creating a file and registering via `init()`

3. **Testability**: Test each command independently

4. **Discoverability**: Cobra auto-generates help text and shell completions

5. **Consistency**: Same `cobra.Command` pattern for all commands

6. **Error propagation**: `RunE` returns errors to the root for consistent handling
## Adding New Commands

1. Create a new file in `internal/cli/`:

```go
// internal/cli/mycommand.go
package cli

import (
    "fmt"
    "github.com/spf13/cobra"
)

var myCmd = &cobra.Command{
    Use:   "mycommand",
    Short: "Description of my command",
    RunE: func(cmd *cobra.Command, args []string) error {
        option, _ := cmd.Flags().GetString("option")
        // Implementation
        return nil
    },
}

func init() {
    myCmd.Flags().String("option", "", "Option description")
    rootCmd.AddCommand(myCmd)
}
```

2. The `init()` function automatically registers the command when the package is loaded -- no need to manually import or wire anything.

3. For subcommands, create a parent command and add children in `init()`:

```go
var parentCmd = &cobra.Command{
    Use:   "parent",
    Short: "Parent command group",
}

var parentSubCmd = &cobra.Command{
    Use:   "sub",
    Short: "Subcommand",
    RunE:  func(cmd *cobra.Command, args []string) error { return nil },
}

func init() {
    parentCmd.AddCommand(parentSubCmd)
    rootCmd.AddCommand(parentCmd)
}
```
## Related Docs

- @doc/architecture/patterns/mcp-server - MCP Server Pattern
- @doc/architecture/patterns/storage - File-Based Storage Pattern



---

## Template

Generate new commands using the template:

```bash
knowns template run knowns-command
```

**Template reference:** @template/knowns-command
