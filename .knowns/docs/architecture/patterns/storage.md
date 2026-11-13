---
id: doc-5a7f994fb763f9df18cd76dd3dda0b8a
title: Storage Pattern
createdAt: '2025-12-29T07:03:35.974Z'
updatedAt: '2026-03-08T18:20:29.588Z'
description: Documentation for File-Based Storage with Markdown Frontmatter
tags:
  - architecture
  - patterns
  - storage
---
## Overview

Knowns uses file-based storage with Markdown + YAML Frontmatter instead of traditional databases. Philosophy: **"Files are the database"**.
## Location

```
internal/storage/
├── store.go              # Main Store struct and constructor
├── task_store.go         # Task CRUD operations
├── doc_store.go          # Document CRUD operations
├── config_store.go       # Project config operations
├── template_store.go     # Template operations
├── time_store.go         # Time tracking storage
├── version_store.go      # Version history
├── workspace_store.go    # Workspace/project detection
└── util.go               # Shared utilities (markdown parsing, etc.)
```
## File Structure

```
.knowns/
├── config.json              # Project metadata
├── tasks/
│   ├── task-1 - Feature X.md
│   ├── task-2 - Bug Fix.md
│   └── task-3.1 - Subtask.md   # Hierarchical IDs
├── docs/
│   ├── README.md
│   ├── patterns/
│   │   └── auth.md
│   └── architecture.md
├── time-entries.json        # Time tracking data
└── .versions/               # Hidden version history
    ├── task-1.versions.json
    └── task-2.versions.json
```

## Task File Format

```markdown
---
id: "42"
title: "Add authentication"
status: "in-progress"
priority: "high"
assignee: "@harry"
labels: ["auth", "feature"]
createdAt: "2025-01-15T10:00:00Z"
updatedAt: "2025-01-15T14:30:00Z"
timeSpent: 3600
---

# Add authentication

## Description
<!-- DESCRIPTION:BEGIN -->
Implement JWT-based authentication...
<!-- DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] User can login with email/password
- [x] JWT tokens expire after 1 hour
- [ ] Invalid credentials return 401
<!-- AC:END -->

## Implementation Plan
<!-- PLAN:BEGIN -->
1. Design auth flow
2. Implement endpoints
<!-- PLAN:END -->

## Implementation Notes
<!-- NOTES:BEGIN -->
Progress notes here...
<!-- NOTES:END -->
```

## Core Components

### 1. Store Struct

```go
// internal/storage/store.go
package storage

import (
    "fmt"
    "os"
    "path/filepath"
)

// Store provides file-based storage for tasks, docs, and config.
type Store struct {
    ProjectRoot string
    tasksDir    string
    docsDir     string
    configPath  string
}

// NewStore creates a new Store rooted at the given project directory.
func NewStore(projectRoot string) *Store {
    knownsDir := filepath.Join(projectRoot, ".knowns")
    return &Store{
        ProjectRoot: projectRoot,
        tasksDir:    filepath.Join(knownsDir, "tasks"),
        docsDir:     filepath.Join(knownsDir, "docs"),
        configPath:  filepath.Join(knownsDir, "config.json"),
    }
}
```

```go
// internal/storage/task_store.go

// CreateTask creates a new task and writes it to disk.
func (s *Store) CreateTask(input CreateTaskInput) (*Task, error) {
    id, err := s.generateTaskID()
    if err != nil {
        return nil, fmt.Errorf("generate task ID: %w", err)
    }

    task := &Task{
        ID:          id,
        Title:       input.Title,
        Description: input.Description,
        Status:      "todo",
        Priority:    input.Priority,
        Labels:      input.Labels,
        CreatedAt:   time.Now(),
        UpdatedAt:   time.Now(),
    }
    if task.Priority == "" {
        task.Priority = "medium"
    }

    markdown := serializeTaskMarkdown(task)
    filename := fmt.Sprintf("task-%s - %s.md", id, sanitize(task.Title))
    err = os.WriteFile(filepath.Join(s.tasksDir, filename), []byte(markdown), 0644)
    if err != nil {
        return nil, fmt.Errorf("write task file: %w", err)
    }

    return task, nil
}

// GetTask retrieves a task by ID.
func (s *Store) GetTask(id string) (*Task, error) {
    pattern := fmt.Sprintf("task-%s - *.md", id)
    matches, err := filepath.Glob(filepath.Join(s.tasksDir, pattern))
    if err != nil {
        return nil, err
    }
    if len(matches) == 0 {
        return nil, fmt.Errorf("task %s not found", id)
    }

    data, err := os.ReadFile(matches[0])
    if err != nil {
        return nil, err
    }
    return parseTaskMarkdown(string(data))
}

// UpdateTask updates a task and saves it to disk.
func (s *Store) UpdateTask(id string, updates map[string]interface{}) (*Task, error) {
    task, err := s.GetTask(id)
    if err != nil {
        return nil, err
    }

    // Apply updates to task fields...
    task.UpdatedAt = time.Now()

    markdown := serializeTaskMarkdown(task)

    // Rename file if title changed
    oldFile := s.findTaskFile(id)
    newFilename := fmt.Sprintf("task-%s - %s.md", id, sanitize(task.Title))

    if filepath.Base(oldFile) != newFilename {
        os.Rename(oldFile, filepath.Join(s.tasksDir, newFilename))
    }

    err = os.WriteFile(filepath.Join(s.tasksDir, newFilename), []byte(markdown), 0644)
    if err != nil {
        return nil, err
    }

    // Save version history
    s.SaveVersion(id, task)

    return task, nil
}

// GetAllTasks returns all tasks from disk.
func (s *Store) GetAllTasks() ([]*Task, error) {
    matches, err := filepath.Glob(filepath.Join(s.tasksDir, "task-*.md"))
    if err != nil {
        return nil, err
    }

    var tasks []*Task
    for _, match := range matches {
        data, err := os.ReadFile(match)
        if err != nil {
            continue
        }
        task, err := parseTaskMarkdown(string(data))
        if err != nil {
            continue
        }
        tasks = append(tasks, task)
    }
    return tasks, nil
}
```

### 2. Markdown Parser

```go
// internal/storage/util.go
package storage

import (
    "strings"
    "gopkg.in/yaml.v3"
)

// parseTaskMarkdown parses a markdown file with YAML frontmatter into a Task.
func parseTaskMarkdown(content string) (*Task, error) {
    frontmatter, body, err := splitFrontmatter(content)
    if err != nil {
        return nil, err
    }

    var task Task
    if err := yaml.Unmarshal([]byte(frontmatter), &task); err != nil {
        return nil, fmt.Errorf("parse frontmatter: %w", err)
    }

    task.Description = extractSection(body, "DESCRIPTION")
    task.AcceptanceCriteria = parseAcceptanceCriteria(extractSection(body, "AC"))
    task.ImplementationPlan = extractSection(body, "PLAN")
    task.ImplementationNotes = extractSection(body, "NOTES")

    return &task, nil
}

// serializeTaskMarkdown converts a Task to markdown with YAML frontmatter.
func serializeTaskMarkdown(task *Task) string {
    fm, _ := yaml.Marshal(task.frontmatterFields())

    var sb strings.Builder
    sb.WriteString("---
")
    sb.Write(fm)
    sb.WriteString("---

")
    sb.WriteString("# " + task.Title + "

")

    if task.Description != "" {
        sb.WriteString("## Description

")
        sb.WriteString(task.Description + "

")
    }

    // ... write AC, Plan, Notes sections

    return sb.String()
}

// splitFrontmatter separates YAML frontmatter from markdown body.
func splitFrontmatter(content string) (string, string, error) {
    if !strings.HasPrefix(content, "---
") {
        return "", content, nil
    }
    parts := strings.SplitN(content[4:], "
---
", 2)
    if len(parts) != 2 {
        return "", content, fmt.Errorf("malformed frontmatter")
    }
    return parts[0], parts[1], nil
}
```

### 3. Section Markers

Sections in task markdown are delimited by `## Heading` markers:

```go
// extractSection extracts content between section markers.
func extractSection(body, sectionName string) string {
    // Find "## SectionName" and extract until next "##" or EOF
    // ...
}
```

### 4. Version Store

```go
// internal/storage/version_store.go

// SaveVersion saves a version snapshot for a task.
func (s *Store) SaveVersion(taskID string, task *Task) error {
    versionsDir := filepath.Join(s.ProjectRoot, ".knowns", ".versions")
    os.MkdirAll(versionsDir, 0755)

    filename := fmt.Sprintf("%s.versions.json", taskID)
    // Append version entry to JSON array file
    // ...
    return nil
}
```
## Description
<!-- DESCRIPTION:BEGIN -->
${task.description || ""}
<!-- DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
${formatAcceptanceCriteria(task.acceptanceCriteria)}
<!-- AC:END -->

## Implementation Plan
<!-- PLAN:BEGIN -->
${task.implementationPlan || ""}
<!-- PLAN:END -->

## Implementation Notes
<!-- NOTES:BEGIN -->
${task.implementationNotes || ""}
<!-- NOTES:END -->
`;

  return matter.stringify(body, frontmatter);
}
```

### 3. Section Markers

Section markers (`<!-- SECTION:BEGIN/END -->`) allow precise content extraction and updates:

```typescript
function extractSection(content: string, section: string): string {
  const beginMarker = `<!-- ${section}:BEGIN -->`;
  const endMarker = `<!-- ${section}:END -->`;

  const beginIndex = content.indexOf(beginMarker);
  const endIndex = content.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) return "";

  return content.slice(beginIndex + beginMarker.length, endIndex).trim();
}

function replaceSection(content: string, section: string, newContent: string): string {
  const beginMarker = `<!-- ${section}:BEGIN -->`;
  const endMarker = `<!-- ${section}:END -->`;

  const beginIndex = content.indexOf(beginMarker);
  const endIndex = content.indexOf(endMarker);

  if (beginIndex === -1 || endIndex === -1) return content;

  return (
    content.slice(0, beginIndex + beginMarker.length) +
    "\n" + newContent + "\n" +
    content.slice(endIndex)
  );
}
```

### 4. Version Store

```typescript
interface TaskVersion {
  id: string;
  taskId: string;
  version: number;
  timestamp: Date;
  author?: string;
  changes: TaskChange[];
  snapshot: Partial<Task>;
}

interface TaskChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

class VersionStore {
  async saveVersion(
    taskId: string,
    changes: Partial<Task>,
    snapshot: Task
  ): Promise<void> {
    const history = await this.getVersionHistory(taskId);
    const version = history.length + 1;

    const taskChanges = this.detectChanges(
      history.length > 0 ? history[history.length - 1].snapshot : {},
      changes
    );

    const newVersion: TaskVersion = {
      id: `${taskId}-v${version}`,
      taskId,
      version,
      timestamp: new Date(),
      changes: taskChanges,
      snapshot,
    };

    history.push(newVersion);
    await this.saveHistory(taskId, history);
  }

  async getVersionHistory(taskId: string): Promise<TaskVersion[]> {
    const path = join(this.versionsDir, `${taskId}.versions.json`);
    if (!existsSync(path)) return [];
    return JSON.parse(await readFile(path, "utf-8"));
  }

  private detectChanges(old: Partial<Task>, new_: Partial<Task>): TaskChange[] {
    const changes: TaskChange[] = [];
    const trackedFields = ["title", "description", "status", "priority", "assignee", "labels"];

    for (const field of trackedFields) {
      if (new_[field] !== undefined && old[field] !== new_[field]) {
        changes.push({
          field,
          oldValue: old[field],
          newValue: new_[field],
        });
      }
    }

    return changes;
  }
}
```

## Hierarchical Task IDs

```
task-1          (parent)
task-1.1        (child of 1)
task-1.1.1      (grandchild)
task-2          (sibling of 1)
task-2.1        (child of 2)
```

```go
// generateSubtaskID creates a new subtask ID under the given parent.
func (s *Store) generateSubtaskID(parentID string) (string, error) {
    subtasks, err := s.GetSubtasks(parentID)
    if err != nil {
        return "", err
    }

    maxSubIndex := 0
    for _, t := range subtasks {
        parts := strings.Split(t.ID, ".")
        subIndex, _ := strconv.Atoi(parts[len(parts)-1])
        if subIndex > maxSubIndex {
            maxSubIndex = subIndex
        }
    }
    return fmt.Sprintf("%s.%d", parentID, maxSubIndex+1), nil
}
```
## Benefits

1. **Git-friendly**: Version control for free
2. **Human-readable**: Can edit raw markdown
3. **No migrations**: No schema versions to manage
4. **Portable**: Works everywhere, no database dependencies
5. **Debuggable**: Inspect data anytime
6. **AI-friendly**: Markdown is natural for LLMs

## Trade-offs

- Slower for large projects (1000+ tasks)
- No SQL queries
- No built-in pagination

## Related Docs

- @doc/architecture/patterns/command - CLI Command Pattern
- @doc/architecture/patterns/mcp-server - MCP Server Pattern
- @doc/architecture/patterns/server - Express Server Pattern
