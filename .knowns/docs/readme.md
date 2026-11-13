---
id: doc-9b2ec0fa2f6511e2d9a21b5bcdc6c1f7
title: README
description: ''
createdAt: '2026-01-02T08:21:28.938Z'
updatedAt: '2026-01-08T20:46:27.241Z'
tags: []
---

# Knowns Hub - Technical Specification v2

> **Self-hosted Trello Alternative with Docs & AI Integration**
> 
> Free, self-hosted project management platform.
> Works standalone like Trello, with optional CLI integration for dev teams.

---

## 1. Overview

### 1.1 What is Knowns Hub?

**Knowns Hub** is a self-hosted project management platform:

- **Standalone**: Works entirely through Web UI (like Trello)
- **Docs built-in**: Wiki-like documentation (like Notion)
- **AI-ready**: MCP Server for AI assistants
- **CLI optional**: Git repo integration for dev teams

### 1.2 Target Users

| Tier | Users | How they use |
|------|-------|--------------|
| **Tier 1** | Startups, Agencies, Freelancers, Non-tech teams | Standalone (Trello-like) |
| **Tier 2** | Dev teams, Open source | Standalone + CLI Integration |

### 1.3 Competitive Positioning

| Feature | Trello | Jira | Notion | **Knowns Hub** |
|---------|--------|------|--------|----------------|
| Kanban | ✓ | ✓ | ✓ | ✓ |
| Docs/Wiki | ✗ | ✓ | ✓ | ✓ |
| Self-hosted | ✗ | $$$ | ✗ | ✓ Free |
| CLI | ✗ | ✗ | ✗ | ✓ Optional |
| Git integration | ✗ | ✓ | ✗ | ✓ Optional |
| AI-ready (MCP) | ✗ | ✗ | ✓ | ✓ |
| Pricing | Freemium | $$$ | Freemium | **Free** |
| Complexity | Simple | Complex | Medium | Simple |

### 1.4 Core Philosophy

```
┌─────────────────────────────────────────────────────────────────┐
│  "Simple like Trello, Powerful like Notion, AI-ready"           │
│  "Self-hosted, own your data"                                   │
│  "Works standalone, CLI is bonus"                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture

### 2.1 Standalone Mode (Default)

```
┌─────────────────────────────────────────────────────────────────┐
│                      KNOWNS HUB                                 │
│                   (Standalone Mode)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Tasks     │  │    Docs     │  │        Plans            │ │
│  │  (Kanban)   │  │   (Wiki)    │  │     (Roadmaps)          │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │  Comments   │  │   Labels    │  │       Members           │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  REST API  │  SSE (realtime)  │  MCP Server (AI)          │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Web UI    │
                    │  (Browser)  │
                    └─────────────┘
```

### 2.2 With CLI Integration (Optional)

```
┌─────────────────────────────────────────────────────────────────┐
│                      KNOWNS HUB                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              STANDALONE FEATURES                         │   │
│  │  Tasks  │  Docs  │  Plans  │  Comments  │  Labels        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              CLI INTEGRATION (Optional)                  │   │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────────────┐    │   │
│  │  │   Repos   │  │Repo Tasks │  │   Git Sync        │    │   │
│  │  │ (linked)  │  │ (synced)  │  │   (2-way)         │    │   │
│  │  └───────────┘  └───────────┘  └───────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  REST API  │  SSE  │  MCP Server                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
   ┌─────────┐       ┌─────────┐        ┌─────────┐
   │ Web UI  │       │   CLI   │        │   AI    │
   │(Browser)│       │(knowns) │        │  (MCP)  │
   └─────────┘       └─────────┘        └─────────┘
```

---

## 3. Data Model

### 3.1 Core Entities (Standalone)

```
Organization
└── Project
    ├── Tasks
    │   ├── Title, Description
    │   ├── Status (columns)
    │   ├── Assignee
    │   ├── Labels
    │   ├── Priority
    │   ├── Due date
    │   └── Acceptance Criteria (checklist)
    │
    ├── Docs
    │   ├── Title
    │   ├── Content (Markdown)
    │   └── Folder
    │
    ├── Plans
    │   ├── Title, Description
    │   ├── Start/End date
    │   ├── Milestones
    │   └── Linked Tasks
    │
    └── Members
        ├── Email, Name
        └── Role (admin/member/viewer)
```

### 3.2 Extended Entities (With CLI)

```
Project
└── Repos (optional, when using CLI)
    ├── Name
    ├── Remote URL
    ├── Sync Mode (git-tracked / git-ignored)
    └── Repo Tasks (synced from .knowns/)
```

### 3.3 Task Types

| Mode | Task Type | Source | Create/Edit |
|------|-----------|--------|-------------|
| **Standalone** | Task | Hub | Web UI |
| **With CLI** | Task | Hub | Web UI |
| **With CLI** | Repo Task | Git | CLI → Sync to Hub |

### 3.4 ID Format

```
Tasks:      task-a7f3    (random 4-char, collision-free)
Docs:       doc-k8m2
Plans:      plan-x9y2
Repo Tasks: rtask-b2c4   (when CLI connected)
```

---

## 4. Features

### 4.1 Core Features (Standalone)

#### Kanban Board

```
┌─────────────────────────────────────────────────────────────────┐
│  Product A                        [+ Add Task]  [Filter ▼]      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─── TODO ─────────┐ ┌─ IN PROGRESS ──┐ ┌───── DONE ─────┐    │
│  │                  │ │                │ │                │    │
│  │ ┌──────────────┐ │ │ ┌──────────────┐│ │ ┌──────────────┐│    │
│  │ │ Design homepage│ │ │Auth system  ││ │ │Setup CI     ││    │
│  │ │ 🏷 design     │ │ │ @harry       ││ │ │ @alice      ││    │
│  │ │ @alice       │ │ │ 🏷 backend    ││ │ │ ✓ Done      ││    │
│  │ └──────────────┘ │ │ └──────────────┘│ │ └──────────────┘│    │
│  │                  │ │                │ │                │    │
│  │ ┌──────────────┐ │ │ ┌──────────────┐│ │                │    │
│  │ │ API docs     │ │ │ │Login page   ││ │                │    │
│  │ │ 🏷 docs      │ │ │ │ @bob        ││ │                │    │
│  │ └──────────────┘ │ │ └──────────────┘│ │                │    │
│  │                  │ │                │ │                │    │
│  └──────────────────┘ └────────────────┘ └────────────────┘    │
│                                                                 │
│  Drag & drop to move tasks between columns                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Task Detail

```
┌─────────────────────────────────────────────────────────────────┐
│  Design homepage                                        [Close] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Description:                                        [Edit ✏️]  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Create responsive homepage design                        │  │
│  │ - Hero section                                           │  │
│  │ - Features grid                                          │  │
│  │ - Testimonials                                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ Status      │ │ Assignee    │ │ Priority    │               │
│  │ [TODO ▼]    │ │ [@alice ▼]  │ │ [High ▼]    │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
│                                                                 │
│  Labels: [+ Add]                                                │
│  ┌─────────┐ ┌─────────┐                                       │
│  │ 🏷 design│ │ 🏷 urgent│                                       │
│  └─────────┘ └─────────┘                                       │
│                                                                 │
│  Due date: [Jan 15, 2026]                                       │
│                                                                 │
│  Checklist: ━━━━━━━━░░░░ 2/4                                   │
│  ☑ Hero section mockup                                         │
│  ☑ Features grid layout                                        │
│  ☐ Testimonials carousel                                       │
│  ☐ Mobile responsive                                           │
│  [+ Add item]                                                   │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  💬 Comments                                                    │
│                                                                 │
│  @bob: Can we use the new brand colors?                        │
│  2 hours ago                                                    │
│                                                                 │
│  @alice: Yes, I'll update the palette                          │
│  1 hour ago                                                     │
│                                                                 │
│  [Write a comment...]                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Docs (Wiki)

```
┌─────────────────────────────────────────────────────────────────┐
│  Docs                                              [+ New Doc]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ Sidebar ─────────┐  ┌─ Content ─────────────────────────┐  │
│  │                   │  │                                   │  │
│  │  📁 Getting Started│  │  # API Specification              │  │
│  │    └─ 📄 Onboarding│  │                                   │  │
│  │                   │  │  ## Authentication                │  │
│  │  📁 Architecture  │  │                                   │  │
│  │    ├─ 📄 Overview │  │  All API requests require a       │  │
│  │    └─ 📄 Database │  │  valid JWT token in the header:   │  │
│  │                   │  │                                   │  │
│  │  📁 API           │  │  ```                              │  │
│  │    └─ 📄 Spec ◀── │  │  Authorization: Bearer <token>   │  │
│  │                   │  │  ```                              │  │
│  │  📁 Decisions     │  │                                   │  │
│  │    └─ 📄 ADR-001  │  │  ## Endpoints                     │  │
│  │                   │  │                                   │  │
│  └───────────────────┘  │  ### POST /api/auth/login         │  │
│                         │  ...                              │  │
│                         │                                   │  │
│                         │  [Edit] [Delete]                  │  │
│                         │                                   │  │
│                         └───────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Plans (Roadmap)

```
┌─────────────────────────────────────────────────────────────────┐
│  📋 Q1 2026 Roadmap                                [Edit Plan]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Progress: ████████████░░░░░░░░ 60% (12/20 tasks)              │
│                                                                 │
│  ┌─ January ────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  Week 1-2: Foundation                                    │  │
│  │  ☑ task-a7f3 - Setup project structure      @harry done │  │
│  │  ☑ task-b2c4 - Database schema              @alice done │  │
│  │  ☑ task-c3d5 - Auth system                  @harry done │  │
│  │                                                          │  │
│  │  Week 3-4: Core Features                                 │  │
│  │  ☐ task-d4e6 - User dashboard               @bob   wip  │  │
│  │  ☐ task-e5f7 - API endpoints                @harry todo │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ February ───────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │  Week 1-2: Frontend                                      │  │
│  │  ☐ task-f6g8 - Homepage                     @alice todo │  │
│  │  ☐ task-g7h9 - Dashboard UI                 @bob   todo │  │
│  │  ...                                                     │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [+ Add Milestone] [+ Link Task]                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Dashboard

```
┌─────────────────────────────────────────────────────────────────┐
│  Product A                                        [@harry ▼]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─ Quick Stats ────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │   24          8           12            4                │  │
│  │  Total      Todo     In Progress      Done               │  │
│  │  Tasks                                                   │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌─ My Tasks ──────────────────┐ ┌─ Recent Activity ────────┐  │
│  │                             │ │                          │  │
│  │ • Auth system    in-progress│ │ • alice completed       │  │
│  │ • API endpoints  todo       │ │   "Setup CI"            │  │
│  │ • Rate limiting  todo       │ │   5 min ago             │  │
│  │                             │ │                          │  │
│  │ [View all →]                │ │ • bob commented on      │  │
│  │                             │ │   "Design homepage"     │  │
│  └─────────────────────────────┘ │   1 hour ago            │  │
│                                  │                          │  │
│  ┌─ Active Plans ──────────────┐ │ • harry created         │  │
│  │                             │ │   "API endpoints"       │  │
│  │ Q1 2026 Roadmap      60%   │ │   2 hours ago           │  │
│  │ ████████████░░░░░░░░       │ │                          │  │
│  │                             │ │ [View all →]            │  │
│  │ [View plan →]               │ │                          │  │
│  └─────────────────────────────┘ └──────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Extended Features (With CLI)

#### Repos & Sync

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings → Repos                                  [+ Add Repo] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Connected Repositories:                                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 📁 backend                                               │  │
│  │ github.com/company/backend                               │  │
│  │ Last sync: 5 minutes ago • 12 tasks synced               │  │
│  │ Mode: git-tracked                                        │  │
│  │ [Sync Now] [Settings] [Unlink]                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ 📁 frontend                                              │  │
│  │ github.com/company/frontend                              │  │
│  │ Last sync: 1 hour ago • 8 tasks synced                   │  │
│  │ Mode: git-ignored                                        │  │
│  │ [Sync Now] [Settings] [Unlink]                           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  CLI Setup Instructions:                                        │
│                                                                 │
│  $ npm install -g knowns                                        │
│  $ cd your-repo                                                 │
│  $ knowns init                                                  │
│  $ knowns hub link https://your-hub.com                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

#### Unified Task View (With Repos)

```
┌─────────────────────────────────────────────────────────────────┐
│  All Tasks                [All Sources ▼] [All Assignees ▼]     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─── TODO ─────────┐ ┌─ IN PROGRESS ──┐ ┌───── DONE ─────┐    │
│  │                  │ │                │ │                │    │
│  │ 📌 task-a7f3     │ │ 📁 rtask-k8m2  │ │ 📁 rtask-x1y2  │    │
│  │ Security Audit   │ │ Auth API       │ │ Setup CI       │    │
│  │ @harry • Hub     │ │ @harry • BE    │ │ @alice • BE    │    │
│  │                  │ │                │ │                │    │
│  │ 📁 rtask-b2c4    │ │ 📌 task-m3n5   │ │ 📌 task-p3q4   │    │
│  │ Rate limiting    │ │ Design review  │ │ Planning done  │    │
│  │ @harry • BE      │ │ @alice • Hub   │ │ @bob • Hub     │    │
│  │                  │ │                │ │                │    │
│  └──────────────────┘ └────────────────┘ └────────────────┘    │
│                                                                 │
│  📌 = Hub Task    📁 = Repo Task (synced)                       │
│  BE = Backend     FE = Frontend                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Sync System (CLI Integration)

### 5.1 Sync Modes

#### Mode 1: Git-tracked (.knowns/ in Git)

```
┌─────────────────────────────────────────────────────────────────┐
│  .knowns/ is committed to Git                                   │
│  Git is the source of truth for task content                        │
│  Hub mirrors + adds metadata                                    │
└─────────────────────────────────────────────────────────────────┘

Characteristics:
  ✓ Git history for task changes
  ✓ Code review includes task changes
  ✓ Full offline support
  ✓ Conflict resolution via Git

Workflow:
  git pull              → Get .knowns/ from team
  knowns hub sync       → Mirror to Hub + pull metadata
```

#### Mode 2: Git-ignored (.knowns/ local only)

```
┌─────────────────────────────────────────────────────────────────┐
│  .knowns/ is in .gitignore                                      │
│  Hub is the source of truth                                         │
│  Local .knowns/ is cache                                        │
└─────────────────────────────────────────────────────────────────┘

Characteristics:
  ✓ Non-devs can edit from Hub UI
  ✓ No Git workflow needed
  ✗ Requires online for sync
  ✗ Conflict resolution via Hub

Workflow:
  knowns hub sync       → Push/Pull with Hub
```

### 5.2 Conflict Resolution

#### Git-tracked Mode

```
Task Content  → Git merge (standard workflow)
Task Metadata → Hub (last-write-wins)
```

#### Git-ignored Mode

```bash
$ knowns hub sync

⚠️  CONFLICT on task-a7f3

Your local version:
  Description: "Use argon2"

Hub version (by @harry):
  Description: "Use bcrypt"

Options:
  [L] Keep local (overwrite Hub)
  [H] Use Hub (discard local)
  [M] Merge manually
  [S] Skip (resolve later)

Choice: _
```

### 5.3 Data Ownership

| Data | Standalone | With CLI (git-tracked) | With CLI (git-ignored) |
|------|------------|------------------------|------------------------|
| Hub Tasks | Hub | Hub | Hub |
| Repo Tasks | N/A | Git | Hub |
| Docs | Hub | Hub (shared) / Git (repo) | Hub |
| Plans | Hub | Hub | Hub |
| Metadata | Hub | Hub | Hub |
| Comments | Hub | Hub | Hub |

---

## 6. CLI Commands

### 6.1 Hub Connection

```bash
# Link repo with Hub
knowns hub link <hub-url>
knowns hub login
knowns hub logout
knowns hub status
```

### 6.2 Sync

```bash
knowns hub sync              # Push + Pull
knowns hub sync --push       # Push only
knowns hub sync --pull       # Pull only
knowns hub sync --watch      # Background daemon
```

### 6.3 Repo Tasks

```bash
knowns task create <title> -d <desc>
knowns task edit <id>
knowns task list
knowns task <id> --plain
knowns task delete <id>
```

### 6.4 Hub Tasks (from CLI)

```bash
knowns hub task create <title>
knowns hub task edit <id>
knowns hub task list
knowns hub tasks             # All tasks (hub + repo)
```

### 6.5 Hub Docs

```bash
knowns hub docs
knowns hub doc <id> --plain
knowns hub doc create <title> -f <folder>
```

### 6.6 Hub Plans

```bash
knowns hub plans
knowns hub plan <id> --plain
```

### 6.7 Conflicts

```bash
knowns hub conflicts         # List unresolved
knowns hub resolve <id>      # Resolve specific
```

---

## 7. Database Schema

```sql
-- ═══════════════════════════════════════════════════════════════
--  CORE: ORGANIZATIONS & PROJECTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(org_id, slug)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: MEMBERS & AUTH
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE org_members (
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    member_id UUID REFERENCES members(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',  -- owner, admin, member
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (org_id, member_id)
);

CREATE TABLE project_members (
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    member_id UUID REFERENCES members(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'member',  -- admin, member, viewer
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (project_id, member_id)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: LABELS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,  -- hex color
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(project_id, name)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: TASKS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Identity
    local_id TEXT NOT NULL,           -- "task-a7f3"
    
    -- Content
    title TEXT NOT NULL,
    description TEXT,
    acceptance_criteria JSONB,        -- [{text, checked}]
    
    -- Status & Assignment
    status TEXT DEFAULT 'todo',       -- todo, in-progress, done, custom...
    assignee_id UUID REFERENCES members(id),
    priority TEXT,                    -- low, medium, high, urgent
    due_date DATE,
    
    -- Metadata
    position INT DEFAULT 0,           -- For ordering in kanban
    version INT DEFAULT 1,            -- Optimistic locking
    
    created_by UUID REFERENCES members(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(project_id, local_id)
);

CREATE TABLE task_labels (
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    label_id UUID REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, label_id)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: DOCS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE docs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Identity
    local_id TEXT NOT NULL,           -- "doc-k8m2"
    
    -- Content
    title TEXT NOT NULL,
    content TEXT,                     -- Markdown
    folder TEXT,                      -- "architecture", "api"
    
    -- Metadata
    version INT DEFAULT 1,
    
    created_by UUID REFERENCES members(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(project_id, local_id)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: PLANS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Identity
    local_id TEXT NOT NULL,           -- "plan-x9y2"
    
    -- Content
    title TEXT NOT NULL,
    description TEXT,
    
    -- Timeline
    start_date DATE,
    end_date DATE,
    status TEXT DEFAULT 'active',     -- draft, active, completed
    
    -- Metadata
    version INT DEFAULT 1,
    
    created_by UUID REFERENCES members(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(project_id, local_id)
);

CREATE TABLE plan_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_date DATE,
    position INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE plan_tasks (
    plan_id UUID REFERENCES plans(id) ON DELETE CASCADE,
    task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
    milestone_id UUID REFERENCES plan_milestones(id),
    position INT DEFAULT 0,
    PRIMARY KEY (plan_id, task_id)
);

-- ═══════════════════════════════════════════════════════════════
--  CORE: COMMENTS
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Polymorphic reference
    entity_type TEXT NOT NULL,        -- 'task', 'doc', 'plan'
    entity_id UUID NOT NULL,
    
    -- Content
    content TEXT NOT NULL,
    
    -- Author
    author_id UUID REFERENCES members(id),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id);

-- ═══════════════════════════════════════════════════════════════
--  CORE: ACTIVITY LOG
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE activities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Who
    member_id UUID REFERENCES members(id),
    
    -- What
    action TEXT NOT NULL,             -- 'task.created', 'task.updated', etc.
    entity_type TEXT,
    entity_id UUID,
    
    -- Details
    metadata JSONB,                   -- {field: 'status', old: 'todo', new: 'done'}
    
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activities_project ON activities(project_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════
--  OPTIONAL: REPOS (CLI Integration)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE repos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    name TEXT NOT NULL,               -- "backend", "frontend"
    remote_url TEXT,                  -- github.com/xxx/backend
    sync_mode TEXT DEFAULT 'git-tracked',  -- 'git-tracked', 'git-ignored'
    
    last_sync_at TIMESTAMP,
    last_sync_by UUID REFERENCES members(id),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(project_id, name)
);

-- ═══════════════════════════════════════════════════════════════
--  OPTIONAL: REPO TASKS (CLI Integration)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE repo_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    
    -- Identity
    local_id TEXT NOT NULL,           -- "rtask-b2c4"
    
    -- Content (synced from .knowns/)
    title TEXT NOT NULL,
    description TEXT,
    acceptance_criteria JSONB,
    refs TEXT[],                      -- @doc/xxx, @task-xxx
    content_hash TEXT,                -- For change detection
    
    -- Metadata (Hub-owned)
    status TEXT DEFAULT 'todo',
    assignee_id UUID REFERENCES members(id),
    priority TEXT,
    
    -- Sync info
    synced_at TIMESTAMP,
    synced_by UUID REFERENCES members(id),
    
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    
    UNIQUE(repo_id, local_id)
);

-- ═══════════════════════════════════════════════════════════════
--  OPTIONAL: SYNC LOG (CLI Integration)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
    member_id UUID REFERENCES members(id),
    
    direction TEXT,                   -- 'push', 'pull'
    tasks_synced INT DEFAULT 0,
    docs_synced INT DEFAULT 0,
    conflicts JSONB,
    status TEXT,                      -- 'success', 'partial', 'failed'
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
--  OPTIONAL: CONFLICT LOG (CLI Integration)
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE conflict_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id UUID REFERENCES repos(id) ON DELETE CASCADE,
    
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    field TEXT NOT NULL,
    
    local_value TEXT,
    local_member_id UUID REFERENCES members(id),
    
    hub_value TEXT,
    hub_member_id UUID REFERENCES members(id),
    
    resolution TEXT,                  -- 'local', 'hub', 'merged'
    resolved_by UUID REFERENCES members(id),
    resolved_at TIMESTAMP,
    
    created_at TIMESTAMP DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
--  INDEXES
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX idx_tasks_status ON tasks(project_id, status);
CREATE INDEX idx_docs_project ON docs(project_id);
CREATE INDEX idx_plans_project ON plans(project_id);
CREATE INDEX idx_repo_tasks_repo ON repo_tasks(repo_id);
CREATE INDEX idx_repo_tasks_project ON repo_tasks(project_id);
```

---

## 8. API Design

### 8.1 Authentication

```
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/refresh
POST   /api/auth/logout
GET    /api/auth/me
```

### 8.2 Organizations

```
GET    /api/orgs
POST   /api/orgs
GET    /api/orgs/:slug
PATCH  /api/orgs/:slug
DELETE /api/orgs/:slug
POST   /api/orgs/:slug/invite
```

### 8.3 Projects

```
GET    /api/orgs/:org/projects
POST   /api/orgs/:org/projects
GET    /api/projects/:id
PATCH  /api/projects/:id
DELETE /api/projects/:id
GET    /api/projects/:id/members
POST   /api/projects/:id/members
```

### 8.4 Tasks

```
GET    /api/projects/:id/tasks
POST   /api/projects/:id/tasks
GET    /api/tasks/:id
PUT    /api/tasks/:id
PATCH  /api/tasks/:id              # Partial update
DELETE /api/tasks/:id
PATCH  /api/tasks/:id/move         # Reorder / change status
```

### 8.5 Labels

```
GET    /api/projects/:id/labels
POST   /api/projects/:id/labels
PATCH  /api/labels/:id
DELETE /api/labels/:id
```

### 8.6 Docs

```
GET    /api/projects/:id/docs
POST   /api/projects/:id/docs
GET    /api/docs/:id
PUT    /api/docs/:id
DELETE /api/docs/:id
```

### 8.7 Plans

```
GET    /api/projects/:id/plans
POST   /api/projects/:id/plans
GET    /api/plans/:id
PUT    /api/plans/:id
DELETE /api/plans/:id
POST   /api/plans/:id/tasks        # Link task
DELETE /api/plans/:id/tasks/:taskId
```

### 8.8 Comments

```
GET    /api/:entityType/:entityId/comments
POST   /api/:entityType/:entityId/comments
PUT    /api/comments/:id
DELETE /api/comments/:id
```

### 8.9 Activity

```
GET    /api/projects/:id/activities
```

### 8.10 Search

```
GET    /api/projects/:id/search?q=query
```

### 8.11 Repos (CLI Integration)

```
GET    /api/projects/:id/repos
POST   /api/projects/:id/repos
PATCH  /api/repos/:id
DELETE /api/repos/:id
```

### 8.12 Sync (CLI Integration)

```
POST   /api/repos/:id/sync/push
POST   /api/repos/:id/sync/pull
GET    /api/repos/:id/sync/status
```

### 8.13 SSE

```
WS     /api/ws/project/:projectId
```

Events:
- `task.created`, `task.updated`, `task.deleted`
- `doc.created`, `doc.updated`, `doc.deleted`
- `comment.created`
- `member.joined`

### 8.14 MCP Server

```
GET    /api/mcp/tools
POST   /api/mcp/execute
```

---

## 9. Tech Stack

### 9.1 Stack Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  KNOWNS HUB TECH STACK                                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Runtime:        Bun                                            │
│  Backend:        Hono                                           │
│  Database:       PostgreSQL                                     │
│  ORM:            Drizzle                                        │
│  Auth:           JWT + bcrypt                                   │
│  Validation:     Zod                                            │
│  Realtime:       SSE (Bun native)                         │
│                                                                 │
│  Frontend:       Nuxt 3 + Vue 3                                 │
│  UI:             Tailwind CSS + shadcn-vue                      │
│  State:          Pinia                                          │
│  Drag & Drop:    vue-draggable-plus                             │
│  Markdown:       @nuxt/content or markdown-it                 │
│                                                                 │
│  Deploy:         Docker / Docker Compose                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 9.2 Project Structure

```
knowns-hub/
├── apps/
│   ├── server/                     # Backend
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── orgs.ts
│   │   │   │   ├── projects.ts
│   │   │   │   ├── tasks.ts
│   │   │   │   ├── docs.ts
│   │   │   │   ├── plans.ts
│   │   │   │   ├── comments.ts
│   │   │   │   ├── repos.ts
│   │   │   │   └── sync.ts
│   │   │   ├── services/
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── sync.service.ts
│   │   │   │   └── activity.service.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts
│   │   │   │   └── error.ts
│   │   │   ├── db/
│   │   │   │   ├── index.ts
│   │   │   │   ├── schema.ts
│   │   │   │   └── migrations/
│   │   │   ├── ws/
│   │   │   │   └── handler.ts
│   │   │   └── mcp/
│   │   │       └── server.ts
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   │
│   └── web/                        # Frontend
│       ├── pages/
│       │   ├── index.vue
│       │   ├── login.vue
│       │   ├── register.vue
│       │   └── [org]/
│       │       └── [project]/
│       │           ├── index.vue   # Dashboard
│       │           ├── board.vue   # Kanban
│       │           ├── docs/
│       │           ├── plans/
│       │           └── settings/
│       ├── components/
│       │   ├── task/
│       │   ├── doc/
│       │   ├── plan/
│       │   └── ui/
│       ├── composables/
│       ├── stores/
│       ├── layouts/
│       └── package.json
│
├── packages/
│   └── shared/                     # Shared types
│       ├── types.ts
│       └── package.json
│
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── package.json
```

---

## 10. Development Roadmap

### Phase 1: Core Standalone (Week 1-3) ⭐

```
[ ] Project setup (Bun monorepo)
[ ] Database schema + migrations
[ ] Auth (register, login, JWT)
[ ] Organizations CRUD
[ ] Projects CRUD
[ ] Members & invites
[ ] Tasks CRUD
[ ] Kanban board (drag & drop)
[ ] Labels
[ ] Comments
```

### Phase 2: Docs & Plans (Week 4-5)

```
[ ] Docs CRUD
[ ] Markdown editor
[ ] Folder structure
[ ] Plans CRUD
[ ] Milestones
[ ] Plan-task linking
[ ] Progress tracking
```

### Phase 3: Polish & Realtime (Week 6-7)

```
[ ] Dashboard
[ ] Activity feed
[ ] Search
[ ] SSE real-time updates
[ ] Notifications
[ ] Dark mode
```

### Phase 4: CLI Integration (Week 8-9)

```
[ ] Repos CRUD
[ ] Sync API (push/pull)
[ ] Repo Tasks
[ ] Conflict resolution
[ ] Update knowns CLI
```

### Phase 5: Advanced (Week 10+)

```
[ ] MCP Server
[ ] Reports & analytics
[ ] Time tracking
[ ] Import from Trello
[ ] API documentation
[ ] Docker image
```

---

## 11. Deployment

### 11.1 Docker Compose

```yaml
# docker-compose.yml
version: '3.8'

services:
  hub:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/knowns_hub
      - JWT_SECRET=your-secret-key
    depends_on:
      - db

  db:
    image: postgres:16-alpine
    volumes:
      - postgres_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_DB=knowns_hub

volumes:
  postgres_data:
```

### 11.2 Quick Start

```bash
# Clone
git clone https://github.com/knowns-dev/knowns-hub
cd knowns-hub

# Start
docker-compose up -d

# Open
open http://localhost:3000
```

### 11.3 Environment Variables

```bash
# .env
DATABASE_URL=postgresql://user:pass@localhost:5432/knowns_hub
JWT_SECRET=your-super-secret-key
JWT_EXPIRES_IN=7d

# Optional
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
```

---

## 12. Summary

### What is Knowns Hub?

**Self-hosted Trello alternative** with:
- ✓ Kanban boards
- ✓ Wiki-like docs
- ✓ Plans & roadmaps
- ✓ Team collaboration
- ✓ Free & self-hosted

### Bonus Features (Optional)

- ✓ CLI integration (knowns)
- ✓ Git sync
- ✓ AI-ready (MCP Server)

### Key Decisions

| Decision | Choice |
|----------|--------|
| Primary mode | Standalone (Web UI only) |
| CLI | Optional enhancement |
| Task ID | Random 4-char (`task-a7f3`) |
| Tech stack | Bun + Hono + PostgreSQL + Nuxt |
| Deployment | Docker |
| Pricing | Free (self-hosted) |

### Target Market

1. **Primary**: Teams wanting a Trello alternative, self-hosted
2. **Secondary**: Dev teams wanting CLI + Git integration

---

*Document version: 2.0*
*Last updated: 2026-01-02*



---

## Update Notes (v0.8.0)

### Task ID Format Change

Task IDs have been updated from 4-character to 6-character random base36:

| Old Format | New Format |
|------------|------------|
| `task-a7f3` | `task-a7f3k9` |

- **Charset**: a-z, 0-9 (36 characters)
- **Combinations**: ~2.1 billion
- **Safe limit**: ~6,600 tasks per project
- **Backward compatible**: Legacy sequential IDs (`task-1`, `task-2`) still work

See @doc/features/id-strategy for details.
