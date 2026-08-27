---
id: 20260827-1559-skill-materialization-scope-is-a-project-setting-not-an-implicit-default
title: Skill materialization scope is a project setting, not an implicit default
status: draft
supersedes: []
supersededBy: []
tags:
  - cli
  - sync
  - skills
  - config
  - workflow
sources:
  - internal/models/config.go
  - internal/cli/sync.go
  - internal/cli/setup_global.go
  - internal/codegen/skill_sync.go
  - internal/cli/sync_skills_scope_test.go
  - internal/storage/embedding_settings_store.go
  - ~/.knowns/settings.json
relatedDocs: []
relatedTasks:
  - or6x99
verification: []
reviewState: needs_evidence
reviewBlockers:
  - 'linked task "or6x99" is "in-review"; all linked tasks must be done before accepting decision "20260827-1559-skill-materialization-scope-is-a-project-setting-not-an-implicit-default"'
reviewMatches: []
reviewAllowedResolutions: []
reviewEvaluatedAt: '2026-08-27T09:08:17.057Z'
createdAt: '2026-08-27T08:59:00.591Z'
updatedAt: '2026-08-27T09:08:17.057Z'
---

## Context

`knowns sync` used to materialize built-in skills into project directories unconditionally. `SyncSkillsForPlatforms` picked targets from `settings.platforms` and called `os.MkdirAll` on each, never asking whether the directory existed or whether the user had installed skills globally instead. Combined with `force := true` in `runSync`, a user who installed globally could not get rid of the project copy: deleting it only lasted until the next sync, and the project copy takes precedence over `~/.claude/skills`, so sync silently overrode their configuration.

Every other part of the product already knew about global skills. `syncGlobalSkills` writes to `~/.claude/skills`, `~/.kiro/skills`, and `~/.agents/skills`; `codegen.GlobalStaleSkillDirs` exists; doctor wires it in as `globalSkills` and reports on it. `StaleSkillDirs`, in the same file as the bug, states the right principle for reads: "Directories that do not exist are skipped: a platform that was never synced is not stale, it is simply absent."

The reason sync could not honour any of that: `internal/models/config.go` had no skills setting at all. `setup --global` had nowhere to record its choice, and sync reconciles from config.json.

## Decision

Where skills are materialized is a recorded project setting, `settings.skillsScope`, with values `project`, `global`, and `none`. An unset value resolves to `project`, so existing projects and fresh clones are unaffected.

`knowns sync` reads that setting and routes accordingly. It never infers scope from what happens to be on disk, and it never creates a directory the setting did not ask for.

The general rule this instance establishes: a command that generates files must record the intent behind them in config, because `sync` reconciles from config and will otherwise undo the choice. Generating without recording creates a second write surface that has to be reconciled by hand, which is the same defect pattern found in the doc corpus.

## Alternatives Considered

Add a `--global` flag to sync, mirroring `setup --global`. Rejected: a flag is not remembered, so the next bare `knowns sync` reintroduces the bug. The missing thing was persisted intent, not a one-shot switch.

Only write to skill directories that already exist, mirroring the principle in `StaleSkillDirs`. Rejected on its own: it fixes the reported case but breaks the documented clone path, where `git clone` followed by `knowns sync` must produce skills that were never there before.

Infer the scope by detecting whether a global install exists. Rejected: implicit and surprising, and it makes the outcome depend on machine state rather than on what the project declared.

## Consequences

`ProjectSettings.SkillsScope` is added with `NormalizeSkillsScope` and `SkillsScopeOrDefault`; `Normalize` rejects an unknown value. `runSyncSkillsForScope` in `internal/cli/sync.go` dispatches. `recordGlobalSkillsScope` in `internal/cli/setup_global.go` persists the scope after a successful global setup. Four tests in `internal/cli/sync_skills_scope_test.go`; 546 tests pass across the touched packages.

Still open: `init` does not ask for the scope, and `doctor` does not warn when a project copy and a global copy both exist, which is exactly the state that produced the original report.

This does not resolve the wider `setup` versus `sync` overlap. `setup` still generates files on the platform axis without persisting `settings.platforms`, which is the same class of defect one level up.
