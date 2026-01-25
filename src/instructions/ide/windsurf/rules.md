# Knowns Integration

This project uses **Knowns** for task and documentation management.

## Quick Start

1. **View guidelines**: Read `AGENTS.md` for complete AI agent guidelines
2. **CLI commands**: Run `knowns --help` for CLI reference

## Core Rules

- **Never edit .md files directly** - Use CLI tools
- **Read docs first** - Before planning or coding
- **Time tracking** - Start timer when taking task, stop when done
- **Wait for approval** - Share plan with user before coding

## Reference

See `AGENTS.md` for:
- Complete CLI command reference
- Task workflow guide
- Best practices

## CLI Quick Reference

```bash
# View task
knowns task <id> --plain

# Take task
knowns task edit <id> -s in-progress -a @me
knowns time start <id>

# Research
knowns search "keyword" --type doc --plain
knowns doc "<path>" --plain

# Add plan (wait for approval)
knowns task edit <id> --plan "1. Step..."

# Check AC (after work done)
knowns task edit <id> --check-ac 1
knowns task edit <id> --append-notes "Done: X"

# Complete
knowns task edit <id> --notes "Summary"
knowns time stop
knowns task edit <id> -s done
```
