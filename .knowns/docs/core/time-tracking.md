---
title: Time Tracking
createdAt: '2025-12-29T08:31:59.258Z'
updatedAt: '2025-12-29T08:32:18.901Z'
description: >-
  Documentation for the time tracking feature including CLI commands, Web UI
  integration, and data model specifications.
tags:
  - feature
  - time-tracking
  - reference
---
# Time Tracking

Knowns provides comprehensive time tracking capabilities for tasks through both CLI and Web UI.

## Data Model

### TimeEntry

Located in `src/models/task.ts`:

```typescript
interface TimeEntry {
  id: string;
  startedAt: Date;
  endedAt?: Date;      // undefined = timer running
  duration: number;    // Duration in SECONDS
  note?: string;
}
```

### Task Time Fields

```typescript
interface Task {
  timeSpent: number;      // Total seconds across all entries
  timeEntries: TimeEntry[];
}
```

> **IMPORTANT**: All duration values are stored in **SECONDS**, not milliseconds.

## CLI Commands

### Start Timer

```bash
knowns time start <task-id>
```

Creates a new TimeEntry with `startedAt` set and no `endedAt`.

### Stop Timer

```bash
knowns time stop
```

Sets `endedAt` and calculates `duration` for the active entry.

### Pause/Resume

```bash
knowns time pause
knowns time resume
```

### Check Status

```bash
knowns time status
```

### Add Manual Entry

```bash
knowns time add <task-id> <duration> [-n "note"] [-d "date"]
```

Duration formats: `30m`, `1h`, `1h30m`, `90m`

### Reports

```bash
# Default report
knowns time report

# Date range
knowns time report --from "2025-01-01" --to "2025-01-31"

# Group by label
knowns time report --by-label

# Export to CSV
knowns time report --csv > report.csv
```

## Web UI Integration

### TimeTracker Component

Located in `src/ui/components/TimeTracker.tsx`

Features:
- Real-time timer display (HH:MM:SS format)
- Start/Stop/Pause/Resume controls
- Manual time entry form (hours + minutes)
- Time log history with notes
- Total time spent summary

### Duration Formatting

The `formatDuration()` function converts seconds to human-readable format:

```typescript
formatDuration(seconds: number): string
// 3600 → "1h 0m"
// 1800 → "30m"
// 45   → "45s"
```

## Storage

Time entries are stored in `.knowns/time-entries.json`:

```json
{
  "21": [
    {
      "id": "te-1234567890",
      "startedAt": "2025-12-29T08:26:51.565Z",
      "endedAt": "2025-12-29T08:27:22.903Z",
      "duration": 24
    }
  ]
}
```

## Common Issues

### Duration Shows 0m in Web UI

**Cause**: Mismatch between seconds (CLI) and milliseconds (Web UI).

**Solution**: Ensure all duration calculations use seconds. See [removed [removed [removed ~task-55]]] for details.

## Related

- @docs/README - Project overview
- [removed [removed [removed ~task-55]]] - Bug fix for duration units
