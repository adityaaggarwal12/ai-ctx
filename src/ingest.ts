import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { claudeAdapter } from "./adapters/claude";
import { codexAdapter } from "./adapters/codex";
import type { Adapter, FileState, Op } from "./adapters/types";
import { oneLine } from "./adapters/types";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";
import { detectHarness, resolveProject, scopeProject } from "./project";
import { redact } from "./redact";

export interface TurnRow {
  id: string;
  session_id: string;
  project: string | null;
  machine: string;
  source: string;
  harness: string | null;
  branch: string | null;
  idx: number;
  ts_start: number;
  ts_end: number;
  user: string;
  assistant: string;
  tools: string;
  files: string;
  complete: number;
}

interface SessionRow {
  id: string;
  source: string;
  harness: string | null;
  machine: string;
  project: string | null;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  started: number | null;
  last_ts: number | null;
  turns: number;
  skip: number;
}

const USER_MAX = 8000;
const ASSIST_HEAD = 1500;
const ASSIST_TAIL = 4500;
const TOOL_LINES = 40;

function capAssistant(s: string): string {
  if (s.length <= ASSIST_HEAD + ASSIST_TAIL + 20) return s;
  return s.slice(0, ASSIST_HEAD) + "\n…\n" + s.slice(-ASSIST_TAIL);
}

export function ftsBody(t: Pick<TurnRow, "user" | "assistant" | "tools" | "branch" | "harness" | "ts_start">, projectSlug?: string, extra = ""): string {
  const date = new Date(t.ts_start * 1000).toISOString().slice(0, 10);
  const header = [projectSlug, t.branch, t.harness, date].filter(Boolean).join(" · ");
  return `${header}\n${t.user}\n${t.assistant}\n${t.tools}${extra ? "\n" + extra : ""}`;
}

class Batch {
  db = openDb();
  turns = new Map<string, TurnRow>();
  sessions = new Map<string, SessionRow>();
  machine = loadConfig().machine;

  session(id: string, source: string): SessionRow {
    let s = this.sessions.get(id);
    if (!s) {
      s =
        (this.db.query("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | null) ??
        ({ id, source, harness: null, machine: this.machine, project: null, cwd: null, branch: null, title: null, started: null, last_ts: null, turns: 0, skip: 0 } as SessionRow);
      this.sessions.set(id, s);
    }
    return s;
  }

  turn(id: string): TurnRow | undefined {
    let t = this.turns.get(id);
    if (!t) {
      t = (this.db.query("SELECT id, session_id, project, machine, source, harness, branch, idx, ts_start, ts_end, user, assistant, tools, files, complete FROM turns WHERE id = ?").get(id) as TurnRow | null) ?? undefined;
      if (t) this.turns.set(id, t);
    }
    return t;
  }

  /** Commit buffered turns/sessions, plus the file offset they correspond to, in one transaction. */
  flush(file?: { path: string; source: string; ino: number; size: number; offset: number; mtime: number; state: FileState }) {
    const db = this.db;
    const slugs = new Map<string, string>();
    const slugOf = (p: string | null) => {
      if (!p) return undefined;
      if (!slugs.has(p)) slugs.set(p, (db.query("SELECT slug FROM projects WHERE id = ?").get(p) as any)?.slug ?? "");
      return slugs.get(p);
    };
    // A turn that grew noticeably after extraction is extracted again (its ending usually holds the outcome).
    const upTurn = db.query(`INSERT INTO turns(id, session_id, project, machine, source, harness, branch, idx, ts_start, ts_end, user, assistant, tools, files, complete)
      VALUES ($id, $session_id, $project, $machine, $source, $harness, $branch, $idx, $ts_start, $ts_end, $user, $assistant, $tools, $files, $complete)
      ON CONFLICT(id) DO UPDATE SET project=excluded.project, harness=excluded.harness, branch=excluded.branch, ts_end=excluded.ts_end,
        user=excluded.user, assistant=excluded.assistant, tools=excluded.tools, files=excluded.files, complete=excluded.complete,
        embedded = CASE WHEN length(excluded.user) + length(excluded.assistant) = length(turns.user) + length(turns.assistant) THEN turns.embedded ELSE 0 END,
        extracted = CASE WHEN turns.extracted = 1 AND length(excluded.user) + length(excluded.assistant) > turns.extracted_len + 300 THEN 0 ELSE turns.extracted END`);
    const archivedLen = db.query("SELECT archived_len FROM turns WHERE id = ?");
    const setArchived = db.query("UPDATE turns SET archived_len = ? WHERE id = ?");
    const upFile = db.query(
      `INSERT INTO files(path, source, ino, size, offset, mtime, session_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET ino=excluded.ino, size=excluded.size, offset=excluded.offset, mtime=excluded.mtime,
         session_id=excluded.session_id, state=excluded.state`,
    );
    const delFts = db.query("DELETE FROM turns_fts WHERE turn_id = ?");
    const insFts = db.query("INSERT INTO turns_fts(turn_id, body) VALUES (?, ?)");
    const upSess = db.query(`INSERT INTO sessions(id, source, harness, machine, project, cwd, branch, title, started, last_ts, turns, skip)
      VALUES ($id, $source, $harness, $machine, $project, $cwd, $branch, $title, $started, $last_ts, $turns, $skip)
      ON CONFLICT(id) DO UPDATE SET harness=excluded.harness, project=excluded.project, cwd=excluded.cwd, branch=excluded.branch,
        title=excluded.title, started=excluded.started, last_ts=excluded.last_ts, turns=excluded.turns, skip=excluded.skip`);
    const archived = new Map<string, string[]>();
    db.transaction(() => {
      for (const s of this.sessions.values()) {
        const p: any = {};
        for (const [k, v] of Object.entries(s)) p["$" + k] = v ?? null;
        upSess.run(p);
      }
      for (const t of this.turns.values()) {
        const p: any = {};
        for (const [k, v] of Object.entries(t)) p["$" + k] = v ?? null;
        upTurn.run(p);
        delFts.run(t.id);
        insFts.run(t.id, ftsBody(t, slugOf(t.project)));
        // Archive completed turns only (and again only if they changed since).
        const len = t.user.length + t.assistant.length + t.tools.length;
        if (t.complete && (archivedLen.get(t.id) as any)?.archived_len !== len) {
          const key = `${t.source}/${t.session_id}`;
          if (!archived.has(key)) archived.set(key, []);
          archived.get(key)!.push(JSON.stringify(t));
          setArchived.run(len, t.id);
        }
      }
      if (file) upFile.run(file.path, file.source, file.ino, file.size, file.offset, file.mtime, file.state.sessionId ?? null, JSON.stringify(file.state));
    })();
    for (const [key, lines] of archived) {
      const file = join(paths.archive, this.machine, `${key}.jsonl`);
      const dir = file.slice(0, file.lastIndexOf("/"));
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
    }
    this.turns.clear();
    this.sessions.clear();
  }
}

function applyOps(batch: Batch, adapter: Adapter, state: FileState, ops: Op[]) {
  const prefix = adapter.source === "claude" ? "c" : "x";
  for (const op of ops) {
    if (op.kind === "session") {
      const s = batch.session(op.id, adapter.source);
      const cfg = loadConfig();
      // Agents cd around (node_modules, other repos); the session belongs to where it started.
      const firstCwd = Boolean(op.cwd && !s.cwd);
      const branchChanged = Boolean(op.branch && op.branch !== s.branch);
      if (op.cwd && firstCwd) {
        s.cwd = op.cwd;
        if (op.cwd.startsWith(paths.home + "/") || cfg.ignoreCwd.some((p) => op.cwd!.includes(p))) s.skip = 1;
        s.harness = detectHarness(op.cwd, op.harness ?? (s.harness && s.harness !== "cli" ? s.harness : undefined));
      }
      if (op.harness) s.harness = op.harness;
      if (op.branch && (firstCwd || !s.branch || op.cwd === s.cwd || !op.cwd)) s.branch = op.branch;
      if ((firstCwd || (branchChanged && s.branch === op.branch)) && s.cwd && !s.skip) {
        const base = resolveProject(s.cwd, op.remote);
        s.project = scopeProject(base, s.branch ?? undefined, cfg.branchScopedRepos)?.id ?? null;
      }
      if (op.title) s.title = oneLine(redact(op.title), 100);
      if (op.skip) s.skip = 1;
      if (op.ts && !s.started) s.started = op.ts;
      state.sessionId = op.id;
      continue;
    }
    const sid = state.sessionId;
    if (!sid) continue;
    const s = batch.session(sid, adapter.source);
    if (s.skip) continue;

    if (op.kind === "turn") {
      const id = `${prefix}:${sid}:${op.key}`;
      const text = redact(op.user);
      const existing = batch.turn(id);
      if (existing) {
        if (op.append && !existing.user.includes(text)) existing.user = (existing.user + "\n" + text).slice(0, USER_MAX);
        existing.ts_end = Math.max(existing.ts_end, op.ts);
      } else {
        if (state.curTurn && state.curTurn !== id) {
          const prev = batch.turn(state.curTurn as string);
          if (prev) prev.complete = 1;
        }
        batch.turns.set(id, {
          id,
          session_id: sid,
          project: s.project,
          machine: batch.machine,
          source: adapter.source,
          harness: s.harness,
          branch: s.branch,
          idx: state.idx++,
          ts_start: op.ts,
          ts_end: op.ts,
          user: text.slice(0, USER_MAX),
          assistant: "",
          tools: "",
          files: "[]",
          complete: 0,
        });
        s.turns = Math.max(s.turns, state.idx);
        if (!s.title) s.title = oneLine(text, 100);
      }
      state.curTurn = id;
      s.last_ts = Math.max(s.last_ts ?? 0, op.ts);
      continue;
    }

    const tid = op.turnKey ? `${prefix}:${sid}:${op.turnKey}` : (state.curTurn as string | undefined);
    const t = tid ? batch.turn(tid) : undefined;
    if (!t) continue;
    t.ts_end = Math.max(t.ts_end, op.ts);
    s.last_ts = Math.max(s.last_ts ?? 0, op.ts);
    if (op.kind === "assistant") {
      t.assistant = capAssistant((t.assistant ? t.assistant + "\n" : "") + redact(op.text));
    } else if (op.kind === "tool") {
      const lines = t.tools ? t.tools.split("\n") : [];
      if (lines.length < TOOL_LINES) {
        lines.push(redact(op.line));
        t.tools = lines.join("\n");
      }
      if (op.files?.length) {
        const files = new Set<string>(JSON.parse(t.files));
        for (const f of op.files) if (files.size < 50) files.add(f);
        t.files = JSON.stringify([...files]);
      }
    } else if (op.kind === "turn-end") {
      t.complete = 1;
    }
  }
}

const adapters: Adapter[] = [claudeAdapter, codexAdapter];

function quickRelevant(adapter: Adapter, line: string): boolean {
  const head = line.slice(0, 400);
  if (adapter.source === "claude") {
    return /"type":"(user|assistant|ai-title)"/.test(line.length > 4000 ? head + line.slice(-600) : line);
  }
  return head.includes('"type":"event_msg"') || head.includes('"type":"session_meta"');
}

/** Ingest new bytes of one transcript file. Returns number of records parsed. */
export function ingestFile(path: string, adapter: Adapter): number {
  const db = openDb();
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  const row = db.query("SELECT ino, size, offset, state FROM files WHERE path = ?").get(path) as
    | { ino: number; size: number; offset: number; state: string }
    | null;
  let offset = row?.offset ?? 0;
  let state: FileState = row?.state ? JSON.parse(row.state) : { idx: 0 };
  const batch = new Batch();
  let restore: { id: string; extracted: number; extracted_len: number }[] = [];

  if (row && (row.ino !== st.ino || st.size < row.offset)) {
    // Rewritten or replaced: re-read from the start. Keep extraction flags for turns that
    // come back unchanged so we don't pay to extract them again.
    if (state.sessionId) {
      restore = db.query("SELECT id, extracted, extracted_len FROM turns WHERE session_id = ?").all(state.sessionId) as any[];
      db.transaction(() => {
        db.query("DELETE FROM turns_fts WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ?)").run(state.sessionId!);
        db.query("DELETE FROM vectors WHERE kind = 'turn' AND id IN (SELECT id FROM turns WHERE session_id = ?)").run(state.sessionId!);
        db.query("DELETE FROM turns WHERE session_id = ?").run(state.sessionId!);
      })();
    }
    offset = 0;
    state = { idx: 0 };
  }
  if (st.size === offset) return 0;

  const fileRow = (off: number) => ({ path, source: adapter.source, ino: st.ino, size: st.size, offset: off, mtime: st.mtimeMs / 1000, state });
  const fd = openSync(path, "r");
  let parsed = 0;
  let bad = 0;
  try {
    const CHUNK = 8 * 1024 * 1024;
    let pos = offset;
    let carry = Buffer.alloc(0);
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      pos += len;
      const data = carry.length ? Buffer.concat([carry, buf]) : buf;
      const lastNl = data.lastIndexOf(10);
      if (lastNl === -1) {
        carry = data;
        continue;
      }
      const text = data.subarray(0, lastNl).toString("utf8");
      carry = Buffer.from(data.subarray(lastNl + 1));
      for (const line of text.split("\n")) {
        if (!line || !quickRelevant(adapter, line)) continue;
        try {
          const rec = JSON.parse(line);
          parsed++;
          applyOps(batch, adapter, state, adapter.parse(rec, state));
        } catch {
          bad++; // one malformed or unexpected record must never stop ingestion
        }
      }
      if (batch.turns.size > 500) batch.flush(fileRow(pos - carry.length));
    }
    offset = st.size - carry.length; // never consume a partial trailing line
  } finally {
    closeSync(fd);
  }
  batch.flush(fileRow(offset));
  if (restore.length) {
    const q = db.query("UPDATE turns SET extracted = ?, extracted_len = ? WHERE id = ? AND length(user) + length(assistant) <= ? + 300");
    db.transaction(() => restore.forEach((r) => r.extracted && q.run(r.extracted, r.extracted_len, r.id, r.extracted_len)))();
  }
  if (bad) logIngest(`${path}: skipped ${bad} unparseable records`);
  return parsed;
}

let logIngest: (msg: string) => void = () => {};
export function setIngestLogger(fn: (msg: string) => void) {
  logIngest = fn;
}

export function adapterFor(path: string): Adapter | undefined {
  const cfg = loadConfig();
  for (const a of adapters) {
    const roots = cfg.sources[a.source];
    if (roots.some((r) => path.startsWith(r + "/")) && a.accepts(path)) return a;
  }
  return undefined;
}

interface Candidate {
  path: string;
  mtime: number;
  adapter: Adapter;
}

/** Files under the source roots that changed since we last read them, oldest first per source. */
function changedFiles(sinceDays?: number): Candidate[] {
  const cfg = loadConfig();
  const db = openDb();
  const known = new Map<string, { size: number; ino: number }>();
  for (const r of db.query("SELECT path, size, ino FROM files").all() as any[]) known.set(r.path, r);
  const cutoff = sinceDays ? Date.now() - sinceDays * 86400_000 : 0;
  const out: Candidate[] = [];
  for (const a of adapters) {
    const mine: Candidate[] = [];
    for (const root of cfg.sources[a.source]) {
      if (!existsSync(root)) continue;
      for (const rel of new Glob("**/*.jsonl").scanSync({ cwd: root, onlyFiles: true })) {
        const path = join(root, rel);
        if (!a.accepts(path)) continue;
        let st;
        try {
          st = statSync(path);
        } catch {
          continue;
        }
        if (st.mtimeMs < cutoff) continue;
        const k = known.get(path);
        if (k && k.size === st.size && k.ino === st.ino) continue;
        mine.push({ path, mtime: st.mtimeMs, adapter: a });
      }
    }
    // oldest first so turn order and "latest" views come out right
    mine.sort((x, y) => x.mtime - y.mtime);
    out.push(...mine);
  }
  return out;
}

function ingestCandidate(c: Candidate, opts: { onFile?: (path: string, n: number) => void }): number {
  try {
    const n = ingestFile(c.path, c.adapter);
    opts.onFile?.(c.path, n);
    return n;
  } catch (e: any) {
    logIngest(`ingest ${c.path} failed: ${e?.message ?? e}`);
    return 0;
  }
}

/** Scan all source roots and ingest anything that changed. */
export function scanAll(opts: { onFile?: (path: string, n: number) => void; sinceDays?: number } = {}): { files: number; records: number } {
  let records = 0;
  const files = changedFiles(opts.sinceDays);
  for (const c of files) records += ingestCandidate(c, opts);
  return { files: files.length, records };
}

/** Same as scanAll, but yields to the event loop between files so the daemon keeps answering hooks. */
export async function scanAllAsync(opts: { onFile?: (path: string, n: number) => void; sinceDays?: number } = {}): Promise<{ files: number; records: number }> {
  let records = 0;
  const files = changedFiles(opts.sinceDays);
  for (const c of files) {
    records += ingestCandidate(c, opts);
    await new Promise((r) => setImmediate(r));
  }
  return { files: files.length, records };
}

/** Turns with no activity for a while are considered complete. */
export function closeIdleTurns(idleSeconds = 600) {
  openDb()
    .query("UPDATE turns SET complete = 1 WHERE complete = 0 AND ts_end < ?")
    .run(Date.now() / 1000 - idleSeconds);
}
