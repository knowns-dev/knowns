---
id: doc-e53cbb2cf044e414e4b62554a2ff561a
title: 'Learning: Import Sync + CLI Text Handling'
description: Learnings from import sync caching and CLI text escape fixes
createdAt: '2026-04-02T08:18:27.549Z'
updatedAt: '2026-08-25T07:56:01.071Z'
tags:
  - learning
  - cli
  - import
  - sync
---

# Learning: Import Sync + CLI Text Handling

## Patterns

### git ls-remote Cache Before Clone
- **What:** Before `git clone --depth 1`, run `git ls-remote <url> HEAD` to get the remote commit hash. Compare with cached hash in `_import.json`. Skip clone entirely if unchanged.
- **When to use:** Any git-based sync operation where the remote rarely changes (imports, templates, etc.)
- **Key detail:** `git ls-remote` is ~200-500ms vs clone which can be several seconds. Store `lastCommitHash` alongside `lastSync` in metadata.
- **Source:** @task-aq1efd

### Text Flags and MCP Text Args Are Stored Verbatim
- **What:** An `unescapeText()` helper once converted `\n` to a newline and `\t` to a tab for every text flag. It was removed from the CLI in commit ecddf78 and from the MCP handlers afterwards. Both surfaces now store flag and argument values byte for byte.
- **Why reverted:** The rewrite made it impossible to pass a value containing a genuine backslash sequence, so code snippets, regexes, and Windows paths were silently corrupted. It was worst in `code.replace`, `code.replace_body`, and `code.insert`, where a body containing `"a\nb"` was rewritten into source that no longer compiled. Shells already produce real newlines through `$'...'`, and JSON already carries them natively, so the rewrite removed capability without adding any.
- **When to use:** Never reintroduce escape rewriting in an argument reader. Let the caller's own quoting produce real newlines.
- **Key detail:** In bash and zsh only `$'...\n...'` yields a real newline; double-quoted `"...\n..."` does not. That expectation mismatch is real, but it belongs in the docs, not in a lossy transform.
- **Source:** @task-6kfblu

## Decisions

### Sentinel Error vs Boolean for "Up To Date"
- **Chose:** CLI uses `errUpToDate` sentinel error; server uses `(upToDate bool)` return value
- **Over:** Unified approach for both
- **Tag:** TRADEOFF
- **Outcome:** CLI needed sentinel because `cliGitSync` is called through closures where adding return values is awkward. Server already had multi-return so a bool was cleaner.
- **Recommendation:** Match the existing return style of the function rather than forcing consistency.

### RunWithSpinner + Sentinel Error Handling
- **Chose:** Catch `errUpToDate` inside the RunWithSpinner closure, return nil to spinner
- **Over:** Checking error after RunWithSpinner returns
- **Tag:** GOOD_CALL
- **Outcome:** RunWithSpinner prints any non-nil error as `✗ <label>: <error>`. Returning errUpToDate directly would show as a failure. Catching inside the closure and using a `isUpToDate` bool flag avoids the false failure display.
- **Recommendation:** When using RunWithSpinner, any "expected" non-error condition must be caught inside the closure. The spinner treats ALL errors as failures.

## Failures

None — both changes were straightforward with no backtracking.
