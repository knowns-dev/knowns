---
name: knowns.task.brainstorm
description: Use when requirements are unclear, multiple approaches exist, or you need to explore solutions before planning
---

# Brainstorming for Tasks

Convert vague requirements into concrete design through structured questioning and exploration.

**Announce at start:** "I'm using the knowns.task.brainstorm skill to explore approaches."

**Core principle:** UNDERSTAND THE PROBLEM BEFORE PROPOSING SOLUTIONS.

## The Process

### Phase 1: Discovery

**One question at a time.** Don't overwhelm with multiple questions.

Prefer multiple-choice when possible:
```
Which approach do you prefer?
A) Quick solution with trade-offs
B) Comprehensive solution, more effort
C) Something else (describe)
```

Questions to clarify:
- What problem are we solving?
- Who are the users/stakeholders?
- What are the constraints?
- What does success look like?

### Phase 2: Research Existing Patterns

```bash
# Search docs for related patterns
knowns search "<topic>" --type doc --plain

# Check how similar things were done
knowns search "<keywords>" --type task --status done --plain
```

**Learn from history** - completed tasks often contain implementation insights.

### Phase 3: Explore Approaches

Present 2-3 options with trade-offs:

```markdown
## Option A: [Name]
- **Approach**: Brief description
- **Pros**: What's good
- **Cons**: What's challenging
- **Effort**: Low/Medium/High

## Option B: [Name]
- **Approach**: Brief description
- **Pros**: What's good
- **Cons**: What's challenging
- **Effort**: Low/Medium/High
```

**Lead with your recommendation** and explain why.

### Phase 4: Validate and Document

After agreement:
- Summarize the chosen approach
- Identify potential risks
- Define acceptance criteria

If creating a new task:
```bash
knowns task create "<title>" \
  -d "Based on brainstorm: <key decisions>" \
  --ac "Criterion 1" \
  --ac "Criterion 2"
```

If updating existing task:
```bash
knowns task edit $ARGUMENTS -d "Updated based on brainstorm..."
```

## When to Use This Skill

**Good candidates:**
- Vague requirements ("make it faster", "improve UX")
- Multiple valid approaches exist
- Significant effort involved
- New territory for the project

**Skip for:**
- Clear, well-defined tasks
- Bug fixes with obvious solutions
- Simple additions following existing patterns

## Red Flags

**You're doing it wrong if:**
- Proposing solutions before understanding the problem
- Asking too many questions at once
- Not researching existing patterns first
- Skipping trade-off analysis

## Remember

- One question at a time
- Research existing patterns first
- Present options with trade-offs
- Lead with your recommendation
- Document the decision
