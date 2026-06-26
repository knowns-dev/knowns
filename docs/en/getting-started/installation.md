# Installation

Install the `knowns` CLI first. Installation only makes the command available; you still need to run `knowns init` inside each repository where you want Knowns-managed project context.

## Requirements

- a supported terminal environment on macOS, Linux, or Windows
- Git if you want repository-aware init/setup behavior
- optional local model downloads if you plan to use semantic search

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

## PowerShell installer (Windows)

```powershell
irm https://knowns.sh/script/install.ps1 | iex
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

## No-global-install option

If you do not want a global install, you can still run Knowns through npm:

```bash
npx knowns init
```

## Next step

- [Quick start](./quick-start.md)
