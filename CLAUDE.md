# LoomBrain Plugins

## Project

Marketplace + plugins for LoomBrain Claude Code integrations.

## Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Linter/Formatter**: Biome
- **Testing**: Bun test

## TDD

tdd: strict

## Commands

```bash
cd plugins/loombrain-sessions
bun install          # Install deps
bun test             # Run tests
bun run validate     # Validate plugin manifest + versions
```

## Conventions

- No npm dependencies in plugin code — bun built-ins + native fetch only
- Self-contained types (no imports from loombrain monorepo)
- Hook must always exit 0, even on errors
- Use `lb:` prefix for all commands to avoid namespace conflicts
