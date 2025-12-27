# Philosophy

Knowns is built around a simple idea: **AI should understand your project the same way a teammate does.**

This document explains the principles that guide Knowns' design and why it works the way it does.

---

## 1. AI Should Read, Not Guess

Most AI tools rely on prompts, memory tricks, or repeated explanations. This breaks down over time.

Knowns takes a different approach:

- AI should read real project artifacts
- Context should be explicit, structured, and versioned
- Nothing important should live only in chat history

If a human can open a file and understand the project, AI should be able to do the same.

That's why Knowns focuses on **files, references, and predictable structure**.

---

## 2. Files Are the Source of Truth

Knowns is file-first and local-first by design.

- Tasks are markdown files
- Docs are markdown files
- Structure lives on disk
- Everything can be committed to Git

This means:

- No hidden state
- No opaque databases
- No vendor lock-in
- Full auditability

Your project knowledge should survive tools, editors, and even Knowns itself.

---

## 3. Explicit Context Beats Memory

Human memory is fuzzy. AI memory is unreliable across sessions.

Knowns replaces implicit memory with explicit references:

```
@doc/patterns/auth
@task-42
```

These references are:

- Deterministic
- Resolvable
- Machine-readable

When AI sees a reference, it can load the exact source — every time.

No guessing. No hallucinated context.

---

## 4. Local-First, Sync Optional

Knowns works fully offline.

The local `.knowns/` directory is always the source of truth.

When teams need visibility, Knowns can optionally sync to a self-hosted server that:

- Mirrors task and documentation state
- Shows activity and progress
- Enables collaboration

The server does not replace local files. It exists only as a **synchronization and visibility layer**.

You own your data.

---

## 5. CLI Is the Primary Interface

Knowns is built for developers.

The CLI is not an afterthought — it is the core interface:

- Scriptable
- Composable
- Automation-friendly
- Editor-agnostic

The Web UI exists to visualize and browse, not to replace the CLI.

---

## 6. AI Is a Teammate, Not a Feature

Knowns does not treat AI as a magic button.

Instead, AI is treated like a junior teammate who:

- Reads tasks
- Reads documentation
- Follows references
- Executes instructions

By structuring knowledge clearly, AI can behave consistently and predictably.

---

## 7. Simple Concepts, Strong Guarantees

Knowns intentionally avoids complex abstractions.

Core building blocks:

- Tasks
- Documents
- References
- Files

From these, higher-level workflows emerge naturally.

This simplicity makes Knowns:

- Easy to reason about
- Easy to extend
- Hard to break

---

## 8. Designed for Long-Term Projects

Knowns is optimized for projects that live for months or years.

It helps teams:

- Preserve architectural decisions
- Avoid repeated explanations
- Maintain consistency over time
- Collaborate with AI safely

Knowledge should accumulate — not reset every session.

---

## 9. What Knowns Is Not

To stay focused, Knowns intentionally avoids becoming:

- A full project management system
- A ticketing platform
- A SaaS dashboard
- A replacement for Git
- A note-taking app

It **complements existing tools** instead of replacing them.

---

## 10. The Core Belief

> If knowledge is explicit, structured, and versioned, AI can work like a real teammate.

Knowns exists to make that belief practical.
