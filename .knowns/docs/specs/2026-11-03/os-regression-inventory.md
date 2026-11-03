---
id: doc-d389d5bb5482e9c35ce17c5e434c2d23
title: os-regression-inventory
description: OS-specific fixes the TypeScript rewrite must preserve
createdAt: '2026-11-03T10:01:51.428Z'
updatedAt: '2026-11-03T10:01:51.428Z'
tags:
  - spec-support
---

# OS regression inventory

OS-specific fixes already made in the Go implementation that the TypeScript rewrite must preserve (FR-9, D2). Tests live in `tests/e2e_os_regression_test.go`, drive the binary only through CLI and HTTP, and run against `TEST_BINARY`. Run them with `go test ./tests/ -run OSRegression -count=1`.

Local verification on macOS (darwin): Windows-only and Linux-only tests are skipped here and were not executed. They are written to be run by the Windows and Linux CI runners.

## Inventory

| # | Commit / issue | Platform | Behavior to preserve | Covering test |
|---|---|---|---|---|
| 1 | #144, a888550 | Windows, macOS (case-insensitive FS) | Registry stores a project path in its on-disk casing, so one folder reached via two spellings is one workspace | TestOSRegression_RegistryStoresOnDiskCasing |
| 2 | #144, a888550 | Windows, macOS | A registry.json that already holds one folder under two casings collapses to one workspace on read | TestOSRegression_RegistryCollapsesCaseDuplicates |
| 3 | 090ca95 | Windows (8.3 short names such as RUNNER~1) | A path component the parent listing never names still canonicalizes, so lowercased and original spellings of a temp path agree | TestOSRegression_RegistryStoresOnDiskCasing and ...CollapsesCaseDuplicates (exercised on Windows runners, where the temp path has a short name) |
| 4 | 3a6f0d7, 2071fb3 | Windows, macOS | Test-only: assertions rooted at a temp dir the OS agrees with (/var vs /private/var, short names) | Covered by the same two tests, which resolve temp dirs with EvalSymlinks |
| 5 | c17bab0, 19c18f5, 2b4ac0f | Windows | Home directory is USERPROFILE on Windows and HOME on Unix; user-level state lands under it | TestOSRegression_HomeIsolation |
| 6 | d492c81, d852b6b | Windows | Runtime queue and daemon state honor HOME so parallel runs do not share state | TestOSRegression_HomeIsolation |
| 7 | 354c413 | macOS (kqueue holds a descriptor per watched file) | The shared runtime does not watch source trees; descriptor count stays far below the file count | TestOSRegression_RuntimeDoesNotWatchSourceTree (darwin and linux) |
| 8 | #138, 2ecd073 | Windows | Polling runtime status does not leak conhost.exe/OpenConsole.exe (probes cached, child consoles hidden) | TestOSRegression_StatusPollingDoesNotLeakConsoles (windows only, skipped elsewhere) |
| 9 | 5bca0e2, 12341b8 | Windows | Directory fsync returns ERROR_ACCESS_DENIED (errno 5); history writes treat it as success | TestOSRegression_HistoryWriteSurvivesDirectorySync |
| 10 | 405587c, 09c5a96 | all (Windows backslash and absolute-path cases) | Parent traversal (`../` and `..\`) is rejected; Unix-style absolute folders never escape the docs root | TestOSRegression_DocPathContainment |
| 11 | 09c5a96, 405587c | Unix, Windows with symlink privilege | A symlink under .knowns/docs cannot be followed or written through to reach outside the project | TestOSRegression_DocSymlinkEscape |
| 12 | config load (observed behavior) | Windows (PowerShell writes UTF-8 with BOM) | config.json with a UTF-8 BOM loads | TestOSRegression_ConfigAcceptsUTF8BOM |
| 13 | #155 (open, not fixed in Go) | Windows | install.json with a BOM must not break `knowns update` | TestOSRegression_UpdateReadsBOMInstallMetadata (skipped by default: Go still has the bug and update needs the npm registry; enforce with KNOWNS_OSR_EXPECT_BOM_INSTALL_JSON=1) |
| 14 | observed gap, no Go fix | Windows | registry.json with a BOM must load (Go returns an empty project list) | TestOSRegression_RegistryAcceptsUTF8BOM (skipped by default; enforce with KNOWNS_OSR_EXPECT_BOM_REGISTRY=1) |
| 15 | 6f0d064 | macOS | install.sh renames binaries into place, never cp (cp keeps the inode and macOS SIGKILLs later launches, exit 137) | not binary-testable: covered by TSR-Z7CRS1 (install scripts) |
| 16 | 75b0470 | macOS, Linux | install.sh links knowns and kn onto PATH without rc edits; uninstall removes only our links | not binary-testable: covered by TSR-Z7CRS1 (install scripts) |
| 17 | f3278da | macOS, Linux | install.sh links even when the install dir is already on PATH | not binary-testable: covered by TSR-Z7CRS1 (install scripts) |
| 18 | 75b0470 (update.go) | all | `knowns update` resolves the executable before detecting install method; a symlink under /opt/homebrew/bin is not mistaken for Homebrew | not testable offline: `update` needs the npm registry and a newer release before it reads install metadata. Re-verify in TSR-Z7CRS1 |
| 19 | #133, 67bab55, b6dc36c | macOS Intel (x86_64) | Installer and release support the darwin-amd64 asset | not binary-testable: covered by TSR-Z7CRS1 (install scripts) and the release matrix (D11) |
| 20 | 160c0c6, b0322c0 | Windows | file:/// URL to OS path conversion in the managed Qdrant installer | not testable: the installer source URL is internal and not reachable through CLI or MCP; re-verify when the TypeScript runtime ports the Qdrant installer |
| 21 | c80f601 | Windows | bash-language-server resolves sourced files via rootPath | not testable: requires an installed bash-language-server and a Windows host; re-verify in the LSP port |
| 22 | ac3be16, d852b6b | Windows CI | Test-only: relaxed LSP startup timeout, isolated e2e runtimes | no product behavior |

## Counts

- Rows: 22 (row 22 is test-only and has no product behavior)
- By platform: Windows only 11 (rows 3, 5, 6, 8, 9, 12, 13, 14, 20, 21, 22), Windows and macOS 3 (rows 1, 2, 4), macOS only 3 (rows 7, 15, 19), macOS and Linux 2 (rows 16, 17), all platforms 3 (rows 10, 11, 18)
- Covered by a binary-level test: 14 rows (1-14). Of these, 11 run on this macOS machine and pass (rows 1-7, 9-12 via 9 test functions); row 8 is Windows-only and skipped on darwin; rows 13 and 14 are contract tests skipped by default because Go never had the fix
- Not binary-testable: 7 rows (15-21): 4 deferred to TSR-Z7CRS1 install scripts (15, 16, 17, 19), 3 for other stated reasons (18, 20, 21)
- Test-only, nothing to cover: row 22

## Notes for the TypeScript build

- Rows 13 and 14 are contract tests for behavior Go never had. The rewrite should fix them and flip the environment switches on.
- Rows 1-3 and 8 only become meaningful on Windows runners; they are written but were not executed on Windows during TSR-GM1E2A.
- Row 7 locates the runtime through `~/.knowns/runtime/knowns-runtime.pid`. If the TypeScript runtime stores its pid elsewhere the test skips with a message; update the path then.
