---
id: doc-05a73b393bd320c8f8da464f60539745
title: Git-Backed Shared Knowledge Store Sync
description: Specification for syncing tasks, docs, decisions, and project memory through a shared Git store repository that serves multiple code repositories, without writing any file into those repositories.
createdAt: '2026-09-09T11:29:21.682Z'
updatedAt: '2026-09-12T04:51:33.674Z'
tags:
  - spec
  - draft
  - review-required
  - sync
  - git
  - store
  - team
---

## Overview

Today a team shares Knowns knowledge only by committing `.knowns/` into the code repository. That couples knowledge to code review, forces knowledge into the branch model of the code, and means a teammate sees a new Task only after somebody remembers to commit and push it.

This spec introduces a **store repository**: an ordinary Git repository on GitHub, GitLab, or any Git host, holding the durable knowledge of one or more projects. A machine-level daemon keeps it synchronized in both directions in the background. The code repository is never touched.

One store repository serves many code repositories:

```
~/.knowns/stores/knowns-tasks/          clone of git@github.com:knowns-dev/knowns-tasks.git
├── .git
├── knowns/          tasks/ docs/ decisions/ memory/ templates/ config.json
├── knowns-hub/      tasks/ docs/ decisions/ memory/ templates/ config.json
└── website/         tasks/ docs/ decisions/ memory/ templates/ config.json

~/Workspaces/knowns/       <- no Knowns file at all
~/Workspaces/knowns-hub/   <- no Knowns file at all
~/Workspaces/website/      <- no Knowns file at all
```

The mapping from a code repository to its store directory lives in `~/.knowns/registry.json`, which already exists as the machine-level project registry.

This feature deliberately does not attempt coordination, contracts, or permission-by-actor-type. Those are the reasons Knowns Hub exists, and @doc/handoffs/hof-2026-08-24-hub-coordination-layer/brief.v2 states why Git cannot provide them. Shipping this narrows Hub's scope rather than replacing it.

## Locked Decisions

- **D1: Content scope.** The store carries `tasks/`, `docs/`, `decisions/`, `memory/`, `templates/`, and the team portion of project configuration defined by D13. It does not carry `.search/` (a rebuildable index), `history/` (append-only JSONL with a hash chain, kept Git-ignored by D3 of @doc/specs/2026-08-14/shared-task-doc-history-reconciliation), `time.json`, `time-entries.json`, `workspaces.json`, or `.server-port`. Global memory under `~/.knowns/memory` is personal and never enters a store.

- **D2: Conflict handling.** When Git cannot merge automatically, sync pauses for that project only. The local working state is preserved untouched, the conflict is surfaced, and the user settles it with an explicit resolve command. Sync for every other project continues. Knowns never silently overwrites newer state, consistent with D7 of @doc/specs/2026-08-14/shared-task-doc-history-reconciliation.

- **D3: Execution model.** All Git work runs inside the existing machine-level shared runtime, `knowns __runtime run`, which already holds one PID for the machine and already manages per-project watchers keyed by project root. No new daemon process is introduced. Local writes are committed after a 3 second debounce and pushed; remote changes are fetched on a 30 second interval. No user-facing Knowns command ever waits on the network. When the network is unavailable, commits still succeed locally and queue for a later push.

- **D4: Credentials.** Knowns never stores a credential. Push and fetch use the machine's existing `ssh-agent` or Git credential helper. The daemon runs with `GIT_TERMINAL_PROMPT=0` and SSH `BatchMode=yes` so a missing credential fails fast with an actionable message instead of hanging on an invisible prompt.

- **D5: Store location and linkage.** A store clone lives at `~/.knowns/stores/<store-name>/`, alongside the existing `global`, `memory`, `handoffs`, and `models` directories. Each project occupies one subdirectory. The code repository receives **zero** Knowns files: no `.knowns/`, no pointer file, no `.gitignore` entry, and no `.git/info/exclude` entry. The link is recorded per machine in `~/.knowns/registry.json` and established by `knowns link <store-remote>`.

- **D6: Agent delivery through hooks.** The existing `SessionStart` and `UserPromptSubmit` hooks report sync state to the agent. `SessionStart` may request an immediate fetch and wait for it, but only within a bounded budget, and must proceed regardless of the outcome. `UserPromptSubmit` performs no network operation of any kind and reads only local state, which the daemon already keeps current under D3. Both events report a paused store, because an agent working against knowledge that stopped syncing two days ago is the failure this feature must not introduce silently. These two events are chosen because they are the ones where `additionalContext` is reliable; the brief at @doc/handoffs/hof-2026-08-24-hub-coordination-layer/brief.v2 records open upstream defects on the others.

- **D7: Push is optimistic, safety comes from the remote.** The daemon does not fetch before pushing as a collision check. A pre-push fetch cannot close the window between the fetch and the push, whereas the remote's atomic non-fast-forward rejection closes it completely. Rejection triggers fetch, rebase, and retry, bounded. Force pushing is never used.

- **D8: Two conflict layers, kept separate.** A Git-level conflict is textual and belongs to the daemon, resolved under D2. A Knowns-level conflict is a stale expected hash and belongs to the mutation path, resolved by rereading and rewriting under D7 of @doc/specs/2026-08-14/shared-task-doc-history-reconciliation. The daemon must never create a third category by writing the working tree while a local mutation is in flight. The remaining window, between a caller's read and its write, is genuinely optimistic and correctly ends in a conflict error rather than a lost update.

- **D9: Two records, two jobs, neither replaces the other.** Git commits are the shared ledger: who changed what, when, across machines. Local JSONL history is the local record: field-level deltas such as `status: todo -> done` or `AC 3 checked`, restore, and the diff views the browser already serves. Git stores text diffs of files and cannot answer a field-level question without reparsing markdown, which is the defect family this project has already shipped twice. Because D1 excludes history from the store, each machine's JSONL history necessarily differs: it holds that machine's own changes plus one coalesced revision per entity for anything that arrived through sync. That divergence is accepted, not a defect. History is not removed, not synced, and not treated as redundant with Git.

- **D10: Docs are already serialised, and the daemon joins that lock.** An earlier draft of this spec claimed Docs had no mutation lock, from reading `DocStore` alone. That was wrong. Every Doc write goes through `MutateDocWithHistory` or `DeleteDocWithExpectedHash`, both under `Store.withDocMutationLocks` in `internal/storage/mutation_transaction.go`, and nothing outside `internal/storage` writes through `DocStore` directly. No new lock is needed: the daemon acquires `withDocMutationLocks` for a Doc like any other writer, which is what makes D8 hold for Docs and AC-19 passable.

- **D11: UI notification is process-local and separate from reconciliation.** Verified: the knowledge watcher runs inside `knowns __runtime run`, while SSE lives in the browser server, and these are different processes. The server gains its own lightweight watcher whose only job is to emit SSE for entities that changed on disk. It does not reconcile, does not write history, and does not index; that remains the runtime's watcher under the lease model of D1 of @doc/specs/2026-08-14/shared-task-doc-history-reconciliation. No new inter-process protocol is introduced, because a notification-only watcher is cheaper than a protocol and cannot desynchronise from the filesystem it reads.

- **D12: The registry accepts a project that has no local `.knowns/`.** Verified: `Registry.Add` currently rejects any path lacking `.knowns/config.json`, which would reject exactly the projects D5 creates. Validity becomes: a local `.knowns/` with a config, **or** a store mapping resolving to an initialized store directory. Every existing consumer of that invariant is updated with it rather than after it.

- **D13: Configuration stays JSON, is split by owner, and has exactly one writer format.** Reproduced on two simulated machines with the real binary on 2026-09-11: syncing today's `config.json` as one unit fails three ways. `defaultAssignee` propagates silently, so every Task a teammate creates is assigned to whoever last pushed the file, because `internal/cli/task.go` applies it on create with no warning. Opening `knowns browser` rewrites the file with no user action through `savePortToConfig`, so two machines on different ports produce a textual conflict that pauses the whole project under D2. And `ConfigStore.Save` serialises a struct in declaration order while `ConfigStore.Set` serialises a map in sorted order, so every alternation between them rewrites nearly every line and makes any concurrent edit conflict. The format is not the cause: the same experiment with `gopkg.in/yaml.v3` showed identical order drift and additionally destroyed every comment, so JSON is kept, consistent with every other configuration and state file Knowns writes. Configuration is split by owner. Team policy (`statuses`, `statusColors`, `visibleColumns`, `defaultPriority`, `taskLifecycle`, project identity) stays in the store and syncs. Personal settings (`defaultAssignee`, `platforms`) move to `~/.knowns/settings.json`. Machine state (`serverPort`, detected `lsp` languages) moves to this project's entry in `~/.knowns/registry.json`. Browser startup writes no configuration at all, since `.knowns/.server-port` already serves discovery. Every writer of the team file emits one canonical JSON form with a fixed key order, so identical content always produces identical bytes.

- **D14: A file that disappears and returns unchanged is not a deletion.** Observed on this spec itself on 2026-09-10: a `git stash -u` removed three untracked Docs for a few seconds, the watcher recorded tombstones after the quiet window, and when the files returned byte-identical, ordinary reconciliation compared hashes, found them equal, and recorded nothing. History then asserted deletion while the files lived, and every later write failed with `Doc canonical hash mismatch`. For a Doc whose last revision was section-scoped, the tombstone checkpoint was also written without its content, because `replaySnapshot` reuses a display snapshot from which section-scoped revisions deliberately drop content. The repair `reactivateTombstonedEntity` exists and is tested for Tasks, but `FilesystemReconciler.Restore` has no production caller. Under this feature Git removes and restores files routinely during pull, rebase, and checkout, so this must be closed before sync ships: lifecycle snapshots carry full state, the watcher reactivates a tombstoned entity automatically when its file reappears carrying exactly the tombstoned hash, and a user-facing command exposes `Restore` for every other case. Tracked in @task-KN-00TYF2.

## System Decision Impact

- Impact: **draft new**
- Decision: to be created before implementation begins. It records the durable change that a project's knowledge store may live outside the project directory, and that `Store.Root` and `Store.ProjectRoot` are independent values rather than one derived from the other.
- Acceptance gate: the draft is not accepted until AC-7 and AC-11 pass, proving that no code-intelligence, LSP, template, sync, or validation path resolves the project root from the store path.

## Requirements

### Functional Requirements

- **FR-1:** `knowns link <store-remote> [--as <project>]`, run inside a code repository, clones the store into `~/.knowns/stores/<store-name>/` when it is not already present, creates or adopts the project subdirectory, and records the mapping in `~/.knowns/registry.json`. `<project>` defaults to the basename of the current directory.

- **FR-2:** Store resolution is changed at **every** entry point that resolves a project today, not only one. Those are: the walk-up in `storage.FindProjectRoot`, the `--project` flag and `KNOWNS_PROJECT` environment variable in `internal/cli/mcp.go`, `autoDetectProject` in `internal/mcp/server.go`, and the registry lookups the browser performs in `internal/cli/browser.go`. Each consults the registry mapping for the nearest enclosing registered project path. When no mapping exists, each falls back to its current behaviour, so existing projects keep working unchanged.

- **FR-3:** `Store` carries `Root` (where knowledge lives) and `ProjectRoot` (where code lives) as independent fields. Every caller that today computes `filepath.Dir(store.Root)` reads `store.ProjectRoot` instead. There are 18 such non-test call sites.

- **FR-4:** `registry.Project` gains a store mapping field. Registry files written before this change load unchanged and are treated as projects with no mapping.

- **FR-5:** `Registry.Add` accepts a path that has no local `.knowns/` when a store mapping is supplied and that mapping resolves to an initialized store directory, per D12. A path with neither remains an error, with a message that names both ways to make it valid.

- **FR-6:** `Registry.Scan` continues to discover projects that have a local `.knowns/`, and does not report a store-linked project as undiscovered or broken. Discovery of store-linked projects is by `knowns link` only, and any surface offering a scan says so rather than implying the list is complete.

- **FR-7:** The daemon commits and pushes local changes within the D1 content scope after the D3 debounce, and fetches and fast-forwards remote changes on the D3 interval, for every project in the registry that has a store mapping.

- **FR-8:** The daemon pushes optimistically and reacts to rejection, per D7. On rejection it fetches, rebases local commits onto the remote, and pushes again, for at most three attempts before pausing the project. `--force` and `--force-with-lease` are never used on any path.

- **FR-9:** On a rebase conflict the daemon aborts the rebase, leaves the working tree at the local state, marks that project paused, and records the conflicting paths.

- **FR-10:** The daemon serialises its Doc writes through the existing `Store.withDocMutationLocks`, per D10. No new lock is introduced; every Doc write path already acquires it.

- **FR-11:** Before modifying any file in the store working tree, whether by fetch, fast-forward, rebase, or checkout, the daemon acquires the same entity lock that the corresponding mutation path acquires, including the Doc lock from FR-10. It never observes or produces a partially written entity, and a local mutation in progress delays the daemon rather than racing it.

- **FR-12:** When a mutation fails because its expected hash is stale and the current state arrived through sync, the failure is returned on the surface the caller used, at the moment of the failed write: an MCP tool error for an MCP caller, a non-zero exit with a message on stderr for a CLI caller, and an inline error on the affected field for a browser caller. It never surfaces only in a log or only in `knowns store status`.

- **FR-13:** That failure names the Git author, the time the change arrived, that the source was sync, and the recovery action, which is to reread the entity and reapply the change. It does not report only the two hash values. An agent must be able to recover from the error text alone, without a second diagnostic call, and the text must not suggest overwriting.

- **FR-14:** `knowns sync --resolve` lists paused projects and their conflicting entities, shows the local and remote versions of each, and applies the user's choice per entity before resuming sync for that project.

- **FR-15:** `knowns store status` reports, per project: store name, project subdirectory, last successful push, last successful fetch, queued commit count, and pause reason when paused.

- **FR-16:** When the network is unreachable, commits continue to succeed and accumulate locally. On reconnect the daemon pushes the accumulated commits in one operation.

- **FR-17:** When a credential is missing or rejected, the daemon pauses that store with a message naming the remote and the credential mechanism it attempted. It never prompts and never blocks.

- **FR-18:** `knowns link --migrate` moves an existing in-repo `.knowns/` into the store, preserving Git history of the store repository, and records the mapping. It reports what it excluded per D1 and leaves the code repository's own Git state unchanged.

- **FR-19:** A machine may link different projects to different store repositories simultaneously. Store-level pause, credential failure, and conflict state are isolated per store.

- **FR-20:** After a fetch introduces changed entities, the local search index is refreshed for exactly those entities through the existing `indexIntent` callback on `FilesystemReconciler`, reusing the bulk-change path defined by D6 of @doc/specs/2026-08-14/shared-task-doc-history-reconciliation rather than adding a parallel route.

- **FR-21:** `knowns store unlink` removes the mapping for the current project and leaves both the store clone and the code repository intact.

- **FR-22:** The `SessionStart` hook requests an immediate fetch for the current project's store and waits for completion within a bounded budget, default 500 milliseconds and configurable. When the budget expires, the fetch continues in the daemon and the hook proceeds with whatever state is already local. The hook never fails the session.

- **FR-23:** Both hooks report a change delta for the current project: entities created, updated, or deleted since the last reported point by an author other than this machine. Authorship is the Git commit author of the commit that carried the change, compared against the Git identity configured for the store clone on this machine. No Knowns-level author concept is introduced. `SessionStart` reports since the previous session; `UserPromptSubmit` reports only what is new since the last report in this session, so an unchanged store adds nothing to the prompt.

- **FR-24:** Both hooks report a paused store, naming the project, the pause cause, and how long it has been paused. This report is not suppressed by the FR-23 deduplication, because a stale store stays wrong until someone acts on it.

- **FR-25:** The `UserPromptSubmit` hook performs no network operation. Its entire cost is reading local files that the daemon has already updated.

- **FR-26:** The browser server runs a notification-only watcher over the store, per D11, and broadcasts an SSE event for every entity that changes on disk regardless of which process wrote it. It does not reconcile, write history, or index. Entities the server writes itself continue to broadcast exactly as they do today, without double-broadcasting.

- **FR-27:** The browser surfaces sync state persistently, not as a transient toast: which store a project belongs to, when it last synced, and whether it is paused with the cause. A person reading a board must be able to tell that the board stopped updating two days ago.

- **FR-28:** The browser renders both records described by D9 for a Task or Doc: local field-level revisions from JSONL, and shared commits from Git with their authors. The two are presented as distinct sources rather than interleaved into one list that implies a single ledger.

- **FR-29:** Conflict resolution is available in the browser as a side-by-side view of the local and remote versions per entity, applying the same resolution semantics as `knowns sync --resolve`. Neither surface is authoritative over the other, and a conflict settled on one surface is reflected on the other.

### Non-Functional Requirements

- **NFR-1:** No Knowns command that reads or writes knowledge performs a network operation on its own behalf. Command latency is unchanged from today whether the network is fast, slow, or absent.

- **NFR-2:** The daemon never writes a credential, token, or password to disk, and never emits one into a log line or an error message.

- **NFR-3:** No conflict path may discard local content. Every resolution route either keeps the local version, keeps the remote version by explicit user choice, or keeps both.

- **NFR-4:** After `knowns link`, the code repository's working tree and Git index are byte-identical to their state before the command ran.

- **NFR-5:** The daemon's steady-state cost for an idle project is one `git fetch` per interval per store, not per project.

- **NFR-6:** Hook cost is bounded and fails open. `UserPromptSubmit` adds no network time at all. `SessionStart` adds at most the FR-14 budget, and an unreachable remote, an unauthenticated store, or a stopped daemon degrades the report rather than the session.

## Acceptance Criteria

- [ ] **AC-1:** After `knowns link <remote>` in a clean code repository, `git status --porcelain` in that repository produces no output, and no file or directory named `.knowns`, `.knowns-store.json`, or similar exists in its working tree. `.git/info/exclude` is also unchanged.
- [ ] **AC-2:** A Task created on machine A is readable by `knowns task list` on machine B within 60 seconds, with no command run on either machine beyond the create.
- [ ] **AC-3:** With the network disabled, `knowns task create` succeeds and returns. After the network is restored, the Task reaches the remote without any user command.
- [ ] **AC-4:** When machine A and machine B change the same line of the same Task and both push, machine B reports a conflict for that project, the Task file on machine B still holds B's content, and a second project linked to the same store continues to sync.
- [ ] **AC-5:** With `SSH_AUTH_SOCK` unset and no credential helper configured, the daemon pauses the store within one interval and prints a message naming the remote. The process does not hang and no prompt appears.
- [ ] **AC-6:** After a full sync cycle, no file whose content originated in `~/.knowns/memory` exists anywhere in the store clone.
- [ ] **AC-7:** With a project linked to a store, a code-intelligence query resolves file paths against the code repository. A file that exists only in the store directory is not reachable as a project file, and a file that exists only in the code repository is.
- [ ] **AC-8:** With three code repositories linked to one store, a single fetch cycle makes changes from all three visible locally.
- [ ] **AC-9:** `knowns link --migrate` on a project with a committed in-repo `.knowns/` leaves the code repository's `HEAD` and index unchanged, and the migrated Tasks and Docs are readable afterwards with identical IDs.
- [ ] **AC-10:** `knowns store status` distinguishes a healthy project, a project paused by conflict, and a store paused by credential failure, and names the cause for each paused entry.
- [ ] **AC-11:** A repository-wide search for `filepath.Dir(store.Root)` and its variants returns no non-test call site.
- [ ] **AC-12:** A project with an in-repo `.knowns/` and no registry mapping behaves exactly as it does today, with no daemon involvement. Its history, restore, and browser diff views are unchanged.
- [ ] **AC-13:** With the remote routed to a black hole so every connection hangs, `SessionStart` completes within the FR-22 budget plus a fixed overhead, and the session proceeds normally. Measured across ten starts, no start exceeds the budget by more than 100 milliseconds.
- [ ] **AC-14:** After a teammate changes exactly three Tasks and one Doc, the next `SessionStart` on this machine reports exactly those four entities and no others. Entities changed by this machine's own Git identity are not reported.
- [ ] **AC-15:** With a store paused for any reason, every `UserPromptSubmit` carries the paused warning naming the project and cause, and continues to carry it until the pause is resolved. In the same session with a healthy store and no remote changes, `UserPromptSubmit` adds nothing.
- [ ] **AC-16:** With the daemon stopped and the network unreachable, timing `UserPromptSubmit` across fifty invocations shows no invocation attributable to network wait, verified by the absence of any socket call in a system-call trace.
- [ ] **AC-17:** When machine B's push is rejected as non-fast-forward for a change that does not textually conflict, B fetches, rebases, and pushes without user involvement, and both A's and B's changes are present on the remote afterwards. A trace of the daemon's Git invocations for that cycle contains no `--force` or `--force-with-lease`.
- [ ] **AC-18:** When a push is rejected three times in a row because a third machine keeps winning the race, the project pauses with a reason naming push contention rather than retrying indefinitely.
- [ ] **AC-19:** Running a fetch that changes an entity concurrently with a thousand local mutations of that same entity produces no torn read and no torn write: every mutation either succeeds completely or fails with a conflict, and the entity parses correctly after every single operation.
- [ ] **AC-20:** When a Doc is changed by a teammate and then written locally with a stale expected hash, an MCP caller receives a tool error, a CLI caller receives a non-zero exit with a stderr message, and a browser caller receives an inline error on the field. All three name the Git author, the arrival time, sync as the source, and rereading as the recovery. None contains only the two hash values, and none suggests forcing the write.
- [ ] **AC-21:** An agent that receives the AC-20 error and follows only the instruction in its text succeeds on the next attempt without any additional diagnostic call.
- [ ] **AC-22:** With a board open and untouched in the browser, a Task changed on another machine appears in its new column within one fetch interval plus one second, with no page refresh and no user interaction.
- [ ] **AC-23:** With a project paused, the store state is visible on the browser page itself without opening a menu or a terminal, and it names the cause and the age of the pause.
- [ ] **AC-24:** The history view of a Task changed both locally and by a teammate shows the local field-level revisions and the shared Git commits, each labelled with its source. A reader can tell which changes came from this machine and which arrived through sync.
- [ ] **AC-25:** A conflict settled in the browser is reflected by `knowns store status` on the command line without any further action, and a conflict settled by `knowns sync --resolve` clears in an open browser tab over SSE.
- [ ] **AC-26:** `knowns link` on a code repository with no `.knowns/` succeeds and the project appears in `knowns store status`. Running it on a path with neither a local `.knowns/` nor a store mapping fails with a message naming both ways to make it valid.
- [ ] **AC-27:** A `registry.json` written before this feature loads without modification, and its projects continue to resolve exactly as they do today.
- [ ] **AC-28:** Every Doc write path, the daemon's included, acquires `withDocMutationLocks`. A test that writes one Doc from many goroutines while a fetch rewrites the same file leaves the Doc parseable after every operation, and a repository-wide check finds no Doc write that reaches the filesystem without holding the lock.
- [ ] **AC-29:** Resolving the same project through the walk-up, through `KNOWNS_PROJECT`, through `--project`, and through the browser's registry lookup yields the same store root and the same project root. A project with a store mapping resolves identically on all four.
- [ ] **AC-30:** A Task changed by the browser server itself broadcasts exactly one SSE event, not two, despite the notification watcher of FR-26 also observing the file.

## Scenarios

### Scenario 1: Linking the first project

**Given** a developer has a code repository at `~/Workspaces/knowns` with no Knowns store, and an empty repository at `git@github.com:knowns-dev/knowns-tasks.git`
**When** they run `knowns link git@github.com:knowns-dev/knowns-tasks.git`
**Then** the store is cloned to `~/.knowns/stores/knowns-tasks/`, the subdirectory `knowns/` is created and initialized, `~/.knowns/registry.json` records the mapping, and `git status` in the code repository shows no change

### Scenario 2: A second developer joins

**Given** the store repository already contains the `knowns/` subdirectory with Tasks and Docs, and a developer has just cloned the code repository
**When** they run `knowns link git@github.com:knowns-dev/knowns-tasks.git`
**Then** the store is cloned, the existing `knowns/` subdirectory is adopted rather than recreated, and `knowns task list` immediately shows the team's existing Tasks

### Scenario 3: A change propagates without anyone committing

**Given** machine A and machine B are both linked to the same store and both daemons are running
**When** a developer on machine A runs `knowns task edit KN-42 -s done`
**Then** machine A commits and pushes within the debounce window, machine B fetches within the interval, and `knowns task KN-42` on machine B reports status `done` without any command having been run on B

### Scenario 4: Two people change the same Task

**Given** machine A sets `KN-42` to `done` and machine B sets the same field to `blocked`, and A pushes first
**When** machine B's daemon attempts to rebase and Git reports a conflict
**Then** the rebase is aborted, `KN-42` on machine B still reads `blocked`, the project is marked paused with `KN-42` named as the conflicting entity, and any other project on machine B linked to the same store keeps syncing

### Scenario 5: Working offline

**Given** a developer is on a plane with no network and the daemon is running
**When** they create four Tasks and edit two Docs
**Then** every command returns at normal speed, the changes are committed locally, `knowns store status` reports a queued commit count, and on reconnect all commits push in one operation

### Scenario 6: Credential missing on a fresh machine

**Given** a machine with a linked store but no SSH key loaded and no credential helper configured
**When** the daemon attempts its first push
**Then** the push fails without prompting, the store is marked paused naming the remote and the attempted mechanism, local commits continue to accumulate, and no Knowns command blocks

### Scenario 7: Migrating a project that already tracks .knowns in code

**Given** a code repository whose `.knowns/` is committed and shared through code review
**When** the developer runs `knowns link <remote> --migrate`
**Then** the content within the D1 scope is copied into the store subdirectory, the excluded paths are reported, the mapping is recorded, and the code repository's `HEAD`, index, and working tree are unchanged so the team can remove the old directory as a normal reviewed commit when they choose

### Scenario 8: Two stores with different audiences

**Given** `knowns` and `knowns-hub` are linked to a public team store, and `client-portal` is linked to a private store with a restricted member list
**When** the private store's credential expires
**Then** `client-portal` pauses, the public store keeps syncing for both other projects, and `knowns store status` attributes the pause to the private store

### Scenario 9: Store repository reachable but project subdirectory absent

**Given** a developer runs `knowns link <remote> --as backend` and the store contains no `backend/` subdirectory
**When** the command runs
**Then** it reports that it is creating a new project subdirectory rather than adopting an existing one, and requires confirmation before initializing, so a typo in `--as` does not silently create a second empty project

### Scenario 10: Daemon is not running

**Given** a linked project whose daemon has been stopped
**When** the developer runs `knowns task create`
**Then** the Task is created and committed to the store working tree normally, `knowns store status` reports the daemon as not running along with the queued commit count, and nothing is lost when the daemon restarts

### Scenario 11: An agent session opens after teammates worked overnight

**Given** three Tasks and one Doc were changed by other members since this developer's last session
**When** the developer starts an agent session in the linked code repository
**Then** `SessionStart` requests a fetch, waits at most the budget, and reports those four entities to the agent as changed by others, so the agent's first response is grounded in the current state rather than yesterday's

### Scenario 12: The store has been paused for two days

**Given** sync paused on Monday because of an unresolved conflict, and the developer did not notice
**When** they start a session on Wednesday and send several prompts
**Then** `SessionStart` and every `UserPromptSubmit` report the paused project, its cause, and that it has been paused for two days, and the report keeps appearing until the pause is resolved rather than being deduplicated away

### Scenario 13: A teammate changes the Doc an agent is editing

**Given** an agent read a Doc at the start of its turn, and while it was composing the edit the daemon fetched a version of that same Doc changed by a teammate
**When** the agent submits the update with its now-stale expected hash
**Then** the MCP call returns an error naming the teammate, when the change arrived, that it came from sync, and that the fix is to reread and reapply, and the agent recovers on its next attempt without asking the user and without forcing the write

### Scenario 14: A fetch lands while a write is in progress

**Given** a local process is midway through writing a Task file
**When** the daemon's fetch interval fires and the fetch would change that same Task
**Then** the daemon waits on the same entity lock the write holds, applies its change only after the write completes, and no reader at any point observes a partially written Task

### Scenario 15: A board is open while a teammate works

**Given** a developer has the kanban board open in `knowns browser` and is not touching the keyboard
**When** a teammate moves two Tasks to `in-progress` and the daemon fetches those changes
**Then** the open board updates over SSE without a refresh, exactly as it would if those Tasks had been changed locally

### Scenario 16: Reading the history of a Task that both machines changed

**Given** a Task whose status was changed locally twice and by a teammate once
**When** the developer opens its history in the browser
**Then** the local field-level revisions and the shared Git commits are both shown, labelled as separate sources, and the teammate's change is attributed to them rather than appearing as an unexplained bulk revision

### Scenario 17: The board has been stale for two days

**Given** a project paused on Monday and a developer who works entirely in the browser and never opens a terminal
**When** they open the board on Wednesday
**Then** the sync state is visible on the page itself, naming the pause and its age, so the staleness is discovered by reading rather than by noticing that nothing has moved

## Technical Notes

The following were verified against the source before this spec was approved, not assumed. Each either grants a component to reuse or corrects an assumption an earlier draft had made.

**Confirmed available for reuse:**

- `knowns __runtime run` is already a machine-level daemon with one PID at `RuntimeRoot()/knowns-runtime.pid`, and `reconcileWatchers` in `internal/runtimequeue/runtimequeue.go` already manages watchers keyed by project root for many projects at once. D3 needs no new process.
- `FilesystemReconciler` already accepts an `indexIntent` callback and invokes it per `ReconcileResult` in `internal/storage/reconciler.go`. FR-20 has a real hook.
- `StartKnowledgeWatcher` in `internal/cli/watch.go` feeds `ReconcileLifecycleBatchWithOptions` with `Source: "watcher"`. A Git fetch is a form of external file change, which is what that path exists to absorb.
- `internal/registry/registry.go` already maintains `~/.knowns/registry.json` as the machine-level project list. The store mapping is a field on the existing entry, not a new file.
- `internal/gitauth/url.go` already implements host-allowlisted credential handling for GitHub, GitLab, and Bitbucket, and refuses plaintext HTTP.

**Corrected assumptions, each now carrying a Locked Decision:**

- An earlier draft claimed Docs had no mutation lock. They do: Doc writes go through `MutateDocWithHistory` or `DeleteDocWithExpectedHash` under `Store.withDocMutationLocks`, and the daemon joins that lock. See D10 and FR-10.
- The browser server does not watch the filesystem. It contains no `fsnotify` usage and no reconciler, and it is a different process from the runtime that does. SSE fires only from its own route handlers. See D11 and FR-26.
- `Registry.Add` rejects any path without `.knowns/config.json`, which is exactly the shape D5 produces. See D12 and FR-5.
- Project resolution has at least five entry points, not one. See FR-2.

**Two hazards to carry into implementation:**

- `internal/safepath/path.go` resolves symlinks on both the root and the candidate when validating a path. A store outside the project directory is a legitimate root, not an escape, and must not be rejected as one.
- History records carry a hash chain, and this project has twice shipped defects where a writer and a verifier disagreed about the byte representation of the same record. FR-20 must not compute a second representation of a record that already has one.

FR-3 is a mechanical refactor but it must be complete. A resolver with no call sites passes its own tests and changes nothing, which is why AC-11 asserts the absence of the old derivation rather than the presence of the new field.

## Task Generation

- Task Prefix: GST

## Task Links

Generated tasks will be linked here after `/kn-plan --from @doc/specs/2026-09-09/git-backed-shared-knowledge-store-sync` runs.

## Open Questions

- [ ] Is the command `knowns link` as proposed, or `knowns store link` for symmetry with `knowns store status` and `knowns store unlink`?
- [ ] Should the store repository have a retention policy? Tasks and Docs accumulate indefinitely, and a store serving ten projects for two years is a repository nobody prunes.
- [ ] When a code repository already has a team-committed `.knowns/` and one developer migrates while others have not, what does the un-migrated developer see? Scenario 7 leaves the old directory in place deliberately, but the transition window is not specified.
- [ ] Is 500 milliseconds the right `SessionStart` budget? It is long enough for a warm fetch on a fast link and short enough to be unnoticeable, but it is a guess until measured against a real remote over a VPN.
- [ ] **Is there any state that should not be shared the moment it is written?** Under D3 a half-written Task, an unfinished plan, and a mid-thought note all reach the team within three seconds. Today `.knowns/` is effectively private until someone commits, and that pause is where drafts get cleaned up. This spec removes the pause without replacing it. Either that is accepted as the point of the feature, or the model needs a notion of work that is local until released, which nothing in D1 through D7 currently provides.
- [ ] Tasks and Docs stop being tied to a code branch. Today a Task created on a feature branch disappears with that branch; afterwards it outlives it. This is mostly an improvement, but a team that uses branch lifetime as implicit Task cleanup will notice the change.
