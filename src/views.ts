// Read models and memory actions shared by the CLI and the local UI, so both show the same data.

import { existsSync, readFileSync, statSync } from "node:fs";
import { AGING, renderBrief, writeLive } from "./brief";
import { loadConfig, paths } from "./config";
import { getMeta, openDb, usageToday } from "./db";
import { duplicatePairs } from "./dedupe";
import { estimateBacklog, pendingSessions } from "./extract";
import { emit, getFact, newFactId, FACT_TYPES, type Fact, type FactType } from "./facts";
import { RECALL_LOG } from "./hooks";
import { installedChecks } from "./install";
import { inList, isMixed, projectBySlugOrId, scopeIds } from "./project";

const scope = (project: string | undefined, col: string) =>
  project ? { sql: `AND ${col} IN ${inList(scopeIds(project))}`, args: scopeIds(project) } : { sql: "", args: [] as string[] };

export interface ProjectRow {
  id: string;
  slug: string;
  sessions: number;
  facts: number;
  last: number | null;
  mixed: boolean;
  aliases: string[];
}

/** Projects that have at least one real session, most recently active first. */
export function listProjects(): ProjectRow[] {
  const aliases = loadConfig().projectAliases ?? {};
  const rows = openDb()
    .query(
      `SELECT p.slug, p.id, COUNT(DISTINCT s.id) sessions, MAX(s.last_ts) last, (SELECT COUNT(*) FROM facts f WHERE f.project = p.id AND f.status = 'active') facts
       FROM projects p LEFT JOIN sessions s ON s.project = p.id AND s.skip = 0 GROUP BY p.id ORDER BY last DESC`,
    )
    .all() as any[];
  return rows.filter((r) => r.sessions).map((r) => ({ ...r, mixed: isMixed(r.id), aliases: aliases[r.id] ?? [] }));
}

/** The brief a new session in this project receives, and its rough size in tokens. */
export function briefPreview(projectKey: string): { project: string; slug: string; text: string; chars: number; tokens: number } | undefined {
  const p = projectBySlugOrId(projectKey);
  if (!p) return undefined;
  const text = renderBrief(p, { wrap: false });
  return { project: p.id, slug: p.slug, text, chars: text.length, tokens: Math.round(text.length / 4) };
}

export function listSessions(project?: string, limit = 15): any[] {
  const s = scope(project, "s.project");
  return openDb()
    .query(`SELECT s.*, p.slug FROM sessions s LEFT JOIN projects p ON p.id = s.project WHERE s.skip = 0 AND s.turns > 0 ${s.sql} ORDER BY s.last_ts DESC LIMIT ?`)
    .all(...(s.args as any[]), limit) as any[];
}

export function sessionByPrefix(prefix: string): any {
  return openDb().query("SELECT * FROM sessions WHERE id LIKE ? ORDER BY last_ts DESC LIMIT 2").all(`${prefix}%`)[0];
}

/** A session's latest turns, oldest first. */
export function tailSession(sessionId: string, limit = 6): any[] {
  return (openDb().query("SELECT * FROM turns WHERE session_id = ? ORDER BY idx DESC LIMIT ?").all(sessionId, limit) as any[]).reverse();
}

export function listFacts(project: string, opts: { type?: string; inactive?: boolean } = {}): Fact[] {
  const s = scope(project, "project");
  return openDb()
    .query(`SELECT * FROM facts WHERE 1 = 1 ${s.sql} ${opts.inactive ? "" : "AND status = 'active'"} ${opts.type ? "AND type = ?" : ""} ORDER BY type, updated DESC`)
    .all(...([...s.args, opts.type].filter(Boolean) as string[])) as Fact[];
}

/** Old todos/gotchas and unconfirmed agent facts, not touched for `days`. */
export function reviewItems(project: string | undefined, days = loadConfig().brief.staleDays): (Fact & { slug: string })[] {
  const s = scope(project, "f.project");
  return openDb()
    .query(
      `SELECT f.*, p.slug FROM facts f LEFT JOIN projects p ON p.id = f.project
       WHERE f.status = 'active' AND f.updated < ? ${s.sql}
         AND (f.type IN ${inList(AGING)} OR (f.origin = 'agent' AND f.confidence < 0.8))
       ORDER BY p.slug, f.type, f.updated`,
    )
    .all(Date.now() / 1000 - days * 86400, ...s.args, ...AGING) as any[];
}

export function duplicates(project?: string): { keep: Fact; drop: Fact }[] {
  const s = scope(project, "project");
  return duplicatePairs(openDb().query(`SELECT * FROM facts WHERE status = 'active' ${s.sql}`).all(...s.args) as Fact[]);
}

function refreshLive(projects: Iterable<string>) {
  for (const id of new Set(projects)) {
    const p = projectBySlugOrId(id);
    if (p) writeLive(p);
  }
}

export type FactAction = "done" | "retract" | "keep";

/** Mark facts done, retract them, or keep them (re-confirm: refresh age, full confidence). */
export function applyFactAction(ids: string[], action: FactAction, why?: string): { ok: Fact[]; missing: string[] } {
  const ok: Fact[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const f = getFact(id);
    if (!f) {
      missing.push(id);
      continue;
    }
    emit([action === "keep" ? { op: "reaffirm", fact: f.id, project: f.project, confidence: 1 } : { op: action, fact: f.id, project: f.project, reason: why }]);
    ok.push(f);
  }
  refreshLive(ok.map((f) => f.project));
  return { ok, missing };
}

/** Merge each older copy into the newer fact (keeping the higher confidence). */
export function mergeDuplicates(pairs: { keep: Fact; drop: Fact }[]): number {
  if (!pairs.length) return 0;
  const events: Parameters<typeof emit>[0] = [];
  for (const { keep, drop } of pairs) {
    // supersede with an existing fact id: the insert is a no-op, the older copy points at the kept one.
    events.push({ op: "supersede", fact: keep.id, target: drop.id, project: drop.project, reason: "duplicate" });
    if (drop.confidence > keep.confidence) events.push({ op: "reaffirm", fact: keep.id, project: keep.project, confidence: drop.confidence });
  }
  emit(events);
  refreshLive(pairs.map((x) => x.keep.project));
  return pairs.length;
}

export function addNote(project: string, type: FactType, text: string, why?: string, meta: { session?: string; harness?: string } = {}) {
  if (!FACT_TYPES.includes(type)) throw new Error(`type must be one of ${FACT_TYPES.join(", ")}`);
  const [e] = emit([{ op: "add", fact: newFactId(), project, type, text, why: why || undefined, origin: "manual", confidence: 1, ...meta }]);
  refreshLive([project]);
  return e;
}

export interface Health {
  sources: { source: string; files: number; unreadBytes: number; newest: number | null }[];
  turns: number;
  embedded: number;
  sessions: number;
  facts: number;
  extract: { calls: number; failures: number; cost: number; cap: number; pending: number };
  backfill: { since: number; calls: number; sessions: number } | null;
  lastScan: number | null;
  indexBytes: number;
}

export function health(): Health {
  const db = openDb();
  const cfg = loadConfig();
  const n = (q: string) => (db.query(q).get() as any).n as number;
  const sources = Object.keys(cfg.sources).map((source) => {
    const lag = db.query("SELECT COUNT(*) n, SUM(size - offset) behind FROM files WHERE source = ?").get(source) as any;
    const newest = db.query("SELECT MAX(last_ts) t FROM sessions WHERE source = ?").get(source) as any;
    return { source, files: lag.n, unreadBytes: lag.behind ?? 0, newest: newest?.t ?? null };
  });
  const u = usageToday("extract");
  const bf = getMeta("backfill_since");
  const left = bf ? estimateBacklog(Number(bf)) : undefined;
  const last = getMeta("last_scan");
  return {
    sources,
    turns: n("SELECT COUNT(*) n FROM turns"),
    embedded: n("SELECT COUNT(*) n FROM turns WHERE embedded = 1"),
    sessions: n("SELECT COUNT(*) n FROM sessions WHERE skip = 0"),
    facts: n("SELECT COUNT(*) n FROM facts WHERE status = 'active'"),
    extract: { ...u, cap: cfg.extract.maxCallsPerDay, pending: pendingSessions().length },
    backfill: left ? { since: Number(bf), calls: left.calls, sessions: left.sessions } : null,
    lastScan: last ? Number(last) : null,
    indexBytes: existsSync(paths.db) ? statSync(paths.db).size : 0,
  };
}

export interface RecallStats {
  minSim: number;
  prompts: number;
  injected: number;
  buckets: { lo: number; n: number; threshold: boolean }[];
  near: { id: string; sim: number }[];
}

/** Per-prompt recall scores from logs/recall.jsonl, bucketed around recall.minSim. */
export function recallStats(): RecallStats {
  const minSim = loadConfig().recall.minSim;
  const lines = [RECALL_LOG() + ".1", RECALL_LOG()].filter(existsSync).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean));
  const rows = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((r) => r?.vec);
  const top = rows.map((r) => Math.max(0, ...r.hits.map((h: any) => h.sim ?? 0)));
  const buckets: RecallStats["buckets"] = [];
  for (let i = 0; i < 16; i++) {
    const lo = Math.round((0.4 + i * 0.02) * 100) / 100;
    buckets.push({ lo, n: top.filter((t) => t >= lo && t < lo + 0.02).length, threshold: minSim >= lo && minSim < lo + 0.02 });
  }
  const near = rows.flatMap((r) => r.hits.filter((h: any) => h.sim !== undefined && h.sim < minSim && h.sim >= minSim - 0.03)).slice(-8);
  return { minSim, prompts: rows.length, injected: rows.filter((r) => r.hits.some((h: any) => h.used)).length, buckets, near };
}

export interface Check {
  ok: boolean;
  name: string;
  detail: string;
}

/** Install and runtime checks that don't need the daemon (doctor adds "ctxd running"). */
export function doctorChecks(): Check[] {
  const checks: Check[] = installedChecks();
  const claudeOk = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  checks.push({ ok: claudeOk, name: "claude CLI (extractor)", detail: claudeOk ? "found" : "not on PATH, extraction disabled" });
  const logFile = `${paths.logs}/ctxd.log`;
  if (existsSync(logFile)) {
    // Only errors since the daemon last started count as current problems.
    const lines = readFileSync(logFile, "utf8").split("\n").slice(-2000);
    const start = lines.findLastIndex((l) => l.includes("ctxd starting"));
    const errs = lines.slice(Math.max(0, start)).filter((l) => /failed|error/i.test(l));
    checks.push({ ok: errs.length === 0, name: "daemon errors since start", detail: errs.length ? errs.slice(-3).join(" | ") : "none" });
  }
  return checks;
}
