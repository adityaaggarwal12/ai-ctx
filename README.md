# ctx — shared memory for your AI coding harnesses

`ctx` gives every Claude Code and Codex session the context of the other sessions on
the same project, whether they run in Orca, Conductor or a plain terminal. Sessions
that are still open count too. Nothing has to end, nothing is uploaded, and no MCP
connection is needed.

- **Capture:** `ctxd` watches the transcript files the CLIs already write
  (`~/.claude/projects`, `~/.codex/sessions`), turn by turn.
- **Memory:** every few turns a cheap model (Haiku, through your `claude` CLI login)
  records decisions, rejected options and why, gotchas, preferences, todos and
  milestones. Most batches record nothing, by design.
- **Recall:** new sessions get a short brief at start; prompts about past work get up
  to 3 cited snippets, or nothing. Agents can dig deeper with `ctx search` and
  `ctx show`.

Background and design choices: [docs/RESEARCH.md](docs/RESEARCH.md),
[docs/PLAN.md](docs/PLAN.md).

## Install

```sh
bun install
bun src/cli.ts install          # dry run: shows every file it would touch
bun src/cli.ts install --apply  # copies the app to ~/.ctx/app, adds hooks, starts ctxd (launchd)
```

Then, once, in Codex: open `/hooks` and approve the two `ctx` hooks (Codex silently
skips hooks you haven't approved). Check everything with `ctx doctor`.

Undo with `ctx uninstall --apply`. Every modified file gets a `.bak-ctx-<time>` backup.

## Use

| You want | Run |
|---|---|
| What a new session sees | `ctx brief` |
| Find a past discussion | `ctx search "refresh tokens"` (`--all` for every project) |
| Expand an id from a brief or snippet | `ctx show f1a2b3c` / `ctx show t:1a2b3c4d.12` |
| What's running elsewhere right now | `ctx sessions`, then `ctx tail <session>` |
| Record something by hand | `ctx note "…" --why "…"`, `ctx reject "…" --why "…"`, `ctx todo "…"` |
| Fix memory | `ctx retract <id>`, `ctx done <id>` |
| Health | `ctx status`, `ctx doctor` |

For a chat that was already open before you installed ctx, ask the agent to run
`ctx brief` (hooks only attach to new sessions).

## Configuration

`~/.ctx/config.json`:

- `branchScopedRepos`: repos where each branch is a separate project (for example a
  playground repo with one idea per worktree):
  `["github.com/you/playground"]`.
- `ignoreCwd`: path fragments to never ingest.
- `extract`: `model`, `maxCallsPerDay` (default 200), `horizonDays` (only recent
  turns get extracted; older history stays searchable), `enabled`.
- `embed.enabled`: local EmbeddingGemma vectors for hybrid search (about 1.5 GB RAM
  while backfilling; set `false` to run lexical-only).

## Data

Everything lives in `~/.ctx` (mode 0700), with secrets redacted before anything is
stored or sent to the model:

- `archive/<machine>/…`: cleaned turns (source of truth; Claude Code deletes old
  transcripts on its own schedule).
- `events/<machine>/YYYY-MM.jsonl`: append-only fact log. `ctx rebuild` replays it.
- `index.sqlite`: search index and derived tables (rebuildable).
- `projects/<slug>/LIVE.md`: human-readable live brief.

To sync with a VM, sync `archive/` and `events/` (each machine writes only its own
subfolder) with Syncthing or rsync. Don't sync `index.sqlite`.

## Development

```sh
bun test
bunx tsc --noEmit -p .
CTX_HOME=/tmp/ctxtest bun src/cli.ts scan   # try it against a scratch store
```
