# Installation

Install the `knowns` CLI first. Installation only makes the command available; you still need to run `knowns init` inside each repository where you want Knowns-managed project context.

## Requirements

- a supported terminal environment on macOS, Linux, or Windows
- Git if you want repository-aware init/setup behavior
- [Ollama](https://ollama.com/download) if you plan to use semantic search

## Platform support

| Platform | CLI artifact |
| --- | --- |
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel (x86_64) | `darwin-x64` |
| Linux x64 | `linux-x64` |
| Linux ARM64 | `linux-arm64` |
| Windows x64 | `win32-x64` |

Every platform ships the same single binary with no bundled shared library, so
the CLI behaves identically on all of them.

Semantic search is optional and needs an embedding provider — Ollama running
locally, or a third-party OpenAI-compatible endpoint. Without one, Knowns
still works: search falls back to keyword/BM25. See
[Ollama Embedding Models](../reference/ollama-embedding-models.md).

## Homebrew

```bash
brew install knowns-dev/tap/knowns
```

Recommended on macOS and Linux when you want a packaged install.

## npm

```bash
npm install -g knowns
```

Useful when your environment already uses Node tooling.

## Shell installer (macOS/Linux)

```bash
curl -fsSL https://knowns.sh/script/install | sh
```

The binary goes to `~/.knowns/bin`. The installer never edits your shell rc files; instead, when `~/.local/bin` is already on your `PATH`, it links `knowns` and `kn` there so the command works right away. Otherwise it prints how to add `~/.knowns/bin` to `PATH`.

```bash
# Link into another directory that is on PATH
curl -fsSL https://knowns.sh/script/install | KNOWNS_LINK_DIR=/opt/homebrew/bin sh

# Skip linking entirely
curl -fsSL https://knowns.sh/script/install | KNOWNS_NO_LINK=1 sh
```

## PowerShell installer (Windows)

```powershell
irm https://knowns.sh/script/install.ps1 | iex
```

To leave your user `PATH` untouched (for example in CI or on a shared machine), set `KNOWNS_NO_MODIFY_PATH=1`. The installer then prints the directory to add yourself:

```powershell
$env:KNOWNS_NO_MODIFY_PATH = "1"; irm https://knowns.sh/script/install.ps1 | iex
```

## Build from source

```bash
go build -o ./bin/knowns ./cmd/knowns
```

Best option when developing Knowns itself.

## Verify

```bash
knowns --version
```

If the command prints a version, the CLI is installed. Next, move into the repository you want to manage and run the quick start.

## Two binaries: `knowns` and `knowns-engine`

Every install channel puts two files side by side. `knowns` is a small launcher: it serves `knowns mcp --stdio` itself, so an MCP session does not load the whole runtime, and hands every other command to `knowns-engine`, the full CLI (`knowns-engine.exe` on Windows). Keep them in the same directory. `kn` is a link to `knowns` (a copy on Windows). Homebrew, npm, the shell installer, the PowerShell installer and `knowns update` all install and replace the pair together.

If you updated with an older `knowns update` (0.34.x or 0.35.0), you get the engine alone under the name `knowns`. It works, but every session starts the full engine. Run `knowns update` once more, even when you are on the latest version, to finish the split; `knowns doctor` reports `old layout` until you do. On such an install an interactive command shows a one-line hint at most once a day. Nothing is downloaded without you running the update.

## No-global-install option

If you do not want a global install, you can still run Knowns through npm:

```bash
npx knowns init
```

## Uninstall

See [Uninstall](./uninstall.md) for Homebrew, npm, shell installer, PowerShell, Go install, runtime adapter cleanup, and what project files are intentionally left behind.

## Next step

- [Quick start](./quick-start.md)
- [Uninstall](./uninstall.md)
