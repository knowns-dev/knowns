---
name: kn:spec
description: Use when creating a specification document for a feature (SDD workflow)
---

# Creating a Spec Document

Create a specification document for a feature using SDD (Spec-Driven Development).

**Announce:** "Using kn:spec to create spec for [name]."

**Core principle:** SPEC FIRST → REVIEW → APPROVE → THEN PLAN TASKS.

## Step 1: Get Feature Name

If `$ARGUMENTS` provided, use it as spec name.

If no arguments, ask user:
> What feature are you speccing? (e.g., "user-auth", "payment-flow")

## Step 2: Gather Requirements

Ask user to describe the feature:
> Please describe the feature requirements. What should it do?

Listen for:
- Core functionality
- User stories / scenarios
- Edge cases
- Non-functional requirements

## Step 3: Create Spec Document

```json
mcp__knowns__create_doc({
  "title": "<Feature Name>",
  "description": "Specification for <feature>",
  "folder": "specs",
  "tags": ["spec", "draft"],
  "content": "<spec content>"
})
```

**Spec Template:**

```markdown
## Overview

Brief description of the feature and its purpose.

## Requirements

### Functional Requirements
- FR-1: [Requirement description]
- FR-2: [Requirement description]

### Non-Functional Requirements
- NFR-1: [Performance, security, etc.]

## Acceptance Criteria

- [ ] AC-1: [Testable criterion]
- [ ] AC-2: [Testable criterion]
- [ ] AC-3: [Testable criterion]

## Scenarios

### Scenario 1: [Happy Path]
**Given** [context]
**When** [action]
**Then** [expected result]

### Scenario 2: [Edge Case]
**Given** [context]
**When** [action]
**Then** [expected result]

## Technical Notes

Optional implementation hints or constraints.

## Open Questions

- [ ] Question 1?
- [ ] Question 2?
```

## Step 4: Ask for Review

Present the spec and ask:
> Please review this spec:
> - **Approve** if requirements are complete
> - **Edit** if you want to modify something
> - **Add more** if requirements are missing

## Step 5: Handle Response

**If approved:**
```json
mcp__knowns__update_doc({
  "path": "specs/<name>",
  "tags": ["spec", "approved"]
})
```

Then suggest:
> Spec approved! Ready to create tasks?
> Run: `/kn:plan --from @doc/specs/<name>`

**If edit requested:**
Update the spec based on feedback and return to Step 4.

**If add more:**
Gather additional requirements and update spec.

## Checklist

- [ ] Feature name determined
- [ ] Requirements gathered
- [ ] Spec created in specs/ folder
- [ ] Includes: Overview, Requirements, ACs, Scenarios
- [ ] User reviewed
- [ ] Status updated (draft → approved)
- [ ] Next step suggested (/kn:plan --from)

## Red Flags

- Creating spec without user input
- Skipping review step
- Approving without explicit user confirmation
- Not suggesting task creation after approval