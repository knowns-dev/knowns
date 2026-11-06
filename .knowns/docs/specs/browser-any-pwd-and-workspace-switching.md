---
id: doc-6df1230eddc2640a35d99645d69fad56
title: browser-any-pwd-and-workspace-switching
description: Specification for browser any-pwd launch, welcome page, and reliable workspace switching
createdAt: '2026-04-10T04:08:06.995Z'
updatedAt: '2026-04-10T04:11:07.153Z'
tags:
  - spec,draft,browser,workspace
---

## Overview

Fix and complete the browser startup and workspace switching experience so `knowns browser` works reliably from any current working directory and the app can switch projects at runtime without stale data.

This spec extends prior standalone browser launch work from @task-mrcs1u and closes the remaining gaps: picker/welcome experience when no project is active, project persistence in `~/.knowns/`, and immediate whole-app project switching.

Related refs: @task-mrcs1u, @task-akyubi, @doc/specs/knowns-hub-mode

## Locked Decisions

- D1: When `knowns browser` starts from a valid project, it saves that project path in `~/.knowns/`.
- D2: When the current working directory is not a valid project and saved projects exist, the app shows a Welcome page.
- D3: The Welcome page offers actions to choose a saved project, scan for more projects, and initialize the current folder.
- D4: Selecting a saved project switches immediately into that project in the same browser session.
- D5: If no saved projects exist, the Welcome page shows an empty saved-project list plus scan and initialize actions.
- D6: Switching projects updates the entire app immediately: tasks, docs, config, chat, graph, and all other project-scoped views.
- D7: The Welcome page auto-scans on load, and manual scan remains available.

## Requirements

### Functional Requirements

- FR-1: `knowns browser` must start successfully from any current working directory, including directories that are not part of a Knowns project.
- FR-2: When browser startup resolves a valid project from the current directory, that project path must be persisted under `~/.knowns/` as a known project for later reopening and switching.
- FR-3: When no valid project is active at startup but known projects exist in `~/.knowns/`, the UI must show a Welcome page instead of failing or showing stale project content.
- FR-4: The Welcome page must list saved projects from `~/.knowns/` and allow the user to select one.
- FR-5: Selecting a saved project from the Welcome page must switch the active project immediately within the same browser session.
- FR-6: The Welcome page must expose actions to scan for more projects and initialize the current folder as a new project.
- FR-7: The Welcome page must auto-scan for projects on load and also allow the user to trigger scanning manually.
- FR-8: If there are no saved projects, the Welcome page must still render successfully with an empty state plus scan and initialize actions.
- FR-9: Switching projects from the workspace picker while already inside the app must update the active project for all project-scoped APIs and views in the same session.
- FR-10: After a successful project switch, subsequent requests for tasks, docs, config, chat, graph, search, templates, memory, and related project data must resolve against the newly active project, not the original startup project.
- FR-11: The system must preserve existing behaviors for `--project`, `--scan`, cwd discovery, and last-active fallback.

### Non-Functional Requirements

- NFR-1: Browser startup in no-project mode must not panic, crash, or require a page reload before the user can select or initialize a project.
- NFR-2: Project switching must be consistent across the session: no page may continue reading stale project data after a successful switch.
- NFR-3: Welcome-page behavior must degrade gracefully when scanning finds no projects or when saved projects are unavailable.
- NFR-4: Existing standalone launch and workspace-switch flows must remain covered by automated tests.

## Acceptance Criteria

- [ ] AC-1: Running `knowns browser` from a directory without `.knowns/config.json` opens the app successfully instead of failing.
- [ ] AC-2: If startup occurs from a valid Knowns project, that project is recorded in `~/.knowns/` and appears as a saved project later.
- [ ] AC-3: If startup occurs outside a valid project and saved projects exist, the first screen is a Welcome page showing those saved projects.
- [ ] AC-4: If startup occurs outside a valid project and no saved projects exist, the Welcome page shows an empty saved-project state plus scan and initialize actions.
- [ ] AC-5: The Welcome page automatically performs project scanning on load and also exposes a manual scan action.
- [ ] AC-6: Choosing a saved project from the Welcome page switches immediately into that project in the same session and loads that project’s data.
- [ ] AC-7: Switching projects from the workspace picker updates tasks, docs, config, chat, graph, and other project-scoped views without requiring a restart or full browser reload.
- [ ] AC-8: After switching from project A to project B, project-scoped API responses come from project B rather than continuing to use project A.
- [ ] AC-9: Existing `knowns browser --project`, `knowns browser --scan`, cwd discovery, and last-active fallback behaviors still work.
- [ ] AC-10: Automated tests cover no-project startup, welcome-page state selection, and runtime workspace switching against the active store.

## Scenarios

### Scenario 1: Startup inside a valid project
**Given** the user runs `knowns browser` inside a folder that belongs to a valid Knowns project
**When** the browser server starts
**Then** the app opens that project normally
**And** the project path is saved in `~/.knowns/` for future selection

### Scenario 2: Startup outside a project with saved projects available
**Given** the user runs `knowns browser` in a folder without a valid Knowns project
**And** `~/.knowns/` already contains saved projects
**When** the app loads
**Then** it shows a Welcome page listing the saved projects
**And** it auto-scans for additional projects
**And** it offers actions to scan manually and initialize the current folder

### Scenario 3: Startup outside a project with no saved projects
**Given** the user runs `knowns browser` in a folder without a valid Knowns project
**And** `~/.knowns/` contains no saved projects
**When** the app loads
**Then** it shows a Welcome page with an empty saved-project list
**And** it still offers scan and initialize-current-folder actions

### Scenario 4: Select a saved project from the Welcome page
**Given** the Welcome page is visible with one or more saved projects
**When** the user selects a saved project
**Then** the app switches immediately to that project in the same session
**And** subsequent project-scoped pages load data from the selected project

### Scenario 5: Switch workspaces from inside the app
**Given** the user is already inside the app on project A
**When** the user switches to project B from the workspace picker
**Then** the entire app session updates to project B
**And** tasks, docs, config, chat, graph, search, and related project-scoped views stop reading from project A

## Technical Notes

- Prior work already added standalone browser startup fallback and picker mode in @task-mrcs1u, but current runtime switching remains incomplete because request handlers are still wired to the initial store instead of resolving the active store after a switch.
- The current UI also eagerly requests config during startup, which must be nil-safe in no-project mode so the Welcome page can render.
- This feature should treat startup resolution, saved-project persistence, welcome-state rendering, and runtime active-store routing as one coherent browser behavior.
- If implementation requires a separate saved-project registry format or API surface for welcome-state bootstrap, that may be planned during implementation as long as the locked behavior and ACs remain unchanged.

## Open Questions

- [ ] Should the Welcome page show extra metadata for saved projects beyond path/name/last used?
- [ ] Should initialize-current-folder launch the full init wizard inline, redirect to an init flow, or trigger a backend command?
