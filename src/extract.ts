// Batched, gated fact extraction. The model proposes events; facts.ts applies them.

import { oneLine } from "./adapters/types";
import { writeLive } from "./brief";
import { loadConfig, paths } from "./config";
import { bumpUsage, getMeta, openDb, usageToday } from "./db";
import { factWords, findDuplicate, similarity, strongerOrigin, DUP_SIM } from "./dedupe";
import { activeFacts, emit, FACT_TYPES, newFactId, type Fact, type FactEvent } from "./facts";
import { ftsBody } from "./ingest";
import { inList, projectBySlugOrId, scopeIds } from "./project";
import { ftsQuery, queryTerms } from "./search";

export const SYSTEM = `You maintain a shared project memory for AI coding agents. Several agent sessions (different tools) work on the same project; your notes are how they learn what was decided in other sessions.

You receive EXISTING MEMORY (with ids) and NEW TURNS from one session. Propose memory operations. Most batches deserve ZERO operations: return {"ops": []} unless something will change how a future session should act.

Capture only:
- decision: a choice the user made or accepted, with its reason ("use SQLite, not Postgres — single user").
- rejected: an option that was considered and turned down or reverted, with the reason. Highest value: it stops future agents from redoing it. Cues: "instead of", "let's not", "revert", "tried X but", the user saying no to a proposal.
- preference: how the user wants agents to work (style, tools, process) — corrections are strong signals.
- gotcha: a non-obvious trap that cost time (env, versions, flaky test, API quirk) and how to avoid it.
- todo: an open follow-up the user wants done later. Use "done" on an existing todo when it is completed.
- progress: a meaningful milestone finished (not routine edits).

Never capture: things obvious from reading the code or git history, routine edits, the agent's plans or speculation that the user did not confirm, secrets, anything inside <ctx-context> blocks, or facts already in EXISTING MEMORY (use "reaffirm" only if it was explicitly re-confirmed).

Rules:
- If a new fact replaces or contradicts an existing one, use "supersede" with target = the existing id.
- If an existing fact turns out to be wrong, use "retract" with target.
- origin: "user" = the user stated it; "agreed" = the agent proposed and the user accepted or did not object while work proceeded on it; "agent" = the agent assumed it without confirmation.
- confidence 0..1. Require a reason for decisions/rejections; without one, confidence <= 0.5.
- text: one self-contained sentence a different agent can act on without this conversation; name the concrete thing (file, library, feature). why: short reason.
- turn: the T-number where it was established. quote: <= 15 words copied from that turn.`;

const SCHEMA = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["add", "supersede", "retract", "done", "reaffirm"] },
          target: { type: "string" },
          type: { type: "string", enum: [...FACT_TYPES] },
          text: { type: "string" },
          why: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          origin: { type: "string", enum: ["user", "agreed", "agent"] },
          confidence: { type: "number" },
          turn: { type: "integer" },
          quote: { type: "string" },
        },
        required: ["op"],
      },
    },
  },
  required: ["ops"],
};

interface Proposed {
  op: FactEvent["op"];
  target?: string;
  type?: Fact["type"];
  text?: string;
  why?: string;
  files?: string[];
  origin?: "user" | "agreed" | "agent";
  confidence?: number;
  turn?: number;
  quote?: string;
}

export interface LlmResult {
  ops: Proposed[];
  cost: number;
}

export type Llm = (system: string, prompt: string) => Promise<LlmResult>;

export const claudeCli: Llm = async (system, prompt) => {
  const model = loadConfig().extract.model;
  const proc = Bun.spawn(
    [
      "claude",
      "-p",
      "--model",
      model,
      "--no-session-persistence",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
      "--disable-slash-commands",
      "--system-prompt",
      system,
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--output-format",
      "json",
    ],
    { cwd: paths.runtime, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe", env: { ...process.env, CTX_INTERNAL: "1" } },
  );
  const timer = setTimeout(() => proc.kill(), 180_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  await proc.exited;
  let parsed: any;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`extractor returned non-JSON (exit ${proc.exitCode}): ${oneLine(err || out, 300)}`);
  }
  if (parsed.is_error) throw new Error(`extractor error: ${oneLine(String(parsed.result ?? ""), 300)}`);
  const so = parsed.structured_output ?? JSON.parse(parsed.result ?? "{}");
  return { ops: Array.isArray(so?.ops) ? so.ops : [], cost: Number(parsed.total_cost_usd ?? 0) };
};

interface TurnRow {
  id: string;
  session_id: string;
  project: string;
  harness: string | null;
  branch: string | null;
  idx: number;
  ts_start: number;
  user: string;
  assistant: string;
  tools: string;
}

const TRIVIAL = /^(y|yes|no|ok|okay|k|sure|continue|go|go ahead|do it|proceed|thanks|thank you|ty|great|nice|cool|\/\S+)\W*$/i;

/** The extractor's user message: existing memory (with ids it can target) plus the new turn blocks. */
export function buildPrompt(slug: string, existing: Pick<Fact, "id" | "type" | "text" | "why">[], blocks: string[]): string {
  const memory = existing.length ? existing.map((f) => `[${f.id}] ${f.type}: ${f.text}${f.why ? " — " + f.why : ""}`).join("\n") : "(empty)";
  return `PROJECT: ${slug}\n\nEXISTING MEMORY:\n${memory}\n\nNEW TURNS:\n${blocks.join("\n\n")}\n\nReturn {"ops": [...]} (usually empty).`;
}

export function turnBlock(t: Pick<TurnRow, "ts_start" | "harness" | "branch" | "user" | "assistant" | "tools">, n: number): string {
  const date = new Date(t.ts_start * 1000).toISOString().slice(0, 16).replace("T", " ");
  const tools = t.tools ? t.tools.split("\n").slice(0, 12).join("\n") : "";
  const assistant = t.assistant.length > 1800 ? "…" + t.assistant.slice(-1800) : t.assistant;
  return `### T${n} (${date}, ${t.harness ?? "?"}, branch ${t.branch ?? "?"})\nUSER: ${t.user.slice(0, 2500)}\nAGENT: ${assistant}${tools ? `\nTOOLS:\n${tools}` : ""}`;
}

function relevantFacts(project: string, text: string): Fact[] {
  const db = openDb();
  const all = activeFacts(project);
  if (all.length <= 40) return all;
  const picked = new Map<string, Fact>();
  for (const f of all.slice(0, 15)) picked.set(f.id, f);
  const terms = queryTerms(text).slice(0, 16);
  if (terms.length) {
    const rows = db
      .query(
        `SELECT f.id FROM facts_fts JOIN facts f ON f.id = facts_fts.fact_id WHERE facts_fts MATCH ? AND f.project IN ${inList(scopeIds(project))} AND f.status = 'active' ORDER BY bm25(facts_fts) LIMIT 40`,
      )
      .all(ftsQuery(terms), ...scopeIds(project)) as { id: string }[];
    for (const r of rows) {
      const f = all.find((x) => x.id === r.id);
      if (f && picked.size < 40) picked.set(f.id, f);
    }
  }
  return [...picked.values()];
}

/** Oldest turn time extraction covers: horizonDays back, or further while a `ctx backfill` is set. */
export function extractSince(now = Date.now() / 1000): number {
  const recent = now - loadConfig().extract.horizonDays * 86400;
  const backfill = Number(getMeta("backfill_since") ?? 0);
  return backfill ? Math.min(recent, backfill) : recent;
}

/** Sessions with enough completed, unextracted turns (or idle ones with any). Newest first, so live chats beat a backfill. */
export function pendingSessions(now = Date.now() / 1000): { session_id: string; project: string; n: number }[] {
  const cfg = loadConfig().extract;
  return openDb()
    .query(
      `SELECT t.session_id, t.project, COUNT(*) n, MAX(t.ts_end) last FROM turns t JOIN sessions s ON s.id = t.session_id
       LEFT JOIN extract_state x ON x.session_id = t.session_id
       WHERE t.extracted = 0 AND t.complete = 1 AND t.project IS NOT NULL AND s.skip = 0 AND t.ts_end > ?
         AND COALESCE(x.next_at, 0) <= ${now}
       GROUP BY t.session_id, t.project HAVING n >= ? OR last < ?
       ORDER BY last DESC`,
    )
    .all(extractSince(now), cfg.minTurns, now - cfg.idleSeconds) as any[];
}

export interface ExtractReport {
  session: string;
  turns: number;
  ops: number;
  skipped?: string;
  cost?: number;
}

/** Extract one batch from a session. */
export async function extractSession(sessionId: string, project: string, llm: Llm = claudeCli): Promise<ExtractReport> {
  const cfg = loadConfig().extract;
  const db = openDb();
  const turns = db
    .query(
      `SELECT id, session_id, project, harness, branch, idx, ts_start, user, assistant, tools FROM turns
       WHERE session_id = ? AND project = ? AND extracted = 0 AND complete = 1 ORDER BY idx`,
    )
    .all(sessionId, project) as TurnRow[];
  // Record what length we extracted; if the turn grew meanwhile, leave it pending.
  const lenOf = new Map(turns.map((t) => [t.id, t.user.length + t.assistant.length]));
  const markDone = (ids: string[]) => {
    const q = db.query(
      "UPDATE turns SET extracted = CASE WHEN length(user) + length(assistant) > ?1 + 300 THEN 0 ELSE 1 END, extracted_len = ?1 WHERE id = ?2",
    );
    db.transaction(() => ids.forEach((id) => q.run(lenOf.get(id) ?? 0, id)))();
  };
  const substantive = turns.filter((t) => !(TRIVIAL.test(t.user.trim()) && t.assistant.length < 400));
  if (!substantive.length) {
    markDone(turns.map((t) => t.id));
    return { session: sessionId, turns: turns.length, ops: 0, skipped: "trivial" };
  }
  if (usageToday("extract").calls >= cfg.maxCallsPerDay) return { session: sessionId, turns: turns.length, ops: 0, skipped: "daily budget" };

  // Fit as many turns as the input cap allows; the rest wait for the next batch.
  const blocks: string[] = [];
  const used: TurnRow[] = [];
  let size = 0;
  for (const t of substantive) {
    const b = turnBlock(t, used.length + 1);
    if (used.length && size + b.length > cfg.maxInputChars) break;
    blocks.push(b.slice(0, cfg.maxInputChars));
    used.push(t);
    size += b.length;
  }
  const lastUsedIdx = used[used.length - 1].idx;
  const covered = turns.filter((t) => t.idx <= lastUsedIdx).map((t) => t.id);

  const existing = relevantFacts(project, blocks.join("\n"));
  const proj = projectBySlugOrId(project);
  const prompt = buildPrompt(proj?.slug ?? project, existing, blocks);

  let res: LlmResult;
  try {
    res = await llm(SYSTEM, prompt);
    bumpUsage("extract", { calls: 1, cost: res.cost });
  } catch (e) {
    bumpUsage("extract", { calls: 1, failures: 1 });
    throw e;
  }

  const known = new Set(existing.map((f) => f.id));
  // The model only saw `existing`; check every active fact so reworded copies replace the original.
  const everything = activeFacts(project);
  const session = db.query("SELECT harness FROM sessions WHERE id = ?").get(sessionId) as any;
  const events: Omit<FactEvent, "id" | "machine" | "ts">[] = [];
  for (const o of res.ops) {
    const src = o.turn && used[o.turn - 1] ? [used[o.turn - 1].id] : used.map((t) => t.id).slice(-1);
    const base = { project, session: sessionId, harness: session?.harness ?? undefined, turns: src };
    if (o.op === "add" || o.op === "supersede") {
      if (!o.text || !o.type || !FACT_TYPES.includes(o.type)) continue;
      if (o.op === "supersede" && (!o.target || !known.has(o.target))) o.op = "add";
      // The same batch saying one thing twice keeps the first.
      const words = factWords(o.text);
      if (events.some((e) => e.type === o.type && e.text && similarity(words, factWords(e.text)) >= DUP_SIM)) continue;
      if (o.op === "add") {
        const dup = findDuplicate(o.text, o.type, everything.filter((f) => !events.some((e) => e.target === f.id)));
        if (dup) {
          o.op = "supersede";
          o.target = dup.id;
          o.origin = strongerOrigin(o.origin ?? "agent", dup.origin === "manual" ? "user" : dup.origin);
          o.confidence = Math.max(o.confidence ?? 0.5, dup.confidence);
        }
      }
      events.push({
        ...base,
        op: o.op,
        fact: newFactId(),
        target: o.op === "supersede" ? o.target : undefined,
        type: o.type,
        text: oneLine(o.text, 400),
        why: o.why ? oneLine(o.why, 300) : undefined,
        files: (o.files ?? []).slice(0, 10),
        origin: o.origin ?? "agent",
        confidence: Math.max(0, Math.min(1, o.confidence ?? 0.5)),
        quote: o.quote ? oneLine(o.quote, 160) : undefined,
      });
    } else if ((o.op === "retract" || o.op === "done" || o.op === "reaffirm") && o.target && known.has(o.target)) {
      const confidence = o.confidence === undefined ? undefined : Math.max(0, Math.min(1, Number(o.confidence) || 0));
      events.push({ ...base, op: o.op, fact: o.target, confidence, reason: o.why });
    }
  }
  const emitted = emit(events);

  // Index facts alongside their source turns (raw + extracted keys retrieve better than either).
  const slug = proj?.slug;
  for (const e of emitted) {
    if (!e.text) continue;
    for (const tid of e.turns ?? []) {
      const t = db.query("SELECT user, assistant, tools, branch, harness, ts_start FROM turns WHERE id = ?").get(tid) as any;
      if (!t) continue;
      const facts = emitted.filter((x) => x.text && x.turns?.includes(tid)).map((x) => `${x.type}: ${x.text}`).join("\n");
      db.query("DELETE FROM turns_fts WHERE turn_id = ?").run(tid);
      db.query("INSERT INTO turns_fts(turn_id, body) VALUES (?, ?)").run(tid, ftsBody(t, slug, facts));
    }
  }
  markDone(covered);
  if (proj) writeLive(proj);
  return { session: sessionId, turns: covered.length, ops: emitted.length, cost: res.cost };
}

/** Run extraction for everything pending (bounded per call). */
export async function extractPending(opts: { maxSessions?: number; llm?: Llm; log?: (r: ExtractReport) => void } = {}): Promise<ExtractReport[]> {
  if (!loadConfig().extract.enabled) return [];
  const out: ExtractReport[] = [];
  for (const p of pendingSessions().slice(0, opts.maxSessions ?? 4)) {
    const db = openDb();
    try {
      const r = await extractSession(p.session_id, p.project, opts.llm);
      db.query("DELETE FROM extract_state WHERE session_id = ?").run(p.session_id);
      out.push(r);
      opts.log?.(r);
      if (r.skipped === "daily budget") break;
    } catch (e: any) {
      // Exponential backoff per session (1m, 2m, 4m … capped at 6h) so one bad session can't drain the budget.
      const prev = (db.query("SELECT failures FROM extract_state WHERE session_id = ?").get(p.session_id) as any)?.failures ?? 0;
      const wait = Math.min(6 * 3600, 60 * 2 ** prev);
      db.query(
        `INSERT INTO extract_state(session_id, failures, next_at, last_error) VALUES (?, 1, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET failures = failures + 1, next_at = excluded.next_at, last_error = excluded.last_error`,
      ).run(p.session_id, Date.now() / 1000 + wait, String(e?.message ?? e).slice(0, 500));
      out.push({ session: p.session_id, turns: 0, ops: 0, skipped: `error (retry in ${Math.round(wait / 60)}m): ${e.message}` });
      opts.log?.(out[out.length - 1]);
    }
  }
  return out;
}

/** Rough size of extracting everything pending since `since`: sessions, turns and model calls. */
export function estimateBacklog(since: number): { sessions: number; turns: number; calls: number } {
  const cfg = loadConfig().extract;
  const rows = openDb()
    .query(
      `SELECT t.id, t.session_id, t.project, t.harness, t.branch, t.idx, t.ts_start, t.user, t.assistant, t.tools FROM turns t JOIN sessions s ON s.id = t.session_id
       WHERE t.extracted = 0 AND t.complete = 1 AND t.project IS NOT NULL AND s.skip = 0 AND t.ts_end > ? ORDER BY t.session_id, t.idx`,
    )
    .all(since) as TurnRow[];
  const chars = new Map<string, number>();
  let turns = 0;
  for (const t of rows) {
    if (TRIVIAL.test(t.user.trim()) && t.assistant.length < 400) continue;
    turns++;
    chars.set(t.session_id, (chars.get(t.session_id) ?? 0) + Math.min(turnBlock(t, 1).length, cfg.maxInputChars));
  }
  let calls = 0;
  for (const n of chars.values()) calls += Math.ceil(n / cfg.maxInputChars);
  return { sessions: chars.size, turns, calls };
}
