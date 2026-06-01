# wavecrest

Wave Terminal companion for AI coding agents — multi-session dashboard, usage gauges, MCP-ready.

![dashboard screenshot](docs/screenshot.png)

## Features

- Live dashboard widget in Wave that shows every active Claude Code session at a glance
- Usage gauges that track session/5h/weekly token budgets and surface them as progress bars
- Session orchestration: spawn agents into new Wave blocks, optionally inside a fresh git worktree
- Restart-across-reboots: persists workspace shape in SQLite and resumes sessions via the agent's native mechanism
- Activity feed driven by Claude Code hooks (prompt-submit, tool-use, stop, notification)
- Transcript watcher that surfaces the latest assistant message per session
- Theme matching: dashboard adopts the Wave terminal theme automatically
- Pinned sessions stay at the top of the dashboard across restarts
- **Built-in MCP server** that exposes wavecrest's state (and actions) over the [Model Context Protocol](https://modelcontextprotocol.io) — any MCP host (Claude Code, Codex, etc.) can introspect and orchestrate your sessions

## Prerequisites

- macOS on Apple Silicon (Linux + Intel support is on the phase 2 roadmap)
- [Wave Terminal](https://www.waveterm.dev/) installed
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and on your PATH
- Optional: `cliclick` for one-keystroke new-tab creation (`brew install cliclick`)

## Install

```bash
brew install doyled-it/tap/wavecrest    # coming with the v0.1.3 release
# or download a prebuilt tarball from
#   https://github.com/doyled-it/wavecrest/releases
# or pipe the install script:
curl -fsSL https://raw.githubusercontent.com/doyled-it/wavecrest/main/scripts/install.sh | sh
```

Until the tap is published you can also build from source:

```bash
git clone https://github.com/doyled-it/wavecrest
cd wavecrest
bun install
bun run build
./dist/wavecrest-bundle/wavecrest install
```

## Setup

After the binary is on your PATH:

```bash
wavecrest install         # claude hooks + wave widget + launchd auto-start
# Open a FRESH Wave terminal block (NOT inside tmux or screen) and run:
wavecrest auth-set        # captures the Wave env so the daemon can call wsh
# Restart Wave Terminal, then drag the "wavecrest" widget into a block.
```

Run `wavecrest doctor` at any time to verify your setup.

## Using the MCP server

`wavecrest install` registers a `wavecrest` entry under `mcpServers` in
`~/.claude/settings.json`, so Claude Code picks it up automatically. Other MCP
hosts can add the same entry by hand:

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

The server speaks MCP over stdio and exposes these tools:

| Tool | Effect |
| --- | --- |
| `list_sessions(filter?)` | All active sessions (optionally filtered by `status` or `agent_kind`) |
| `get_session(id)` | A single session, plus its rollup |
| `get_usage()` | Latest agent-usage snapshots (Claude session/week limits) |
| `recent_events(limit?, verbose?)` | Recent session-state transitions |
| `open_session(branch, …)` | **Write.** Create a new agent session (in the currently-focused Wave tab) |
| `rename_session(id, display_name)` | **Write.** Update a session's display name |
| `pin_session(id, pinned)` | **Write.** Pin or unpin a session |
| `delete_session(id)` | **Write.** Remove a session from the dashboard |
| `focus_session(id)` | **Write.** Focus the session's Wave tab |

`open_session` always passes `new_tab=false`: the existing
snapshot-then-finalize path needs a user keystroke to create a new Wave tab,
which isn't available when the call comes from an MCP agent.

### Security

The write tools let any MCP host that loads this server modify your wavecrest
dashboard and spawn agent sessions. To disable them, remove the `wavecrest`
entry from your MCP host's config (for Claude Code, edit
`~/.claude/settings.json`), or run `wavecrest uninstall`. The server emits a
one-time `[wavecrest mcp] first write-tool invoked` notice on stderr the first
time a write tool fires.

## Configuration

State lives under `~/.wavecrest/`:

- `state.db` — SQLite database of sessions, events, usage snapshots
- `wave-env.json` — captured Wave env (JWT, TABID, interactive PATH, agent paths)
- `daemon.log` — daemon stdout/stderr (also accessible via `tail -f`)
- `port` / `daemon.pid` — runtime metadata

Useful environment variables:

- `WAVECREST_HOME` — override the state directory (default `~/.wavecrest`)
- `WAVECREST_LOG=debug` — verbose logging
- `WAVECREST_UI_DIR` — point the daemon at a development UI build
- `WAVECREST_WSH_PATH` — override the autodetected `wsh` location

The HTTP server listens on `127.0.0.1:17321` and will auto-increment if the port
is busy; the chosen port is written to `~/.wavecrest/port`.

## Updating

```bash
brew upgrade wavecrest
# or rerun the curl install — it always pulls the latest release
curl -fsSL https://raw.githubusercontent.com/doyled-it/wavecrest/main/scripts/install.sh | sh
```

## Uninstall

```bash
wavecrest uninstall           # removes hooks, widget, launchd agent
wavecrest uninstall --purge   # also deletes ~/.wavecrest state
```

## Troubleshooting

- **Dashboard widget doesn't appear.** Restart Wave Terminal so it picks up the
  new entry in `~/.config/waveterm/widgets.json`.
- **Session created but block creation failed.** The captured Wave env has
  expired. Open a fresh Wave terminal block and rerun `wavecrest auth-set`.
- **`wsh not available` in the logs.** Check that
  `~/Library/Application Support/waveterm/bin/wsh` exists; reinstall Wave if
  not. Override with `WAVECREST_WSH_PATH` if you keep wsh elsewhere.
- **Usage gauges show 0.** The daemon can't find `claude` on PATH. Rerun
  `wavecrest auth-set` from an interactive shell where `which claude` resolves.
- **Permission popups on every rebuild.** That was a phase-1 issue; the binary
  is now ad-hoc codesigned with a stable identifier, so macOS treats every
  rebuild as the same app.

## Architecture

A single Bun-compiled binary runs three roles: a long-lived daemon (HTTP + SSE
+ Unix socket), a CLI used for one-shot commands and Claude Code hooks, and a
static UI server for the dashboard widget. State persists in SQLite under
`~/.wavecrest/`. Wave integration goes through `wsh` for block/tab creation
and through the standard Claude Code hook contract for event ingestion. See
`docs/superpowers/specs/2026-05-22-wavecrest-design.md` for the full design.

## Status

Alpha. The cleanest tab-creation experience requires the unmerged Wave PR
[wavetermdev/waveterm#3333](https://github.com/wavetermdev/waveterm/pull/3333);
without it wavecrest falls back to a user-keystroke modal (or `cliclick` if
installed).

## Contributing

Issues and PRs are welcome at
[github.com/doyled-it/wavecrest](https://github.com/doyled-it/wavecrest). The
design spec lives at `docs/superpowers/specs/2026-05-22-wavecrest-design.md`
and the phased implementation plan at `docs/superpowers/plans/`.

### Publishing the Homebrew tap

A draft formula is checked in at `scripts/wavecrest.rb`. To publish:

1. Create a public `doyled-it/homebrew-tap` repo.
2. Copy `scripts/wavecrest.rb` to `Formula/wavecrest.rb`, fill the `sha256`
   from the release asset's `.sha256` file, and bump the `url` to the
   release tag.
3. `brew install doyled-it/tap/wavecrest` then works for everyone.

## License

MIT (LICENSE file to be added).

## Acknowledgements

- [Wave Terminal](https://www.waveterm.dev/) — the host this companion is built for
- [agent-view](https://github.com/wavetermdev/agent-view) — the prototype that inspired wavecrest
