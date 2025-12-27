# Contributing

Thank you for considering contributing to Knowns!

Before you start, please read our [Philosophy](./PHILOSOPHY.md) to understand the principles that guide this project.

---

## Core Principles for Contributors

### 1. Keep it simple

Knowns is intentionally minimal. Before adding a feature, ask:

- Does this align with the [philosophy](./PHILOSOPHY.md)?
- Can this be achieved with existing primitives (tasks, docs, refs)?
- Will this add complexity for all users, or just some?

**We'd rather have fewer features that work well than many features that complicate.**

### 2. Files are the source of truth

Any new feature must respect that `.knowns/` files are the source of truth.

- Don't introduce hidden state
- Don't require a database
- Make sure data survives without Knowns

### 3. CLI-first

The CLI is the primary interface. New features should:

- Work fully from CLI
- Have `--plain` output for AI consumption
- Be scriptable and composable

Web UI can visualize, but shouldn't be required.

### 4. AI-readable

Output should be optimized for AI agents:

- Structured, predictable format
- References that resolve to real files
- `--plain` flag for machine consumption

---

## Getting Started

### Prerequisites

- Node.js >= 18
- Bun (for development)

### Setup

```bash
# Clone the repo
git clone https://github.com/knowns-dev/knowns.git
cd knowns

# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm run test

# Lint
npm run lint
```

### Project Structure

```
src/
├── commands/     # CLI commands
├── models/       # Domain models
├── storage/      # File operations
├── server/       # Express server
├── mcp/          # MCP server
├── ui/           # React frontend
└── utils/        # Shared utilities
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed documentation.

---

## Making Changes

### 1. Create a branch

```bash
git checkout -b feature/my-feature
# or
git checkout -b fix/my-fix
```

### 2. Make your changes

- Write clear, minimal code
- Follow existing patterns
- Add tests for new functionality
- Update documentation if needed

### 3. Test your changes

```bash
npm run test
npm run lint
```

### 4. Commit

Write clear commit messages:

```
feat: add time tracking pause/resume

- Add pause and resume subcommands
- Store pause state in .timer file
- Update time report to handle paused sessions
```

### 5. Open a Pull Request

- Describe what you changed and why
- Reference any related issues
- Be open to feedback

---

## What We're Looking For

### Good contributions

- Bug fixes with tests
- Documentation improvements
- Performance optimizations
- Accessibility improvements
- CLI usability enhancements

### Contributions that need discussion first

- New commands or major features
- Changes to file format
- New dependencies
- Architectural changes

Please open an issue to discuss before starting work on these.

### What we'll likely decline

- Features that add significant complexity
- SaaS-style features (user accounts, cloud storage)
- Heavy dependencies for marginal benefit
- Changes that break file-first philosophy

---

## Code Style

We use [Biome](https://biomejs.dev/) for linting and formatting.

```bash
# Check
npm run lint

# Auto-fix
npm run lint:fix
```

### Guidelines

- Use TypeScript strictly
- Prefer functions over classes
- Keep files focused and small
- Use meaningful names
- Write self-documenting code
- Add comments only when logic isn't obvious

---

## Testing

We use [Vitest](https://vitest.dev/) for testing.

```bash
# Run all tests
npm run test

# Run specific test
npm run test -- src/models/task.test.ts

# Watch mode
npm run test -- --watch
```

### What to test

- Domain logic (models)
- Storage operations
- Command behavior
- Edge cases

### What not to test

- UI components (for now)
- Third-party libraries
- Trivial code

---

## Documentation

### When to update docs

- New commands → update `docs/commands.md`
- New concepts → update relevant doc
- Breaking changes → update README + CHANGELOG

### Doc style

- Be concise
- Use examples
- Show, don't just tell
- Keep AI-readability in mind

---

## Release Process

Maintainers handle releases. The process:

1. Update version in `package.json`
2. Update `CHANGELOG.md`
3. Create git tag
4. Push to npm

---

## Community

- **Issues:** Report bugs, suggest features
- **Discussions:** Ask questions, share ideas
- **Pull Requests:** Contribute code

Please be respectful and constructive.

---

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

## Questions?

Open an issue or start a discussion. We're happy to help!
