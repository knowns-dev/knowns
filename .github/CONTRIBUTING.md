# Contributing to Knowns CLI

First off, thank you for considering contributing to Knowns CLI! :tada:

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Pull Request Process](#pull-request-process)
- [Style Guidelines](#style-guidelines)

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## Getting Started

- Make sure you have a [GitHub account](https://github.com/signup/free)
- Fork the repository on GitHub
- Clone your fork locally

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates.

When creating a bug report, include:
- **Knowns CLI version** (`knowns --version`)
- **OS and version**
- **Node.js version** (`node --version`)
- **Steps to reproduce**
- **Expected vs actual behavior**
- **Screenshots/logs** if applicable

### Suggesting Features

Feature requests are welcome! Please provide:
- Clear description of the feature
- Use case / why it would be useful
- Examples from other tools (if any)

### Your First Contribution

Look for issues labeled:
- `good first issue` - Good for newcomers
- `help wanted` - Extra attention needed
- `documentation` - Documentation improvements

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code, add tests
3. Ensure the test suite passes
4. Make sure your code follows the style guidelines
5. Issue the pull request

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/knowns.git
cd knowns

# Install dependencies
bun install

# Build the project
bun run build

# Link for local testing
bun link

# Run tests
bun test
```

## Pull Request Process

1. Update the README.md with details of changes if applicable
2. Update the documentation if you're changing functionality
3. The PR will be merged once you have the sign-off of a maintainer

## Style Guidelines

### Git Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only
- `style:` - Code style (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding tests
- `chore:` - Maintenance tasks

Example:
```
feat: add --children option to task view command

- Show detailed list of child tasks
- Display progress summary
```

### Code Style

- Use TypeScript
- Follow existing code patterns
- Run `bun run lint` before committing
- Add comments for complex logic

### Testing

- Write tests for new features
- Ensure existing tests pass
- Aim for good test coverage

## Questions?

Feel free to open an issue with the `question` label!

## Related Documentation

- **[Development Workflow](DEVELOPMENT_WORKFLOW.md)** - Complete guide for the development process
- **[Code of Conduct](../CODE_OF_CONDUCT.md)** - Community guidelines

---

Thank you for contributing! :heart:
