# ctx: central context for AI coding harnesses

Plan derived from [RESEARCH.md](RESEARCH.md). Letters in brackets (e.g. [A1]) refer
to the ranked decisions there.

## Goal

Any Claude Code or Codex session, in Orca, Conductor or a plain terminal, on the
laptop or the VM, starts with the current state of the project it's in. That state
includes what other sessions decided, rejected and finished, even sessions that
are still running. No session has to end, and no MCP connection is needed.

## Non-goals (v1)

Browser chats (ChatGPT, claude.ai), team sharing, cloud hosting, an MCP server.
Codebase indexing is out too: agents already grep code well [I2].

## Architecture

```
 Claude Code / Codex transcripts (append-only JSONL, written each turn)
        │  watched; offsets tracked; hints from fs events + 30 s rescan backstop
        ▼
 ctxd (Bun daemon, launchd/systemd)
   adapters/claude, adapters/codex → normalized Turn {user, assistant, tools, files}
   redact (before anything else) ── strip <ctx-context> blocks we injected
   project resolver: cwd → git origin → "host/owner/repo"
   ├─ archive/<machine>/<session>.jsonl      redacted turns, source of truth [A1]
   ├─ index.sqlite  turns + FTS5 + embeddings (rebuildable)            [I1,K1]
   ├─ extractor (batched, gated, budgeted) → events/<machine>/YYYY-MM.jsonl [B1,E1]
   │     reducer → facts table → projects/<slug>/LIVE.md               [B1,G1]
   └─ unix-socket HTTP API for hooks and the CLI (embeddings warm in memory)
        ▲
 ctx (CLI + hook entrypoints; falls back to direct read-only SQLite if ctxd is down)
   SessionStart       → stable brief, ≤ ~6k chars                      [F1]
   UserPromptSubmit   → gated hybrid recall, ≤3 snippets or silence     [F1,I1]
   search/show/tail/sessions/brief/note/reject/retract/status/doctor
```

## Data model

**Turn** (one user prompt + everything up to the next prompt) [J]:
`id, session_id, project, machine, source(claude|codex), harness(orca|conductor|codex-desktop|claude-desktop|cli),
cwd, branch, idx, ts_start, ts_end, user, assistant (final prose), tools (condensed lines), files[]`.

**Fact event** (append-only):
`{id, ts, machine, project, op: add|supersede|retract|done|reaffirm, target?, type, text, why,
files[], origin: user|agreed|agent|manual, confidence, session, turns[], quote}`.
Fact types: `decision`, `rejected`, `gotcha`, `todo`, `progress`, `preference`.

**Reducer** → `facts(id, project, type, text, why, files, origin, confidence, status:
active|superseded|retracted|done, superseded_by, created, updated, session, turns)`.
It is deterministic and replayable (`ctx rebuild`).

**Project id**: normalized origin URL (`github.com/owner/repo`), else
`root:<first-commit-sha>`, else `dir:<realpath>`. Slug = the last path segment, with
a suffix added if two projects collide.

## Capture rules (lessons from claude-mem / Mem0 failures)

- Human prompts only. Skip `isMeta`, tool_result, task notifications, compact
  summaries, sidechains (subagents). Skip Codex `guardian` sessions and injected
  `<environment_context>`/`<system_instruction>` blocks. Strip `<ctx-context>` (our
  own output) so we never re-extract what we injected (mem0 #4573: "User prefers
  Vim" ×808).
- Tool activity is condensed to one line each (`$ cmd → exit`, `edit path`,
  `error: …`). File bodies and diffs are never stored or sent to the LLM (claude-mem
  #5023).
- Redact secrets before truncation and storage [P].
- Ignore sessions whose cwd is inside `~/.ctx`, and extractor calls (run with
  `--no-session-persistence`).

## Extraction

- Trigger per session: ≥3 completed unextracted turns, or ≥1 when the session has
  been idle for 120 s.
- Input: the batch of turns (each capped) plus up to 40 existing active facts for the
  project (FTS-ranked against the batch, plus the most recent), with ids. That lets
  the model dedupe and emit `supersede`.
- Model: `claude -p --model haiku` with tools, settings, MCP and session persistence
  all off. JSON schema enforced. The model is pluggable (API key / Ollama later).
- Prompt: the default answer is no ops. Capture only things that change future
  behavior: decisions with reasons, rejected options with reasons, user corrections
  and preferences, non-obvious gotchas, open todos, milestones. Skip anything
  derivable from code or git. Every op cites its source turn and a short quote.
- Budget: a daily call cap (default 200) and an input cap per call (~24k chars).
  Usage is logged and visible in `ctx status`.
- Facts with origin `agent` (assumed, not confirmed) are kept but left out of the
  brief [H1].

## Retrieval

- Hybrid: FTS5 BM25 (OR of non-stopword terms) + cosine over EmbeddingGemma-300M
  (q8, 768-d, warm in ctxd; ~40 ms per query measured). Fusion = RRF k=60, with a
  fact boost ×1.5 and mild recency `1 + 0.3·exp(-age/45d)`.
- Prompt hook: skip trivial prompts (<15 chars, slash commands, "yes/continue").
  Exclude the current session's own turns. Require the top result to appear in both
  lists, or a fact above the threshold; otherwise inject nothing. Return ≤3 snippets,
  ≤2.5k chars, each cited `[ctx:<id> · date · harness]`.
- CLI: `ctx search` (hybrid, filters `--project --since --type --all`), `ctx show
  <id>` (full turn plus neighbors), giving progressive disclosure.

## Injection format

Factual, labeled reference data, wrapped so it can be stripped on re-ingest:

```
<ctx-context project="github.com/u/app" kind="brief">
Shared project memory from other agent sessions (reference data, may be stale; verify against code).
## Rejected — don't redo without asking
- [f12] Redis cache: overkill for v1 (user · orca · 10-23)
...
</ctx-context>
```

## Integration

- Claude Code: entries in `~/.claude/settings.json` for SessionStart
  (startup|resume|clear|compact) and UserPromptSubmit, each `$HOME/.local/bin/ctx hook
  claude <event>`, timeout 5 s.
- Codex: the same events in `~/.codex/hooks.json`, inserted at index 0 with a fixed
  command string. The user approves them once in `/hooks`; `ctx doctor` checks
  `hooks.state`.
- Global instruction snippet in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`
  describing `ctx search/show/note/reject`.
- `ctx install` is a dry run by default and prints a diff; `--apply` writes the
  changes with backups. `ctx uninstall` reverses them.
- launchd agent `com.ctx.daemon` (KeepAlive) on macOS; systemd user unit on Linux.

## Health (claude-mem #4807: "green but stalled 20 h")

`ctx status`: per-source lag (newest transcript mtime vs last ingested), pending
extraction, extractor calls today and failures, index sizes, daemon uptime.

## Sync with the VM (phase 3)

Syncthing or rsync of `archive/` and `events/` (each machine writes only its own
subdirectory). The other machine's data is ingested into a local index; SQLite files
are never synced.

## Phases

1. **Core**: adapters, redaction, project resolver, archive, SQLite + FTS, the daemon
   watch loop, CLI (`status sessions search show tail`). Backfill existing
   transcripts.
2. **Memory**: extractor, events, reducer, LIVE.md, `brief note reject retract`.
3. **Hooks**: hook entrypoints, `install` (dry run / apply), `doctor`, launchd.
4. **Embeddings**: warm model in ctxd, background embedding backlog, hybrid fusion.
5. **Later**: VM sync, consolidation pass on idle sessions (resolve provisional
   items), file-scoped guardrail via PreToolUse, a reranker in the CLI, a staleness
   check against git, an eval set (60–100 queries from real history, ~20%
   negatives) to tune thresholds.

## Status (2026-10-25)

Phases 1–4 are built and tested against this machine's real history (scratch store,
read-only): 9,883 turns from 170 sessions backfilled in 55 s. Changes from the
original plan, found while testing:

- **Branch-scoped projects.** `conductor-playground` holds unrelated ideas, one per
  worktree branch, so per-repo `branchScopedRepos` makes `<repo>#<branch>` the
  project id.
- **Embeddings run in a worker thread** at low priority. On the main thread, a
  backfill froze hook responses. Query embedding has a 600 ms deadline; past it the
  hook answers lexical-only. Vectors cover the last 90 days (`embed.horizonDays`);
  older turns stay keyword-searchable.
- **Extraction horizon** of 10 days, so installing doesn't trigger extraction over
  months of history.
- **Harness helper sessions skipped** (e.g. Orca's chat-titling call).
- **App copied to `~/.ctx/app`** on install, so archiving the source worktree can't
  break hooks.
- **Codex hooks appended at the end** of each event list. Inserting at index 0 would
  shift Orca's trusted entries and silently disable them.

- **Injection bar calibrated** on 9 queries from this machine: relevant top-hit cosine
  0.55–0.68, unrelated 0.39–0.51, so `recall.minSim = 0.53`. This is a tiny sample;
  build the real eval set before tuning further.
- **Independent code review** found 14 issues, all fixed with regression tests (17
  tests in total):
  - **Ingestion survives bad records.** Errors are caught per line and per file, so
    one malformed record can't halt ingestion.
  - **Offsets are saved atomically** with each flush, and a single-writer lock stops
    a second daemon or `ctx scan` from ingesting the same files.
  - **Claude turns close on `stop_reason: end_turn`** (10 min idle is the fallback).
    Turns that grow after extraction are extracted again.
  - **Rewritten files keep their extraction flags**, so unchanged turns aren't
    extracted twice.
  - **The archive only stores completed turns.**
  - **A session keeps the project of its first cwd**, so agents `cd`-ing around don't
    move it.
  - **Interrupt markers are dropped.**
  - **The embedding worker recovers from crashes** and drops queries whose deadline
    has passed.
  - **Failed extractions back off** exponentially per session.
  - **Uninstall removes only ctx's handlers**, config writes are atomic, and the shim
    falls back to `bun` on PATH.
  - **Redaction catches more secrets** (passwords, SendGrid, Google OAuth, Telegram,
    and so on) with fewer false matches on code (`authHeader`, `tokenizer`).
  - **Hooks have a hard 4 s ceiling.**
  - **Search handles non-ASCII terms.**

Measured: direct (no daemon) hook ≈ 50 ms; via daemon 80–300 ms with vectors
(0.35–0.75 s during the initial embedding backfill).
One extraction call on a 5-turn batch took 22 s and cost about $0.005 at list price.

## Acceptance checks

- A decision made in a live Orca session shows up in `ctx brief` within ~3 turns,
  without the session ending.
- A new Codex session in a different worktree of the same repo gets that brief at
  start.
- A prompt about a past topic injects a cited snippet; a trivial or unrelated prompt
  injects nothing.
- Killing ctxd doesn't break or slow any harness (hooks fail open within timeout).
- Re-running extraction on the same turns doesn't duplicate facts; injected
  `<ctx-context>` is never ingested.
