---
title: React Error Boundary Pattern
createdAt: '2026-02-24T08:27:07.958Z'
updatedAt: '2026-02-24T08:27:07.958Z'
description: Pattern for catching and handling React render errors gracefully
tags:
  - pattern
  - react
  - error-handling
  - ui
---
# React Error Boundary Pattern

> Pattern for catching render errors in React components to prevent white/black screens.

## Problem

When a React component throws during render, the entire component tree unmounts, showing a blank screen. This is especially problematic for:
- Markdown rendering (malformed content)
- User-generated content
- Third-party component integration

## Solution

Use React Error Boundaries (class components) to catch errors and show a fallback UI.

## Implementation

### Error Boundary Component

```typescript
import { Component, type ReactNode, type ErrorInfo } from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Render error:", error, errorInfo);
    // Optional: Send to error tracking service
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="error-container">
            <p>Something went wrong.</p>
            <button onClick={this.handleReset}>Try again</button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
```

### Usage

```tsx
// Wrap risky components
<ErrorBoundary>
  <MarkdownRenderer content={userContent} />
</ErrorBoundary>

// With custom fallback
<ErrorBoundary
  fallback={<div>Content failed to load</div>}
  onReset={() => refetchContent()}
>
  <ThirdPartyComponent />
</ErrorBoundary>
```

### Real-World Example: MDRender

```tsx
// src/ui/components/editor/MDRender.tsx
class MarkdownErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  // ... standard error boundary methods ...

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 rounded-lg border border-red-500/30 bg-red-500/10">
          <div className="flex items-center gap-2 text-red-600 dark:text-red-400 mb-2">
            <AlertTriangle className="w-4 h-4" />
            <span className="font-medium">Failed to render markdown</span>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            {this.state.error?.message || "An error occurred"}
          </p>
          <button onClick={this.handleReset} className="btn-secondary">
            <RefreshCw className="w-3.5 h-3.5" />
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Usage in MDRender
const MDRender = forwardRef(({ markdown, ...props }, ref) => {
  return (
    <div ref={containerRef}>
      <MarkdownErrorBoundary>
        <MDEditor.Markdown source={markdown} />
      </MarkdownErrorBoundary>
    </div>
  );
});
```

## Key Points

1. **Must be class component** - `getDerivedStateFromError` and `componentDidCatch` are not available in hooks
2. **Catches render errors only** - Does not catch errors in event handlers, async code, or server-side rendering
3. **Granular boundaries** - Wrap specific risky components, not entire app
4. **Reset capability** - Allow users to retry without full page reload
5. **Log errors** - Use `componentDidCatch` to track issues

## When to Use

| Use Case | Example |
|----------|---------|
| User-generated content | Markdown, HTML, rich text |
| Third-party components | Chart libraries, editors |
| Dynamic imports | Code splitting boundaries |
| Data-dependent rendering | Complex visualizations |

## Source

> Implemented in @task-d5l46c to fix black screen on markdown render errors
