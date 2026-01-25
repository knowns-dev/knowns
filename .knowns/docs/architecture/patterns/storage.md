---
title: Storage Pattern
createdAt: '2025-12-29T07:03:35.974Z'
updatedAt: '2025-12-29T07:13:44.530Z'
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
src/storage/
├── file-store.ts      # Main storage class (11KB)
├── markdown.ts        # Parsing/serialization (6KB)
├── version-store.ts   # Version history (4KB)
└── index.ts           # Barrel export
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

### 1. FileStore Class

```typescript
class FileStore {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  // === Task Operations ===
  async createTask(data: CreateTaskInput): Promise<Task> {
    const id = await this.generateTaskId();
    const task: Task = {
      id,
      title: data.title,
      description: data.description || "",
      status: data.status || "todo",
      priority: data.priority || "medium",
      labels: data.labels || [],
      assignee: data.assignee,
      createdAt: new Date(),
      updatedAt: new Date(),
      acceptanceCriteria: data.acceptanceCriteria || [],
      timeSpent: 0,
      timeEntries: [],
    };

    const markdown = serializeTaskMarkdown(task);
    const filename = `task-${id} - ${sanitize(task.title)}.md`;
    await writeFile(join(this.tasksDir, filename), markdown);

    return task;
  }

  async getTask(id: string): Promise<Task | null> {
    const files = await glob(`task-${id} - *.md`, { cwd: this.tasksDir });
    if (files.length === 0) return null;

    const content = await readFile(join(this.tasksDir, files[0]), "utf-8");
    return parseTaskMarkdown(content);
  }

  async updateTask(id: string, updates: Partial<Task>): Promise<Task> {
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);

    const updated = { ...task, ...updates, updatedAt: new Date() };
    const markdown = serializeTaskMarkdown(updated);

    // Rename file if title changed
    const oldFile = await this.findTaskFile(id);
    const newFilename = `task-${id} - ${sanitize(updated.title)}.md`;

    if (oldFile !== newFilename) {
      await rename(join(this.tasksDir, oldFile), join(this.tasksDir, newFilename));
    }

    await writeFile(join(this.tasksDir, newFilename), markdown);

    // Save version history
    await this.versionStore.saveVersion(id, updates, updated);

    return updated;
  }

  async getAllTasks(): Promise<Task[]> {
    const files = await glob("task-*.md", { cwd: this.tasksDir });
    const tasks = await Promise.all(
      files.map(async (file) => {
        const content = await readFile(join(this.tasksDir, file), "utf-8");
        return parseTaskMarkdown(content);
      })
    );
    return tasks;
  }

  async deleteTask(id: string): Promise<void> {
    const file = await this.findTaskFile(id);
    if (file) {
      await unlink(join(this.tasksDir, file));
    }
  }

  // === Subtask Operations ===
  async getSubtasks(parentId: string): Promise<Task[]> {
    const all = await this.getAllTasks();
    return all.filter((t) => t.id.startsWith(`${parentId}.`));
  }

  // === Project Operations ===
  async getProject(): Promise<Project | null> {
    const configPath = join(this.projectRoot, ".knowns", "config.json");
    if (!existsSync(configPath)) return null;
    return JSON.parse(await readFile(configPath, "utf-8"));
  }
}
```

### 2. Markdown Parser

```typescript
import matter from "gray-matter";

function parseTaskMarkdown(content: string): Task {
  const { data: frontmatter, content: body } = matter(content);

  return {
    id: frontmatter.id,
    title: frontmatter.title,
    status: frontmatter.status,
    priority: frontmatter.priority,
    assignee: frontmatter.assignee,
    labels: frontmatter.labels || [],
    createdAt: new Date(frontmatter.createdAt),
    updatedAt: new Date(frontmatter.updatedAt),
    timeSpent: frontmatter.timeSpent || 0,
    description: extractSection(body, "DESCRIPTION"),
    acceptanceCriteria: parseAcceptanceCriteria(extractSection(body, "AC")),
    implementationPlan: extractSection(body, "PLAN"),
    implementationNotes: extractSection(body, "NOTES"),
    timeEntries: [], // Loaded from time-entries.json
  };
}

function serializeTaskMarkdown(task: Task): string {
  const frontmatter = {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    labels: task.labels,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    timeSpent: task.timeSpent,
  };

  const body = `# ${task.title}

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

```typescript
async function generateSubtaskId(parentId: string): string {
  const subtasks = await this.getSubtasks(parentId);
  const maxSubIndex = subtasks.reduce((max, t) => {
    const parts = t.id.split(".");
    const subIndex = parseInt(parts[parts.length - 1], 10);
    return Math.max(max, subIndex);
  }, 0);
  return `${parentId}.${maxSubIndex + 1}`;
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
