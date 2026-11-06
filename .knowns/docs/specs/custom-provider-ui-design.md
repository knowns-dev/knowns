---
id: doc-b5d49020ac82c32304b24bd5bb8f09b1
title: Custom Provider UI Design
description: Research and UI design for adding custom OpenAI-compatible providers from the web UI
createdAt: '2026-03-27T21:29:38.953Z'
updatedAt: '2026-04-06T07:03:44.651Z'
tags:
  - spec
  - approved
  - ui
  - provider
  - opencode
---

# Custom Provider UI

## Overview

Add a "Custom Provider" form to the existing `ProviderConnectDialog`, allowing users to register any OpenAI-compatible provider directly from the web UI — without manually editing `opencode.json`.

The form collects provider ID, display name, base URL, models, optional headers, and optional API key, then calls `PATCH /config` + `PUT /auth/{id}` + `POST /global/dispose` to register and activate the provider.

## Locked Decisions

- D1: **Add + Delete only** — users can add custom providers and fully remove them. No inline editing; to change config, delete and re-add.
- D2: **Manual provider ID** — user types the ID directly, validated as lowercase alphanumeric + hyphens, checked against existing provider IDs for duplicates.
- D3: **Hardcode npm package** — always use `@ai-sdk/openai-compatible`. No npm field shown in the form.

## Requirements

### Functional Requirements

- FR-1: Add a "Custom Provider" entry point at the bottom of the provider list in `ProviderConnectDialog`
- FR-2: Clicking the entry point opens a `CustomProviderStepView` form within the existing multi-step dialog
- FR-3: Form collects: Provider ID, Display Name, Base URL, Models (id + name, ≥1), Headers (optional key-value pairs), API Key (optional)
- FR-4: Provider ID is validated: non-empty, lowercase alphanumeric + hyphens only, no conflict with existing provider IDs
- FR-5: Base URL is validated: must start with `http://` or `https://`
- FR-6: At least one model (id + name) is required
- FR-7: Submitting the form sends `PATCH /config` with the provider config structure
- FR-8: If API key is provided, `PUT /auth/{id}` is called to store credentials
- FR-9: After config is saved, `POST /global/dispose` reloads OpenCode and `refreshAll()` updates the provider list
- FR-10: Custom providers can be deleted via the existing disconnect flow (`DELETE /auth/{id}`) — same as built-in providers
- FR-11: Headers section is collapsed by default, shown when user clicks "Add header"
- FR-12: Multiple models can be added via "Add another model" button

### Non-Functional Requirements

- NFR-1: Form follows existing Notion-like UI style (rounded-xl, uppercase labels, muted colors, same spacing)
- NFR-2: No new dependencies — uses existing UI components (Input, Button, Badge, Dialog)
- NFR-3: Error states shown inline (same pattern as existing `ProviderMethodStepView`)

## Acceptance Criteria

- [ ] AC-1: "Add custom provider" entry appears at the bottom of the provider list in `ProviderConnectDialog`
- [ ] AC-2: Clicking it opens a form step with fields: Provider ID, Display Name, Base URL, Model ID, Model Name, API Key
- [ ] AC-3: Provider ID rejects invalid characters and duplicates against existing provider IDs
- [ ] AC-4: Base URL rejects values not starting with `http://` or `https://`
- [ ] AC-5: Submit is disabled until all required fields are filled (provider ID, name, base URL, ≥1 model)
- [ ] AC-6: Submitting calls `PATCH /config` with `{ provider: { <id>: { npm: "@ai-sdk/openai-compatible", name, options: { baseURL, headers? }, models } } }`
- [ ] AC-7: API key is stored via `PUT /auth/{id}` when provided
- [ ] AC-8: `POST /global/dispose` is called after config save, and provider list refreshes showing the new provider
- [ ] AC-9: Optional headers are included in `options.headers` when provided
- [ ] AC-10: Multiple models can be added and removed in the form
- [ ] AC-11: Custom providers can be removed via existing disconnect/remove flow
- [ ] AC-12: Build passes with no type errors

## Scenarios

### Scenario 1: Add custom provider with API key
**Given** user opens ProviderConnectDialog
**When** user clicks "Add custom provider", fills in ID="myapi", Name="My API", URL="https://api.example.com/v1", Model ID="gpt-4", Model Name="GPT-4", API Key="sk-xxx", and clicks "Add provider"
**Then** `PATCH /config` is called with correct structure, `PUT /auth/myapi` stores the key, OpenCode reloads, and "My API" appears in the provider list as connected

### Scenario 2: Add local provider without API key
**Given** user opens ProviderConnectDialog
**When** user fills in ID="ollama", Name="Ollama Local", URL="http://localhost:11434/v1", Model ID="llama2", Model Name="Llama 2", leaves API Key empty, and submits
**Then** `PATCH /config` is called, `PUT /auth` is skipped, OpenCode reloads, and "Ollama Local" appears in the provider list

### Scenario 3: Add provider with custom headers
**Given** user opens ProviderConnectDialog and fills in provider details
**When** user clicks "Add header", enters "X-Custom-Auth" / "bearer xxx", and submits
**Then** config includes `options.headers: { "X-Custom-Auth": "bearer xxx" }`

### Scenario 4: Validation rejects duplicate provider ID
**Given** "anthropic" already exists in the provider list
**When** user enters Provider ID = "anthropic"
**Then** form shows an error and submit is disabled

### Scenario 5: Delete custom provider
**Given** custom provider "myapi" exists and is connected
**When** user clicks "Remove" on "myapi" in the provider list
**Then** provider is disconnected and removed via existing flow

## Technical Notes

### API Flow
```
1. PATCH /config  → { provider: { <id>: { npm, name, options, models } } }
2. PUT /auth/<id> → { type: "api", key: "<key>" }  (skip if no API key)
3. POST /global/dispose                              (reload OpenCode)
4. refreshAll()                                      (new provider appears in list)
```

### Key Files to Modify
| File | Change |
|------|--------|
| @code/ui/src/api/client.ts | Add `patchConfig()` method |
| @code/ui/src/contexts/OpenCodeContext.tsx | Add `addCustomProvider()` action |
| @code/ui/src/components/organisms/ProviderManagement/ProviderConnectDialog.tsx | Add `CustomProviderStepView` + entry point in list |

### Config Structure Sent to OpenCode
```json
{
  "provider": {
    "<provider-id>": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "<Display Name>",
      "options": {
        "baseURL": "<url>",
        "headers": { "<key>": "<value>" }
      },
      "models": {
        "<model-id>": { "name": "<Model Name>" }
      }
    }
  }
}
```
## Open Questions

None — all gray areas resolved via D1–D3.
