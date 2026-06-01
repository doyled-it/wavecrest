# wavecrest

Wave Terminal companion for AI coding agents — multi-session dashboard, live usage gauges, subagent attribution, per-session token sparklines, worktree-aware diff stats, and an MCP server that exposes the dashboard to any agent that speaks MCP.

![dashboard screenshot](docs/screenshot.png)

## What you get

Each card on the dashboard shows, for every active Claude Code session:

- **Repo name** as the title (auto-detected from `git`), with the **branch** beneath it
- A **fork glyph (⎇)** when the session is running in a linked git worktree (hover for the full path)
- **Token totals** plus a `+X −Y` **diff vs the default branch's merge-base** when the cwd is a git repo
- **Subagent pills** showing the token share contributed by each subagent type (`main`, `general-purpose`, `Explore`, …)
- A **token sparkline** plotting usage across the session's lifetime in 40 fixed buckets
- **Status** (working / idle / awaiting input / error) and **time-since-last-activity**, updated live over SSE
- Inline **rename**, **pin**, and **delete** controls

Above the cards, three gauges track Claude's session / weekly / per-model usage (sourced from `claude /usage`), with countdown labels until reset.

Sessions are sorted **pinned first, then alphabetical** by visible name — multiple sessions on the same repo cluster together automatically.

## Features

- Auto-adopts any `claude` session that fires the standard hooks — no special launcher required
- Persists session state in SQLite under `~/.wavecrest/` and resumes across reboots
- Live updates via Server-Sent Events with 15s heartbeats (no stale dashboards)
- Per-message token sampling with subagent attribution via Task/Agent tool-use tracking
- Daemon self-heals its managed settings entries (hooks, MCP server, Wave widget) on every boot, so `brew upgrade` "just works" — no need to re-run `wavecrest install`
- Theme-matching: the dashboard adopts your Wave theme automatically
- Built-in MCP server exposing read and write tools over [Model Context Protocol](https://modelcontextprotocol.io) — any MCP host (Claude Code, Codex, etc.) can introspect and act on the dashboard
- Optional **codebase Q&A** via `query_repo` / `index_repo` proxying to [codegraph](https://github.com/colbymchenry/codegraph)

## Prerequisites

- macOS on Apple Silicon or Intel (Linux is on the phase 2 roadmap)
- [Wave Terminal](https://www.waveterm.dev/) installed
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and on your PATH
- Optional: `cliclick` for one-keystroke new-tab creation (`brew install cliclick`) — gates one-click "+ new session" from the dashboard; everything else works without it

## Install

```bash
brew install doyled-it/wavecrest/wavecrest
```

Or grab a prebuilt tarball from the [releases page](https://github.com/doyled-it/wavecrest/releases), or pipe the install script:

```bash
curl -fsSL https://raw.githubusercontent.com/doyled-it/wavecrest/main/scripts/install.sh | sh
```

Building from source:

```bash
git clone https://github.com/doyled-it/wavecrest
cd wavecrest
bun install
bun run build
./dist/wavecrest-bundle-darwin-arm64/wavecrest install
```

## Setup

```bash
wavecrest install                         # claude hooks + wave widget + MCP entry + launchd auto-start
# Open a FRESH Wave terminal block (NOT inside tmux/screen) and run:
wavecrest auth-set                        # captures the Wave env so the daemon can call wsh
# Restart Wave Terminal, then drag the "wavecrest" widget into a block.
```

Run `wavecrest doctor` at any time to verify your setup — it lists every managed entry and points at the exact fix for anything broken.

## MCP server

`wavecrest install` writes a tagged `wavecrest` entry under `mcpServers` in `~/.claude/settings.json`, so Claude Code picks it up automatically. Other MCP hosts can add the same entry by hand:

```json
{
  "mcpServers": {
    "wavecrest": {
      "command": "/absolute/path/to/wavecrest",
      "args": ["mcp"]
    }
  }
}
```

The server speaks MCP over stdio and exposes:

| Tool | Effect |
| --- | --- |
| `list_sessions(filter?)` | All active sessions with rollup data (optionally filter by `status` or `agent_kind`) |
| `get_session(id)` | A single session, plus rollup, subagent breakdown, sparkline, and diff stats |
| `get_usage()` | Latest agent-usage snapshots (Claude session/week limits) |
| `recent_events(limit?, verbose?)` | Recent session-state transitions |
| `open_session(branch, …)` | **Write.** Create a new agent session in the currently-focused Wave tab |
| `rename_session(id, display_name)` | **Write.** Update a session's display name |
| `pin_session(id, pinned)` | **Write.** Pin or unpin a session |
| `delete_session(id)` | **Write.** Remove a session from the dashboard |
| `focus_session(id)` | **Write.** Focus the session's Wave tab |
| `query_repo(repo_path, question)` | Ask a codebase question; returns a markdown context bundle (needs codegraph) |
| `index_repo(repo_path, force?)` | **Write.** Build a codegraph index in `<repo_path>/.codegraph/` so `query_repo` works |

### Codebase Q&A (optional)

`query_repo` and `index_repo` proxy to [codegraph](https://github.com/colbymchenry/codegraph), which is optional. Install with `npm install -g @colbymchenry/codegraph` (or set `WAVECREST_CODEGRAPH_PATH` to a custom location). An agent that loads wavecrest's MCP server can then answer questions like:

> user: *"what calls myFunction?"*
> agent calls `query_repo({ repo_path: "/Users/me/projects/foo", question: "what calls myFunction" })`
> → markdown context bundle

The first call against an un-indexed repo returns a hint to run `index_repo` first. `wavecrest doctor` surfaces a warn-level check when codegraph isn't on PATH.

### Security

The write tools let any MCP host that loads this server modify your dashboard and spawn agent sessions. To disable: remove the `wavecrest` entry from your MCP host's config (for Claude Code, edit `~/.claude/settings.json`), or run `wavecrest uninstall`. The server emits a one-time `[wavecrest mcp] first write-tool invoked` notice on stderr the first time a write tool fires.

## Configuration

State lives under `~/.wavecrest/`:

- `state.db` — SQLite database of sessions, events, usage snapshots, per-message token samples
- `wave-env.json` — captured Wave env (JWT, TABID, interactive PATH, agent paths)
- `daemon.log` — daemon stdout/stderr
- `port` / `wavecrest.pid` — runtime metadata

Environment variables:

- `WAVECREST_HOME` — override the state directory (default `~/.wavecrest`)
- `WAVECREST_LOG=debug` — verbose logging
- `WAVECREST_UI_DIR` — point the daemon at a development UI build
- `WAVECREST_WSH_PATH` — override the autodetected `wsh` location
- `WAVECREST_CODEGRAPH_PATH` — override the codegraph CLI path

The HTTP server listens on `127.0.0.1:17321` and auto-increments if the port is busy; the chosen port is written to `~/.wavecrest/port`.

## Updating

```bash
brew upgrade wavecrest
```

The new binary replaces itself in place. On its next boot the daemon **reconciles its managed settings entries** (hooks, MCP server, Wave widget) against the current binary path — no need to rerun `wavecrest install`. If anything is already correct, nothing is written.

## Uninstall

```bash
wavecrest uninstall           # removes hooks, widget, MCP entry, launchd agent
wavecrest uninstall --purge   # also deletes ~/.wavecrest state
```

## Troubleshooting

Run `wavecrest doctor` first — it enumerates every check with a specific fix.

- **Dashboard widget doesn't appear.** Restart Wave Terminal so it picks up the new entry in `~/.config/waveterm/widgets.json`.
- **Session created but block creation failed.** The captured Wave env has expired. Open a fresh Wave terminal block and rerun `wavecrest auth-set`.
- **`wsh not available` in the logs.** Check that `~/Library/Application Support/waveterm/bin/wsh` exists; reinstall Wave if not. Override with `WAVECREST_WSH_PATH` if you keep wsh elsewhere.
- **Usage gauges show 0.** The daemon can't find `claude` on PATH. Rerun `wavecrest auth-set` from an interactive shell where `which claude` resolves.
- **Card shows the wrong branch.** Orchestrator sessions that `cd` between worktrees may have been adopted at a different cwd than where they're now working. The session's identity is its origin cwd; transient cd's don't update the card. To re-anchor, delete the session card and start a fresh one from the intended worktree.
- **No subagent pills, sparkline, or diff stats appear.** These need at least one assistant turn (so the transcript has a `usage` block) and a git cwd (for diff stats). They show up automatically a few seconds after the first turn lands.

## Architecture

A single Bun-compiled binary plays three roles:

- **Daemon** — long-lived HTTP + SSE + Unix socket server. Owns the SQLite database, tails Claude Code transcripts, polls `claude /usage`, and serves the dashboard.
- **CLI** — one-shot commands and Claude Code hook entrypoints (`wavecrest hook <event>` is what the hook config invokes).
- **MCP server** — stdio MCP server spawned by hosts like Claude Code.

State persists in SQLite under `~/.wavecrest/`. Wave integration goes through `wsh` for block/tab creation and through the standard Claude Code hook contract for event ingestion. See `docs/superpowers/specs/2026-05-22-wavecrest-design.md` for the full design.

## Status

Active development. Single-binary distribution via Homebrew, GitHub Releases, and a curl installer all work today.

The cleanest tab-creation experience requires the still-pending Wave PR [wavetermdev/waveterm#3333](https://github.com/wavetermdev/waveterm/pull/3333) (`wsh tab create/rename/focus`). Until that lands, wavecrest falls back to a one-keystroke modal (or `cliclick` if installed) for new-tab creation. Everything else — adoption, gauges, MCP, subagent attribution, sparklines, diff stats — works without it.

## Contributing

Issues and PRs welcome at [github.com/doyled-it/wavecrest](https://github.com/doyled-it/wavecrest). The design spec lives at `docs/superpowers/specs/2026-05-22-wavecrest-design.md`.

## License

MIT. A `LICENSE` file will be added in a future release.

## Acknowledgements

- [Wave Terminal](https://www.waveterm.dev/) — the host this companion is built for
- [agent-view](https://github.com/wavetermdev/agent-view) — the prototype that inspired wavecrest
- [codegraph](https://github.com/colbymchenry/codegraph) — powers the optional `query_repo` / `index_repo` MCP tools
