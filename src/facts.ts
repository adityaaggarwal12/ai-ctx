// Facts are derived from an append-only event log (events/<machine>/YYYY-MM.jsonl).
// The LLM only proposes events; this reducer is the single place state changes.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";
import { dropVector } from "./embed";
import { inList, scopeIds } from "./project";

export const FACT_TYPES = ["decision", "rejected", "gotcha", "todo", "progress", "preference"] as const;
export type FactType = (typeof FACT_TYPES)[number];
export type Origin = "user" | "agreed" | "agent" | "manual";

export interface FactEvent {
  id: string; // event id
  ts: number;
  machine: string;
  project: string;
  op: "add" | "supersede" | "retract" | "done" | "reaffirm";
  fact: string; // fact id the event creates or targets
  target?: string; // for supersede: the fact being replaced
  type?: FactType;
  text?: string;
  why?: string;
  files?: string[];
  origin?: Origin;
  confidence?: number;
  session?: string;
  harness?: string;
  turns?: string[];
  quote?: string;
  reason?: string;
}

export interface Fact {
  id: string;
  project: string;
  type: FactType;
  text: string;
  why: string | null;
  files: string;
  origin: Origin;
  confidence: number;
  status: "active" | "superseded" | "retracted" | "done";
  superseded_by: string | null;
  session_id: string | null;
  turns: string;
  quote: string | null;
  harness: string | null;
  machine: string | null;
  created: number;
  updated: number;
}

export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}${t}${r}`;
}

/** Short, human-typeable fact ids: f + 6 chars. */
export function newFactId(): string {
  const db = openDb();
  for (;;) {
    const id = "f" + Math.random().toString(36).slice(2, 8);
    if (!db.query("SELECT 1 FROM facts WHERE id = ?").get(id)) return id;
  }
}

function eventFile(machine: string, ts: number): string {
  const month = new Date(ts * 1000).toISOString().slice(0, 7);
  return join(paths.events, machine, `${month}.jsonl`);
}

function ftsText(f: { type: string; text: string; why?: string | null; files?: string | string[] | null }): string {
  const files = Array.isArray(f.files) ? f.files : f.files ? JSON.parse(f.files) : [];
  return `${f.type} ${f.text} ${f.why ?? ""} ${files.join(" ")}`;
}

/**
 * When the fact was established: its source turn's time, not when extraction ran
 * (a backfill would otherwise make old facts look fresh). Falls back to the event time.
 */
function establishedAt(e: FactEvent): number {
  const tid = e.turns?.[e.turns.length - 1];
  const row = tid ? (openDb().query("SELECT ts_start FROM turns WHERE id = ?").get(tid) as { ts_start: number } | null) : null;
  return row?.ts_start && row.ts_start <= e.ts ? row.ts_start : e.ts;
}

/** Apply one event to the facts table (idempotent for add: same fact id is ignored). */
export function reduce(e: FactEvent) {
  const db = openDb();
  const now = establishedAt(e);
  const insert = (status: Fact["status"] = "active") => {
    if (db.query("SELECT 1 FROM facts WHERE id = ?").get(e.fact)) return;
    db.query(
      `INSERT INTO facts(id, project, type, text, why, files, origin, confidence, status, session_id, turns, quote, harness, machine, created, updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.fact,
      e.project,
      e.type ?? "decision",
      e.text ?? "",
      e.why ?? null,
      JSON.stringify(e.files ?? []),
      e.origin ?? "agent",
      e.confidence ?? 0.5,
      status,
      e.session ?? null,
      JSON.stringify(e.turns ?? []),
      e.quote ?? null,
      e.harness ?? null,
      e.machine,
      now,
      now,
    );
    db.query("INSERT INTO facts_fts(fact_id, body) VALUES (?, ?)").run(e.fact, ftsText({ type: e.type ?? "decision", text: e.text ?? "", why: e.why, files: e.files }));
  };
  switch (e.op) {
    case "add":
      insert();
      break;
    case "supersede":
      insert();
      if (e.target) {
        db.query("UPDATE facts SET status = 'superseded', superseded_by = ?, updated = ? WHERE id = ? AND status = 'active'").run(e.fact, now, e.target);
        db.query("DELETE FROM vectors WHERE kind = 'fact' AND id = ?").run(e.target);
        dropVector("fact", e.target);
      }
      break;
    case "retract":
      db.query("UPDATE facts SET status = 'retracted', updated = ? WHERE id = ?").run(now, e.fact);
      db.query("DELETE FROM vectors WHERE kind = 'fact' AND id = ?").run(e.fact);
      dropVector("fact", e.fact);
      break;
    case "done":
      db.query("UPDATE facts SET status = 'done', updated = ? WHERE id = ?").run(now, e.fact);
      break;
    case "reaffirm":
      db.query("UPDATE facts SET updated = MAX(updated, ?), confidence = MAX(confidence, ?) WHERE id = ?").run(now, Math.max(0, Math.min(1, e.confidence ?? 0)), e.fact);
      break;
  }
}

let lastTs = 0;
/** Strictly increasing per process, so replay order always equals append order. */
function nextTs(): number {
  lastTs = Math.max(Date.now() / 1000, lastTs + 0.000001);
  return lastTs;
}

/** Append events to this machine's log and apply them. */
export function emit(events: Omit<FactEvent, "id" | "machine" | "ts">[]): FactEvent[] {
  if (!events.length) return [];
  const machine = loadConfig().machine;
  const full = events.map((e) => ({ id: newId("e"), machine, ts: nextTs(), ...e }) as FactEvent);
  const ts = full[0].ts;
  const file = eventFile(machine, ts);
  const dir = file.slice(0, file.lastIndexOf("/"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(file, full.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  const db = openDb();
  db.transaction(() => full.forEach(reduce))();
  return full;
}

/** Rebuild the facts table from every machine's event log (also picks up synced logs). */
export function rebuildFacts(): number {
  const db = openDb();
  const events: FactEvent[] = [];
  if (existsSync(paths.events)) {
    for (const machine of readdirSync(paths.events)) {
      const dir = join(paths.events, machine);
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            events.push(JSON.parse(line));
          } catch {}
        }
      }
    }
  }
  // Stable sort: equal timestamps keep their order within a machine's log files.
  events.forEach((e, i) => ((e as any)._pos = i));
  events.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || String(a.machine).localeCompare(String(b.machine)) || (a as any)._pos - (b as any)._pos);
  db.transaction(() => {
    db.exec("DELETE FROM facts; DELETE FROM facts_fts; DELETE FROM vectors WHERE kind = 'fact';");
    events.forEach(reduce);
  })();
  return events.length;
}

export function activeFacts(project: string, types?: FactType[]): Fact[] {
  const db = openDb();
  const t = types?.length ? `AND type IN (${types.map(() => "?").join(",")})` : "";
  return db
    .query(`SELECT * FROM facts WHERE project IN ${inList(scopeIds(project))} AND status = 'active' ${t} ORDER BY updated DESC`)
    .all(...scopeIds(project), ...(types ?? [])) as Fact[];
}

export function getFact(id: string): Fact | undefined {
  return (openDb().query("SELECT * FROM facts WHERE id = ?").get(id) as Fact) ?? undefined;
}
