# Uninstall

Use the uninstall method that matches how you installed Knowns. Uninstalling the CLI does not delete project context by default.

## Homebrew

```bash
brew uninstall knowns
```

## npm

```bash
npm uninstall -g knowns
```

## Shell installer on macOS/Linux

```bash
curl -fsSL https://knowns.sh/script/uninstall | sh
```

If you installed into a custom directory, pass the same directory to the uninstaller:

```bash
curl -fsSL https://knowns.sh/script/uninstall | KNOWNS_INSTALL_DIR="$HOME/.local/bin" sh
```

## PowerShell installer on Windows

```powershell
irm https://knowns.sh/script/uninstall.ps1 | iex
```

If you installed into a custom directory, set the same directory first:

```powershell
$env:KNOWNS_INSTALL_DIR = "$env:USERPROFILE\.knowns\bin"
irm https://knowns.sh/script/uninstall.ps1 | iex
```

## Go install

```bash
rm -f "$(go env GOPATH)/bin/knowns"
```

If you installed a `kn` alias manually, remove that too.

## Remove runtime memory adapters

If you enabled runtime memory hooks for an assistant, remove the adapter before uninstalling the CLI:

```bash
knowns runtime uninstall codex
knowns runtime uninstall claude
knowns runtime uninstall opencode
knowns runtime uninstall kiro
```

Run only the commands for runtimes you actually configured.

## What is left behind

The uninstall scripts remove installed CLI binaries and PATH entries added by the installer. They intentionally leave these files alone:

- project `.knowns/` folders
- tasks, docs, specs, memory, decisions, and templates
- generated AI integration files such as `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, `.claude/skills`, `.mcp.json`, `.codex/config.toml`, or `opencode.json`

Delete those files manually only if you intentionally want to discard project context or remove AI integration artifacts from a repository.

## Verify removal

```bash
knowns --version
```

If the command is not found, the CLI has been removed from your active PATH. Open a new terminal if your shell still sees an old PATH entry.
