---
title: Shadcn UI Conventions
createdAt: '2025-12-29T09:20:49.101Z'
updatedAt: '2025-12-29T09:22:43.297Z'
description: Guidelines and conventions for using shadcn/ui components in the project
tags:
  - ui
  - conventions
  - shadcn
  - frontend
---
## Project Configuration

- **Style**: New York
- **Base Color**: Neutral  
- **CSS Variables**: Enabled
- **Config File**: components.json

## Directory Structure

- `src/ui/components/ui/` - Shadcn primitives (auto-generated)
- `src/ui/components/atoms/` - Basic building blocks
- `src/ui/components/molecules/` - Composed atoms
- `src/ui/components/organisms/` - Complex components
- `src/ui/components/templates/` - Page layouts

## Semantic Color Tokens

### DO: Use semantic tokens
- `bg-background`, `text-foreground`
- `bg-card`, `text-card-foreground`
- `bg-muted`, `text-muted-foreground`
- `bg-primary`, `text-primary-foreground`
- `border-border`, `ring-ring`

### DON'T: Hardcode colors
- Avoid: `bg-gray-700`, `text-gray-500`
- Avoid: `isDark ? 'bg-gray-800' : 'bg-white'`

## Dark Mode

Let CSS variables handle theming automatically.
DON'T use manual `isDark` checks for styling.

## CVA for Variants

Use class-variance-authority for component variants.
See atoms/Badge.tsx for reference implementation.

## Adding Components

```bash
bunx shadcn@latest add card
bunx shadcn@latest add badge
```
