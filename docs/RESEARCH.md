# Research: shared context for AI coding agents

Before building `ctx`, we studied existing memory tools for AI agents, what their users
complain about, and what the research says about storing and retrieving memory. This page
records what we found and the choices it led to.

How to read it:

- **Section 1** lists similar projects and what each one teaches.
- **Section 2** lists the ways these tools fail in real use.
- **Section 3** compares conflicting practices, best option first. A ✅ marks what `ctx`
  does.
- **Section 4** lists facts about Claude Code and Codex, checked on the author's machine.

Research date: 2026-10-25. Most numbers are self-reported by vendors unless noted. No public
benchmark covers coding sessions yet.

## 1. What already exists

| Project | Shape | Takeaway |
|---|---|---|
| claude-mem (~103k★) | 6 hooks → background observer LLM → SQLite+FTS5+Chroma; MCP progressive search | Most popular, and the source of most complaints (below) |
| agentmemory (~30k★) | Hooks per host, BM25+vector+graph RRF, decay, supersession | Good ideas; fragile store, self-measured benchmarks |
| obra/episodic-memory | Archives `~/.claude/projects` transcripts, SQLite+sqlite-vec, local embeddings | Closest analogue to our ingestion design |
| Claude Code auto-memory | `MEMORY.md` index (first 200 lines/25KB) + topic files on demand | Small injected core, rest pulled on demand |
| Codex memories | Off by default; extract per idle rollout → one consolidation agent → `MEMORY.md`; usage-based forgetting | Two-phase write: extract, then consolidate |
| Basic Memory | Markdown source of truth + SQLite FTS/vector index, MCP | Human-editable files are the source of truth |
| Mem0 / OpenMemory | LLM extraction ADD/UPDATE/DELETE → vectors | Itself moved to ADD-only; `mem0-mcp` archived |
| Zep / Graphiti | Temporal knowledge graph, bi-temporal validity | Best stale-fact model; heavy, Zep CE deprecated |
| Supermemory | Hooks: profile at start, recall per prompt, save after response | Moved from MCP to hooks: "Claude decides when to call MCP" |
| ByteRover, Cognee, Letta, Pieces, Serena, Cline Memory Bank, SpecStory, cass | various | Review queue (ByteRover), sleep-time consolidation (Letta), transcript→markdown (SpecStory), cross-agent search TUI (cass) |

None of these combines: passive capture from *running* sessions in several harnesses
+ typed decisions/rejections + project identity across worktrees + hook injection
into both Claude Code and Codex. That gap is what we build.

## 2. Real-world failure modes (GitHub issues, HN)

1. **Token burn from the extractor.** claude-mem's observer quietly used ~2% of a Max
   20x weekly quota while mostly idle (#5023). Edit payloads (`originalFile`) were
   ~46% of the cost. One LLM call per observation overwhelmed gateways (agentmemory #1603).
2. **Junk accumulation.** A Mem0 user audited 10,134 memories and found 97.8% junk;
   "User prefers Vim" was stored 808 times because recalled memories were re-extracted
   (mem0 #4573). Root cause: permissive prompt, no quality gate, no "reject" option.
3. **Injecting every turn hurts.** Agents "drifted, revisited settled decisions"
   (claude-mem #4931). Changing content broke prompt caching (#4911); prompts got
   1–7 s slower (#4804).
4. **Wrong memories can't be fixed.** An untested hypothesis was stored as a gotcha
   and couldn't be corrected (#3897); deleting rows orphaned vectors. HN: "a lot of
   the stuff in MEMORY.md was flat out wrong".
5. **Agents ignore MCP memory tools**, even when CLAUDE.md tells them to use them.
6. **Fragile daemons.** Capture stalled silently for 20 h while health checks stayed
   green; stale PIDs; painful uninstall.
7. **Retrieval bugs.** FTS5 AND semantics return nothing for natural-language queries;
   one category crowds out the rest.
8. **Privacy.** Redacting after truncation leaked content; no secret redaction;
   plaintext files.
9. **Skepticism (HN).** "Removing from context works more often than adding."
   "Any automated memory is a failure over time." Benchmarks are mostly vendor claims.

## 3. Conflicting practices: compared and ranked

Ranked best first for *one user, local, coding agents*.

### A. What is the source of truth?
1. **Raw (redacted) transcript archive + append-only event log; facts are an index
   pointing at source turns; briefs are derived views.** ✅
2. Extracted facts only: cheap, but loses information. LongMemEval: replacing raw
   rounds with facts/summaries hurts accuracy. Zep lost 14 points on
   assistant-said questions. Mem0 scored 18 vs BM25's 56 on fact updates
   (MemoryAgentBench).
3. Rolling summaries: "context collapse" (ACE: 18k-token context → 122 tokens,
   worse than no memory).

Also: Claude Code deletes old transcripts after `cleanupPeriodDays`, so we must keep
our own archive.

### B. Who decides memory changes?
1. **The LLM proposes typed events (`add`, `supersede`, `retract`, `none`); a
   deterministic reducer builds the views.** ✅ Reversible, re-runnable, auditable.
2. LLM-executed UPDATE/DELETE (original Mem0): Mem0 itself abandoned it.
3. ADD-only, resolved at read time (new Mem0): weak on contradictions (~35 on BEAM).

### C. Data model
1. **Flat typed SQLite records + FTS5 + vectors, plus a small link table (fact↔file).** ✅
2. Knowledge graph (Graphiti/Cognee): good for multi-hop entity questions, but costly
   and weak on updates (GraphRAG scored 14). Overkill for one developer's repos.

### D. Capture path
1. **Passive background capture (tail transcripts).** ✅ Never misses a session,
   costs the agent nothing, works on chats that were already open.
2. Explicit `ctx note` / `ctx reject` for high-confidence entries. ✅ (supplement)
3. Agent self-writes via tools: unreliable ("doesn't save something every session";
   ignores MCP tools).

### E. Extraction cadence
1. **Batched incremental: when ≥N new turns, or the session goes idle (~90 s); items
   start provisional; a consolidation pass runs when the session goes idle.** ✅
   Fresh enough for parallel harnesses.
2. End of session only (Codex): too slow for side-by-side work.
3. Per message or per tool call (claude-mem, Mem0): the token-burn failure mode.

### F. How much to inject automatically
1. **SessionStart: stable, hard-capped brief (≤ ~1.5k tokens; Codex caps hook output
   at ~2.5k tokens, Claude at 10k chars). Per prompt: gated, ≤3 snippets, or silence.
   Everything else on demand via CLI (search → show).** ✅
2. Inject on every prompt: drift, cache breaks, latency.
3. Nothing automatic (pure tools): agents don't call them.

### G. Stale facts and contradictions
1. **Bi-temporal-lite: `valid_from`, `superseded_by`; at write time retrieve similar
   facts in the same scope and let the LLM emit `supersede`; render only live facts;
   flag cross-session contradictions as ⚠️ instead of auto-resolving.** ✅
2. Resolve only at read time: weak (see B3).
3. Time decay alone: decisions don't expire with age.

### H. Importance / ranking
1. **Type first (rejected/decision/gotcha don't decay; progress decays fast; done
   todos close), then source confidence (user-stated > agent-proposed-accepted >
   agent-assumed), then mild recency.** ✅
2. LLM-rated importance 1–10 (Generative Agents): unreliable with small models.

### I. Retrieval
1. **Hybrid: FTS5 BM25 (OR semantics, porter + trigram for identifiers/paths) +
   dense vectors, fused with RRF k=60, with facts boosted.** ✅ Cursor measured
   +12.5% from adding semantic search to grep. The pure-grep advantage seen in
   LongMemEval relies on an agent loop, which a single hook call doesn't have.
2. Agentic grep only: great for code and for interactive `ctx search`, but a single
   hook shot needs ranked results with a confidence signal.
3. Pure vector: misses error strings, flags and file names.

Reranker: CLI only, and only if measured to help. Contextual header on chunks
(project · branch · date · title): cheap, deterministic version of Anthropic's
Contextual Retrieval (−35% to −49% failure rate).

### J. Chunk unit
**One turn pair: user prompt + agent's final prose reply, with tool calls condensed
to command/path/error lines; extracted facts appended to the indexed text**
(LongMemEval: +9.4% recall).

### K. Vector store
1. **Float32 blobs in the same SQLite file, brute-force cosine in-process.** ✅ Tens of
   thousands of chunks take milliseconds; no extension loading (macOS system SQLite
   can't load extensions).
2. sqlite-vec 0.1.9 flat: fine, but adds the extension problem. Avoid its alpha ANN.
3. LanceDB (version churn), Chroma (heavy, orphaned vectors), Qdrant local, pgvector: no.

### L. Embeddings
1. **Local EmbeddingGemma-300M or Qwen3-Embedding-0.6B, kept warm in the daemon.** ✅
2. API embeddings (Voyage/OpenAI ~$0.02/M): cheap, but 100–400 ms query round trip and
   lock-in.

### M. Integration surface
1. **Hooks (SessionStart + UserPromptSubmit) + CLI.** ✅ Deterministic, and works in
   any harness that runs Claude Code or Codex (Orca and Conductor both do).
2. MCP: optional later; agents under-use it.

### N. Runtime
**Bun + TypeScript** (`bun:sqlite` with FTS5; `bun build --compile` gives a ~3–6 ms
start vs 14–16 ms for Node/Python). Hook = thin client to the daemon with a hard
timeout, failing open; it can fall back to direct read-only SQLite.

### O. Sync with the VM
Per-machine append-only event logs (`events/<machine>/…jsonl`) via Syncthing or rsync;
each machine rebuilds its own SQLite. Never sync live SQLite/WAL files.

### P. Security
Redact (gitleaks-style rules + entropy) **before** truncation, storage and LLM calls.
Wrap injected context in markers and strip it on ingest (stops the feedback loop).
Inject only user text and derived facts, labeled as reference data, never raw
tool/web output. Store files 0600 in a 0700 directory.

## 4. Verified integration facts (author's machine)

- Claude Code 2.1.309: transcripts in `~/.claude/projects/<enc-cwd>/<sid>.jsonl`,
  appended per turn. Records carry `cwd`, `gitBranch`, `sessionId`, `uuid`,
  `isSidechain`. Injected hook context is persisted as `attachment` records
  (`hook_success`, `hook_additional_context`). Compaction appends
  `compact_boundary` + `isCompactSummary`. Subagents go in `<sid>/subagents/*.jsonl`.
- Codex 0.163.0: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. `session_meta`
  carries `cwd`, `originator`, `git.repository_url`. Clean turns come from `event_msg`
  user/agent messages. Resumed sessions append to old dated files. Filter
  `guardian` subagent sessions.
- Hooks: both CLIs support SessionStart/UserPromptSubmit with
  `hookSpecificOutput.additionalContext`. Codex silently skips untrusted hooks until
  approved in `/hooks`; its trust key includes the handler index. The first plan was to
  put ours first (index 0). Testing showed that shifts other tools' entries and silently
  un-approves them, so `ctx` appends its hooks at the end, with a fixed command string.
- Orca and Conductor both report `entrypoint: sdk-ts`. Detect the harness from env
  vars and cwd prefix (`~/orca/workspaces/`, `~/conductor/workspaces/`).
- Worktrees of one repo share an origin URL → project id = normalized origin
  (`host/owner/repo`), falling back to the root commit, then the git common dir.
- No `ANTHROPIC_API_KEY`; extraction can run through
  `claude -p --model haiku --no-session-persistence --setting-sources "" --tools ""`
  (verified, ~3 s, ~$0.0002 list cost per small call).

## Sources

Projects: github.com/thedotmack/claude-mem (issues #5023 #4931 #4911 #4804 #3897 #4696),
github.com/rohitg00/agentmemory, github.com/obra/episodic-memory,
code.claude.com/docs/en/memory, developers.openai.com/codex/memories,
github.com/basicmachines-co/basic-memory, github.com/mem0ai/mem0/issues/4573,
supermemory.ai/blog/we-added-supermemory-to-claude-code-its-insanely-powerful-now,
help.getzep.com/ce-deprecation-notice, github.com/tobi/qmd,
news.ycombinator.com/item?id=48622590, news.ycombinator.com/item?id=47503082.

Write side: arxiv.org/abs/2504.19413 (Mem0), getzep.com/blog/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory,
arxiv.org/html/2501.13956v1 (Zep), letta.com/blog/benchmarking-ai-agent-memory,
arxiv.org/html/2410.10813v2 (LongMemEval), arxiv.org/html/2507.05257v1 (MemoryAgentBench),
arxiv.org/abs/2510.04618 (ACE), research.trychroma.com/context-rot,
anthropic.com/engineering/effective-context-engineering-for-ai-agents.

Read side: anthropic.com/news/contextual-retrieval, arxiv.org/html/2605.15184v1
(Is Grep All You Need), cursor.com/blog/semsearch, arxiv.org/abs/2210.11934 (fusion),
simonwillison.net/2024/Oct/4/hybrid-full-text-search-and-vector-search-with-sqlite,
github.com/asg017/sqlite-vec, arxiv.org/pdf/2506.05176 (Qwen3 Embedding).

Integration: code.claude.com/docs/en/hooks, learn.chatgpt.com/docs/hooks,
github.com/openai/codex (codex-rs/hooks), local files under ~/.claude and ~/.codex.
