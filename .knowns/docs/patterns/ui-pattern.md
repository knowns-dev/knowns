---
title: UI Pattern
createdAt: '2025-12-29T07:05:40.711Z'
updatedAt: '2025-12-29T08:14:07.599Z'
description: Documentation for React + Radix UI web interface architecture
tags:
  - architecture
  - patterns
  - ui
  - react
---
## Overview

Knowns Web UI uses React 19 + Radix UI (shadcn/ui) + TailwindCSS 4 to build a Kanban board and task management interface. The component architecture follows **Atomic Design** principles for better maintainability and reusability.

## Location

```
src/ui/
├── App.tsx                # Root component
├── main.tsx               # React entry point
├── index.css              # TailwindCSS styles
├── api/
│   └── client.ts          # API + WebSocket client
├── components/
│   ├── atoms/             # Basic UI elements
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Badge.tsx
│   │   ├── Avatar.tsx
│   │   ├── Spinner.tsx
│   │   └── Icon.tsx
│   ├── molecules/         # Simple component groups
│   │   ├── FormField.tsx
│   │   ├── SearchInput.tsx
│   │   ├── StatusBadge.tsx
│   │   ├── PriorityBadge.tsx
│   │   ├── LabelList.tsx
│   │   └── UserSelect.tsx
│   ├── organisms/         # Complex components
│   │   ├── TaskCard.tsx
│   │   ├── TaskCreateForm.tsx
│   │   ├── TaskDetailModal.tsx
│   │   ├── Board.tsx
│   │   ├── Column.tsx
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   └── TimeTracker.tsx
│   ├── templates/         # Page layouts
│   │   ├── MainLayout.tsx
│   │   ├── BoardLayout.tsx
│   │   └── SettingsLayout.tsx
│   └── ui/                # Radix UI primitives (shadcn/ui)
│       ├── button.tsx
│       ├── dialog.tsx
│       ├── input.tsx
│       └── ...
├── pages/                 # Actual pages
│   ├── KanbanPage.tsx
│   ├── TasksPage.tsx
│   ├── DocsPage.tsx
│   └── ConfigPage.tsx
├── contexts/
│   └── UserContext.tsx
├── hooks/
│   └── use-mobile.tsx
└── lib/
    └── utils.ts
```

## Atomic Design Architecture

Atomic Design breaks UI into 5 levels, from smallest to largest:

```
┌─────────────────────────────────────────────────────────────┐
│                         PAGES                                │
│   KanbanPage, TasksPage, DocsPage, ConfigPage               │
├─────────────────────────────────────────────────────────────┤
│                       TEMPLATES                              │
│   MainLayout, BoardLayout, SettingsLayout                   │
├─────────────────────────────────────────────────────────────┤
│                       ORGANISMS                              │
│   TaskCard, TaskCreateForm, Board, Column, Header           │
├─────────────────────────────────────────────────────────────┤
│                       MOLECULES                              │
│   FormField, SearchInput, StatusBadge, PriorityBadge        │
├─────────────────────────────────────────────────────────────┤
│                         ATOMS                                │
│   Button, Input, Badge, Avatar, Spinner, Icon               │
└─────────────────────────────────────────────────────────────┘
```

### 1. Atoms

The smallest, indivisible UI elements. These are basic building blocks that can't be broken down further.

```tsx
// components/atoms/Button.tsx
interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}

export function Button({ variant = "primary", size = "md", loading, children, onClick }: ButtonProps) {
  return (
    <button
      className={cn(
        "rounded-md font-medium transition-colors",
        variants[variant],
        sizes[size],
        loading && "opacity-50 cursor-not-allowed"
      )}
      onClick={onClick}
      disabled={loading}
    >
      {loading ? <Spinner size="sm" /> : children}
    </button>
  );
}
```

```tsx
// components/atoms/Badge.tsx
interface BadgeProps {
  variant?: "default" | "success" | "warning" | "error";
  children: React.ReactNode;
}

export function Badge({ variant = "default", children }: BadgeProps) {
  return (
    <span className={cn("px-2 py-0.5 text-xs rounded-full", variants[variant])}>
      {children}
    </span>
  );
}
```

```tsx
// components/atoms/Avatar.tsx
interface AvatarProps {
  name: string;
  size?: "sm" | "md" | "lg";
  src?: string;
}

export function Avatar({ name, size = "md", src }: AvatarProps) {
  const initials = name.slice(0, 2).toUpperCase();

  return (
    <div className={cn("rounded-full bg-primary flex items-center justify-center", sizes[size])}>
      {src ? (
        <img src={src} alt={name} className="rounded-full" />
      ) : (
        <span className="text-primary-foreground font-medium">{initials}</span>
      )}
    </div>
  );
}
```

### 2. Molecules

Simple groups of atoms that function together as a unit.

```tsx
// components/molecules/FormField.tsx
interface FormFieldProps {
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}

export function FormField({ label, error, required, children }: FormFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">
        {label}
        {required && <span className="text-destructive ml-1">*</span>}
      </label>
      {children}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
```

```tsx
// components/molecules/StatusBadge.tsx
import { Badge } from "../atoms/Badge";

interface StatusBadgeProps {
  status: "todo" | "in-progress" | "in-review" | "done";
}

const statusConfig = {
  "todo": { label: "To Do", variant: "default" },
  "in-progress": { label: "In Progress", variant: "warning" },
  "in-review": { label: "In Review", variant: "info" },
  "done": { label: "Done", variant: "success" },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const config = statusConfig[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}
```

```tsx
// components/molecules/PriorityBadge.tsx
import { Badge } from "../atoms/Badge";
import { Icon } from "../atoms/Icon";

interface PriorityBadgeProps {
  priority: "low" | "medium" | "high";
}

export function PriorityBadge({ priority }: PriorityBadgeProps) {
  const icons = { low: "arrow-down", medium: "minus", high: "arrow-up" };
  const colors = { low: "text-blue-500", medium: "text-yellow-500", high: "text-red-500" };

  return (
    <Badge variant="outline" className={colors[priority]}>
      <Icon name={icons[priority]} size="sm" />
      <span className="ml-1 capitalize">{priority}</span>
    </Badge>
  );
}
```

```tsx
// components/molecules/SearchInput.tsx
import { Input } from "../atoms/Input";
import { Icon } from "../atoms/Icon";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchInput({ value, onChange, placeholder = "Search..." }: SearchInputProps) {
  return (
    <div className="relative">
      <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pl-10"
      />
    </div>
  );
}
```

### 3. Organisms

Complex components composed of molecules and atoms. These are distinct sections of the UI.

```tsx
// components/organisms/TaskCard.tsx
import { Avatar } from "../atoms/Avatar";
import { StatusBadge } from "../molecules/StatusBadge";
import { PriorityBadge } from "../molecules/PriorityBadge";
import { LabelList } from "../molecules/LabelList";

interface TaskCardProps {
  task: Task;
  onClick?: () => void;
}

export function TaskCard({ task, onClick }: TaskCardProps) {
  const handleDragStart = (e: DragEvent) => {
    e.dataTransfer.setData("taskId", task.id);
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={onClick}
      className="bg-card p-3 rounded-md shadow-sm cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <span className="text-sm text-muted-foreground">#{task.id}</span>
        <PriorityBadge priority={task.priority} />
      </div>

      <h4 className="font-medium mt-1">{task.title}</h4>

      {task.labels.length > 0 && (
        <LabelList labels={task.labels} className="mt-2" />
      )}

      <div className="flex items-center justify-between mt-3">
        {task.assignee && <Avatar name={task.assignee} size="sm" />}
        <StatusBadge status={task.status} />
      </div>
    </div>
  );
}
```

```tsx
// components/organisms/Column.tsx
import { TaskCard } from "./TaskCard";
import { StatusBadge } from "../molecules/StatusBadge";

interface ColumnProps {
  status: string;
  tasks: Task[];
  onDrop: (taskId: string, status: string) => void;
}

export function Column({ status, tasks, onDrop }: ColumnProps) {
  const handleDragOver = (e: DragEvent) => e.preventDefault();

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData("taskId");
    onDrop(taskId, status);
  };

  return (
    <div
      className="flex-shrink-0 w-80 bg-muted rounded-lg p-4"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <h3 className="font-semibold mb-4 flex items-center gap-2">
        <StatusBadge status={status} />
        <span className="text-muted-foreground">({tasks.length})</span>
      </h3>

      <div className="space-y-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
```

```tsx
// components/organisms/Header.tsx
import { Avatar } from "../atoms/Avatar";
import { Button } from "../atoms/Button";
import { SearchInput } from "../molecules/SearchInput";

interface HeaderProps {
  user: User | null;
  onSearch: (query: string) => void;
  onCreateTask: () => void;
}

export function Header({ user, onSearch, onCreateTask }: HeaderProps) {
  const [searchQuery, setSearchQuery] = useState("");

  return (
    <header className="h-16 border-b bg-card px-4 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Knowns</h1>
        <SearchInput
          value={searchQuery}
          onChange={(value) => {
            setSearchQuery(value);
            onSearch(value);
          }}
        />
      </div>

      <div className="flex items-center gap-4">
        <Button onClick={onCreateTask}>New Task</Button>
        {user && <Avatar name={user.name} />}
      </div>
    </header>
  );
}
```

### 4. Templates

Page-level layouts that define the structure without specific content.

```tsx
// components/templates/MainLayout.tsx
import { Header } from "../organisms/Header";
import { Sidebar } from "../organisms/Sidebar";

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="flex">
        <Sidebar />
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
```

```tsx
// components/templates/BoardLayout.tsx
interface BoardLayoutProps {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function BoardLayout({ title, actions, children }: BoardLayoutProps) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">{title}</h2>
        {actions}
      </div>
      <div className="flex-1 overflow-x-auto">{children}</div>
    </div>
  );
}
```

### 5. Pages

Complete views that combine templates with real data.

```tsx
// pages/KanbanPage.tsx
import { MainLayout } from "../components/templates/MainLayout";
import { BoardLayout } from "../components/templates/BoardLayout";
import { Board } from "../components/organisms/Board";
import { Button } from "../components/atoms/Button";

interface KanbanPageProps {
  tasks: Task[];
  statuses: string[];
}

export function KanbanPage({ tasks, statuses }: KanbanPageProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  return (
    <MainLayout>
      <BoardLayout
        title="Kanban Board"
        actions={
          <Button onClick={() => setIsCreateOpen(true)}>
            New Task
          </Button>
        }
      >
        <Board tasks={tasks} statuses={statuses} />
      </BoardLayout>

      <TaskCreateModal open={isCreateOpen} onOpenChange={setIsCreateOpen} />
    </MainLayout>
  );
}
```

## Component Composition Rules

### Import Direction

Components should only import from lower levels:

```
Pages      → Templates, Organisms, Molecules, Atoms
Templates  → Organisms, Molecules, Atoms
Organisms  → Molecules, Atoms
Molecules  → Atoms
Atoms      → (no component imports, only utils/hooks)
```

### Naming Conventions

| Level | Naming Pattern | Examples |
|-------|---------------|----------|
| Atoms | Single word, describes element | `Button`, `Input`, `Badge` |
| Molecules | Compound name, describes function | `FormField`, `SearchInput`, `StatusBadge` |
| Organisms | Compound name, describes section | `TaskCard`, `Header`, `Sidebar` |
| Templates | Suffix with "Layout" | `MainLayout`, `BoardLayout` |
| Pages | Suffix with "Page" | `KanbanPage`, `TasksPage` |

### File Organization

```
components/
├── atoms/
│   ├── index.ts          # Export all atoms
│   ├── Button.tsx
│   ├── Button.test.tsx   # Co-located tests
│   └── Button.stories.tsx # Storybook (optional)
├── molecules/
│   ├── index.ts
│   └── ...
└── organisms/
    ├── index.ts
    └── ...
```

## State Management

### Pattern: Hooks + Context (Minimal)

```tsx
// App-level state via useState
const [tasks, setTasks] = useState<Task[]>([]);
const [project, setProject] = useState<Project | null>(null);

// User context for auth
export const UserContext = createContext<UserContextType>({
  user: null,
  setUser: () => {},
});

// Theme context
export const ThemeContext = createContext<ThemeContextType>({
  isDark: false,
  toggle: () => {},
});
```

### Custom Hooks

```tsx
// hooks/use-mobile.tsx
export function useMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return isMobile;
}
```

## Styling with TailwindCSS

### Using cn() utility

```tsx
import { cn } from "@/lib/utils";

function Button({ variant, className, ...props }) {
  return (
    <button
      className={cn(
        "px-4 py-2 rounded-md",           // Base styles
        variant === "primary" && "bg-primary text-primary-foreground",
        variant === "ghost" && "bg-transparent hover:bg-muted",
        className                          // Allow override
      )}
      {...props}
    />
  );
}
```

### Dark Mode Support

```tsx
function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() =>
    localStorage.theme === "dark" ||
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
    localStorage.theme = isDark ? "dark" : "light";
  }, [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, toggle: () => setIsDark(!isDark) }}>
      {children}
    </ThemeContext.Provider>
  );
}
```

## Benefits of Atomic Design

| Benefit | Description |
|---------|-------------|
| **Reusability** | Atoms and molecules can be reused across many organisms/pages |
| **Consistency** | Same building blocks ensure consistent UI |
| **Maintainability** | Small, focused files are easier to understand and modify |
| **Testability** | Each level can be tested in isolation |
| **Scalability** | Easy to add new components at any level |
| **Documentation** | Clear hierarchy makes onboarding easier |
| **Design System** | Natural structure for a component library |

## When to Create New Components

| Question | If Yes → |
|----------|----------|
| Is it a basic HTML element with styling? | Create Atom |
| Does it combine 2-3 atoms for a specific function? | Create Molecule |
| Is it a distinct UI section with business logic? | Create Organism |
| Does it define page structure without content? | Create Template |
| Does it render a complete view with data? | Create Page |

## Related Docs

- @doc/patterns/server-pattern - Express Server Pattern
- @doc/patterns/storage-pattern - File-Based Storage Pattern
