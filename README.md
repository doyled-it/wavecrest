# wavecrest

wavecrest is a single-binary daemon + CLI + MCP server that makes Wave Terminal a first-class home
for managing multiple AI coding agent sessions. It layers usage tracking (with progress-bar gauges
in a Wave web widget), session orchestration tied to git worktrees, restart-across-reboots via the
agent's native resume mechanism plus SQLite-persisted workspace shape, and an MCP server so other
agents can query session state. Built in TypeScript on Bun.

## Development

```
bun install
bun test
bun run dev:daemon
```

## Design

See `docs/superpowers/specs/` for the full design spec and `docs/superpowers/plans/` for the
phased implementation plan.
