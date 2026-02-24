---
title: Auto-Sync Version Tracking
createdAt: '2026-02-24T07:31:11.375Z'
updatedAt: '2026-02-24T07:31:35.471Z'
description: Pattern for automatically syncing skills when CLI version changes
tags:
  - pattern
  - auto-sync
  - skills
  - versioning
---
# Auto-Sync Version Tracking

Pattern for automatically syncing skills when CLI version changes.

---

## Problem

When CLI is upgraded (npm update, brew upgrade), users need to manually run `knowns sync` to get updated skills. This is easy to forget, leading to stale skills.

## Solution

Track synced version per platform directory. On any command, compare with current CLI version and auto-sync if different.

---

## Implementation

### Version File

Each platform directory contains `.version`:

```
.claude/skills/.version
.agent/skills/.version
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
       ↓
findProjectRoot()
       ↓
For each platform in [".claude/skills", ".agent/skills"]:
  - Skip if directory doesn't exist
  - Read .version file
  - Compare cliVersion with current
       ↓
Version mismatch?
       ↓
  Yes → syncSkillsToDir()
      → writeVersionFile()
       ↓
Continue with original command
```

### Code Location

**File:** `src/utils/auto-sync.ts`

```typescript
const PLATFORMS = [
  { id: "claude", dir: ".claude/skills" },
  { id: "antigravity", dir: ".agent/skills" },
] as const;

export function checkAndAutoSync(cliVersion: string): {
  synced: boolean;
  message?: string;
} {
  const projectRoot = findProjectRoot();
  if (!projectRoot) return { synced: false };
  
  for (const platform of PLATFORMS) {
    const syncedInfo = getSyncedVersion(projectRoot, platform.dir);
    const needsSync = !syncedInfo || syncedInfo.cliVersion !== cliVersion;
    
    if (needsSync) {
      syncSkillsToDir(join(projectRoot, platform.dir));
      writeSyncedVersion(projectRoot, platform.dir, cliVersion);
    }
  }
}
```

**Called from:** `src/index.ts` (before command execution)

```typescript
const autoSyncResult = checkAndAutoSync(packageJson.version);
if (autoSyncResult.synced && autoSyncResult.message) {
  console.log(chalk.cyan(autoSyncResult.message));
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
✓ Auto-synced 10 skills for claude, antigravity (0.11.2 → 0.11.3)
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
```typescript
try {
  // sync logic
} catch {
  return { synced: false }; // Silent fail
}
```

### 4. Deprecated Cleanup

Auto-sync also removes old skill formats:
- `knowns.*` folders → removed
- `kn:*` folders → removed

---

## Related

- @doc/ai/skills - Skills system overview
- @doc/ai/platforms - Platform configurations
- @doc/architecture/features/init-process - Init wizard flow
