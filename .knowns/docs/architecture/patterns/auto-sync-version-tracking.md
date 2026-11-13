---
id: doc-ab201531df7c06a00d79929f04754b38
title: Auto-Sync Version Tracking
description: Pattern for automatically syncing skills when CLI version changes
createdAt: '2026-02-24T07:31:11.375Z'
updatedAt: '2026-04-24T14:35:58.882Z'
tags: []
---

# Auto-Sync Version Tracking

Pattern for automatically syncing skills when CLI version changes.

---

## Problem

When CLI is upgraded (brew upgrade, npm update, or manual install), users need to manually run `knowns sync` to get updated skills. This is easy to forget, leading to stale skills.

## Solution

Track synced version per platform directory. On any command, compare with current CLI version and auto-sync if different.

---

## Implementation

### Version File

Each platform directory contains `.version`:

```
.claude/skills/.version
.agents/skills/.version
```

**Format:**
```json
{
  "cliVersion": "0.11.3",
  "syncedAt": "2026-02-24T07:18:07.960Z"
}
```

### Check Flow

```
User runs any command
       |
findProjectRoot()
       |
For each platform in [".claude/skills", ".agents/skills"]:
  - Skip if directory doesn't exist
  - Read .version file
  - Compare cliVersion with current
       |
Version mismatch?
       |
  Yes -> syncSkillsToDir()
      -> writeVersionFile()
       |
Continue with original command
```

### Code Location

**File:** `internal/sync/autosync.go`

```go
var platforms = []struct {
    ID  string
    Dir string
}{
    {ID: "claude", Dir: ".claude/skills"},
    {ID: "agent-compatible", Dir: ".agents/skills"},
}

func CheckAndAutoSync(cliVersion string) (synced bool, message string) {
    projectRoot := findProjectRoot()
    if projectRoot == "" {
        return false, ""
    }

    for _, platform := range platforms {
        syncedInfo := getSyncedVersion(projectRoot, platform.Dir)
        needsSync := syncedInfo == nil || syncedInfo.CLIVersion != cliVersion

        if needsSync {
            syncSkillsToDir(filepath.Join(projectRoot, platform.Dir))
            writeSyncedVersion(projectRoot, platform.Dir, cliVersion)
        }
    }
    return true, ""
}
```

**Called from:** `cmd/root.go` (before command execution via Cobra's `PersistentPreRun`)

```go
synced, msg := sync.CheckAndAutoSync(version.Version)
if synced && msg != "" {
    fmt.Println(msg)
}
```

---

## Behavior

| Scenario | Action |
|----------|--------|
| CLI upgraded | Auto-sync, show message |
| First time (no .version) | Auto-sync, show message |
| .version deleted | Auto-sync, show message |
| Same version | Skip silently |
| Directory doesn't exist | Skip silently |

### Output

```
Auto-synced 10 skills for claude, agent-compatible (0.11.2 -> 0.11.3)
```

---

## Key Design Decisions

### 1. Per-Directory Version

Each platform has its own `.version` file instead of a global one:
- Platforms can be added/removed independently
- Partial init is supported (only some platforms)

### 2. Directory Existence Check

Only sync if directory exists:
- `knowns init` creates directories
- Won't create directories on auto-sync
- Respects user's platform choices

### 3. Silent Fail

Auto-sync failures don't block command execution:
```go
func CheckAndAutoSync(cliVersion string) (synced bool, message string) {
    defer func() {
        if r := recover(); r != nil {
            synced = false // Silent fail
        }
    }()
    // sync logic
}
```

### 4. Deprecated Cleanup

Auto-sync also removes old skill formats:
- `knowns.*` folders -> removed
- `kn:*` folders -> removed

---

## Related

- @doc/ai/skills - Skills system overview
- @doc/ai/platforms - Platform configurations
- @doc/features/init-process - Init wizard flow
