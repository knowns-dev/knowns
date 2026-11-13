---
id: doc-9954f611c027768fb585112109d9b0ef
title: 'Pattern: Drag-Resize Panel'
createdAt: '2026-03-05T05:31:55.966Z'
updatedAt: '2026-03-05T05:32:39.065Z'
description: >-
  Mouse-driven resizable panel with min/max bounds, used for inline expandable
  UI sections
tags:
  - pattern
  - react
  - ui
  - interaction
---
## Problem

You need a panel (e.g., terminal output, preview pane) that users can resize by dragging an edge. CSS `resize` property is limited and inconsistent across browsers. Libraries like `react-resizable` add dependency weight for a simple interaction.

## Solution

Use `mousedown` → `mousemove` → `mouseup` event listeners with a ref to track drag state. Apply min/max bounds and set height via inline style.

## Template

```tsx
import { useCallback, useRef, useState } from "react";

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;

export function ResizablePanel({ children }: { children: React.ReactNode }) {
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startHeight: panelHeight };

      const handleDragMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Negative delta = dragging up = panel grows
        const delta = dragRef.current.startY - ev.clientY;
        const newHeight = Math.min(
          MAX_HEIGHT,
          Math.max(MIN_HEIGHT, dragRef.current.startHeight + delta),
        );
        setPanelHeight(newHeight);
      };

      const handleDragEnd = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", handleDragMove);
        document.removeEventListener("mouseup", handleDragEnd);
      };

      document.addEventListener("mousemove", handleDragMove);
      document.addEventListener("mouseup", handleDragEnd);
    },
    [panelHeight],
  );

  return (
    <div className="flex flex-col" style={{ height: panelHeight }}>
      {/* Drag handle — always at the resize edge */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-center h-2 cursor-ns-resize hover:bg-zinc-800 transition-colors"
      >
        <GripHorizontal className="w-4 h-4 text-zinc-700" />
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {children}
      </div>
    </div>
  );
}
```

## Key Details

### 1. Ref-based drag state, not React state

Using `useRef` for `startY`/`startHeight` avoids re-renders during the drag. Only `setPanelHeight` triggers renders (which is what we want — to update the visual height).

### 2. Document-level event listeners

Attach `mousemove`/`mouseup` to `document`, not the drag handle element. This ensures dragging continues even when the cursor leaves the handle area.

### 3. Cleanup on mouseup

Always remove both `mousemove` and `mouseup` listeners in the `handleDragEnd` callback to prevent memory leaks.

### 4. `e.preventDefault()` on mousedown

Prevents text selection during drag, which would cause janky behavior.

### 5. `min-h-0` on flex children

When using `flex-1` for content that scrolls, add `min-h-0` to allow the flex item to shrink below its content height. Without this, the panel won't respect the set height.

### 6. Delta direction

For a bottom-anchored panel (grows upward): `delta = startY - currentY` (positive when dragging up).
For a top-anchored panel (grows downward): `delta = currentY - startY`.

## Mobile Fallback

Drag-to-resize doesn't work well on touch devices. Use a fixed-height Sheet/bottom-sheet instead:

```tsx
if (isMobile) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="h-[70vh]">
        {children}
      </SheetContent>
    </Sheet>
  );
}

// Desktop: resizable panel
return <ResizablePanel>{children}</ResizablePanel>;
```

## Source

@task-6wmc0g (Vibe Kanban spec — InlineTerminalPanel)
