---
id: doc-6b8a233e957b398d6c2721942165484e
title: 'Pattern: Self-Contained Action Dialog'
createdAt: '2026-03-05T05:31:55.137Z'
updatedAt: '2026-03-05T05:32:19.888Z'
description: >-
  Button component that owns its dialog state internally, avoiding state lifting
  to parent
tags:
  - pattern
  - react
  - ui
  - dialog
---
## Problem

When a button triggers a dialog (modal/sheet), the parent component often ends up managing the dialog's open/close state. This creates unnecessary state lifting, clutters the parent, and makes the button harder to reuse across different locations.

```tsx
// ❌ Parent manages dialog state — cluttered, hard to reuse
function ParentComponent() {
  const [dialogOpen, setDialogOpen] = useState(false);
  
  return (
    <>
      <Button onClick={() => setDialogOpen(true)}>Open</Button>
      <SomeDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
```

## Solution

Encapsulate both the trigger button and its dialog in a single component. The component owns its `open` state internally, making it a drop-in widget that parents don't need to coordinate.

```tsx
// ✅ Self-contained — parent just drops it in
function ParentComponent() {
  return <ActionButton taskId={id} />;
}
```

## Template

```tsx
import { useState } from "react";

interface ActionButtonProps {
  // Data props the dialog needs
  entityId: string;
  entityTitle?: string;
  // Optional: existing state that changes dialog behavior
  existingData?: SomeType | null;
}

export function ActionButton({ entityId, entityTitle, existingData }: ActionButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent parent click handlers (e.g., card click)
    setDialogOpen(true);
  };

  return (
    <>
      <button type="button" onClick={handleClick}>
        Trigger
      </button>

      <ActionDialog
        entityId={entityId}
        entityTitle={entityTitle || entityId}
        existingData={existingData}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
```

## Key Details

### 1. `e.stopPropagation()` is critical

When the button lives inside a clickable parent (e.g., a kanban card), you must stop event propagation to prevent the parent's click handler from firing.

### 2. Dialog receives controlled `open` + `onOpenChange`

The dialog component itself should accept `open` and `onOpenChange` props (standard Radix UI pattern). This keeps the dialog testable and allows it to be used in both self-contained and externally-controlled modes.

### 3. Pass data props through, not callbacks

The button passes entity data (IDs, titles) to the dialog. The dialog handles its own API calls and success/error toasts internally.

### 4. Conditional rendering via visibility, not mounting

Using Radix UI's `open` prop means the dialog is always in the DOM but hidden. This avoids re-mounting and losing internal state (form values, fetched data) when re-opened.

## Example: AssignToAIButton

```tsx
// src/ui/components/organisms/AssignToAIButton.tsx
export function AssignToAIButton({ taskId, taskTitle, existingWorkspace }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setDialogOpen(true); }}>
        <Bot className="w-3 h-3" /> AI
      </button>

      <AssignToAIDialog
        taskId={taskId}
        taskTitle={taskTitle || taskId}
        existingWorkspace={existingWorkspace}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
```

Used in: kanban cards, task detail sheet — same component, no state coordination needed.

## When to Use

| Scenario | Use This Pattern? |
|----------|-------------------|
| Button opens a dialog/modal | Yes |
| Button used in multiple locations | Yes |
| Dialog needs parent state after close | No — lift state up |
| Multiple buttons share one dialog | No — lift state up |
| Dialog triggered programmatically | No — use controlled mode |

## Source

@task-h95jl4, @task-wuwq4m (Vibe Kanban spec)
