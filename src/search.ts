// Hybrid retrieval: FTS5 BM25 (OR semantics) + optional dense vectors, fused with RRF.

import { openDb } from "./db";
import { vectorSearch } from "./embed";
import { inList, scopeIds } from "./project";

const STOP = new Set(
  "a an and are as at be but by can could did do does for from had has have how i if in into is it its just let me my no not of on or our so that the their them then there these this those to up us was we were what when where which who why will with would you your yeah yes ok okay please also like make get want need now should use using used thing things something think know going see look one any all some more very really".split(" "),
);

export function queryTerms(q: string): string[] {
  const seen = new Set<string>();
  for (const m of q.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu)) {
    const t = m[0];
    if (t.length < 2 || STOP.has(t)) continue;
    seen.add(t);
    if (seen.size >= 16) break;
  }
  return [...seen];
}

export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export interface Hit {
  kind: "turn" | "fact";
  id: string;
  score: number;
  lexRank?: number;
  vecRank?: number;
  sim?: number;
  coverage: number; // fraction of query terms present
  project: string | null;
  ts: number;
  // display
  text: string;
  meta: Record<string, any>;
}

export interface SearchOpts {
  project?: string; // hard filter
  boostProject?: string; // soft preference
  excludeSession?: string;
  kinds?: ("turn" | "fact")[];
  limit?: number;
  since?: number; // unix seconds
  qvec?: Float32Array; // query embedding when available
  includeInactive?: boolean;
}

const K = 60;

export function search(q: string, opts: SearchOpts = {}): Hit[] {
  const db = openDb();
  const terms = queryTerms(q);
  const kinds = opts.kinds ?? ["turn", "fact"];
  const limit = opts.limit ?? 10;
  const pool = 40;
  const cands = new Map<string, Hit>();

  const coverageOf = (body: string) => {
    if (!terms.length) return 0;
    const b = body.toLowerCase();
    let n = 0;
    for (const t of terms) if (b.includes(t.length > 4 ? t.slice(0, t.length - 1) : t)) n++;
    return n / terms.length;
  };

  const addTurn = (row: any, rank: { lex?: number; vec?: number; sim?: number }) => {
    const key = `turn:${row.id}`;
    let h = cands.get(key);
    if (!h) {
      h = {
        kind: "turn",
        id: row.id,
        score: 0,
        coverage: coverageOf(`${row.user}\n${row.assistant}\n${row.tools}`),
        project: row.project,
        ts: row.ts_start,
        text: row.user,
        meta: { session: row.session_id, harness: row.harness, branch: row.branch, assistant: row.assistant, idx: row.idx, slug: row.slug },
      };
      cands.set(key, h);
    }
    if (rank.lex !== undefined) h.lexRank = rank.lex;
    if (rank.vec !== undefined) {
      h.vecRank = rank.vec;
      h.sim = rank.sim;
    }
  };
  const addFact = (row: any, rank: { lex?: number; vec?: number; sim?: number }) => {
    const key = `fact:${row.id}`;
    let h = cands.get(key);
    if (!h) {
      h = {
        kind: "fact",
        id: row.id,
        score: 0,
        coverage: coverageOf(`${row.text} ${row.why ?? ""} ${row.files ?? ""}`),
        project: row.project,
        ts: row.updated,
        text: row.text,
        meta: { type: row.type, why: row.why, origin: row.origin, status: row.status, harness: row.harness, session: row.session_id, slug: row.slug, files: row.files },
      };
      cands.set(key, h);
    }
    if (rank.lex !== undefined) h.lexRank = rank.lex;
    if (rank.vec !== undefined) {
      h.vecRank = rank.vec;
      h.sim = rank.sim;
    }
  };

  const turnFilter = (alias: string) => {
    const w: string[] = [];
    const a: any[] = [];
    if (opts.project) (w.push(`${alias}.project IN ${inList(scopeIds(opts.project))}`), a.push(...scopeIds(opts.project)));
    if (opts.excludeSession) (w.push(`${alias}.session_id != ?`), a.push(opts.excludeSession));
    if (opts.since) (w.push(`${alias}.ts_start >= ?`), a.push(opts.since));
    return { w, a };
  };
  const factFilter = (alias: string) => {
    const w: string[] = [];
    const a: any[] = [];
    if (opts.project) (w.push(`${alias}.project IN ${inList(scopeIds(opts.project))}`), a.push(...scopeIds(opts.project)));
    if (!opts.includeInactive) w.push(`${alias}.status = 'active'`);
    if (opts.since) (w.push(`${alias}.updated >= ?`), a.push(opts.since));
    return { w, a };
  };

  const TURN_COLS = "t.id, t.session_id, t.project, t.harness, t.branch, t.idx, t.ts_start, t.user, t.assistant, t.tools, p.slug";
  const FACT_COLS = "f.id, f.project, f.type, f.text, f.why, f.files, f.origin, f.status, f.harness, f.session_id, f.updated, p.slug";

  if (terms.length) {
    const match = ftsQuery(terms);
    if (kinds.includes("turn")) {
      const { w, a } = turnFilter("t");
      const rows = db
        .query(
          `SELECT ${TURN_COLS} FROM turns_fts JOIN turns t ON t.id = turns_fts.turn_id LEFT JOIN projects p ON p.id = t.project
           WHERE turns_fts MATCH ? ${w.length ? "AND " + w.join(" AND ") : ""} ORDER BY bm25(turns_fts) LIMIT ?`,
        )
        .all(match, ...a, pool) as any[];
      rows.forEach((r, i) => addTurn(r, { lex: i + 1 }));
    }
    if (kinds.includes("fact")) {
      const { w, a } = factFilter("f");
      const rows = db
        .query(
          `SELECT ${FACT_COLS} FROM facts_fts JOIN facts f ON f.id = facts_fts.fact_id LEFT JOIN projects p ON p.id = f.project
           WHERE facts_fts MATCH ? ${w.length ? "AND " + w.join(" AND ") : ""} ORDER BY bm25(facts_fts) LIMIT ?`,
        )
        .all(match, ...a, pool) as any[];
      rows.forEach((r, i) => addFact(r, { lex: i + 1 }));
    }
  }

  if (opts.qvec) {
    const vhits = vectorSearch(opts.qvec, { projects: opts.project ? scopeIds(opts.project) : undefined, kinds, limit: pool * 2 });
    let tr = 0;
    let fr = 0;
    for (const v of vhits) {
      if (v.kind === "turn") {
        const { w, a } = turnFilter("t");
        const row = db.query(`SELECT ${TURN_COLS} FROM turns t LEFT JOIN projects p ON p.id = t.project WHERE t.id = ? ${w.length ? "AND " + w.join(" AND ") : ""}`).get(v.id, ...a);
        if (row && tr < pool) addTurn(row, { vec: ++tr, sim: v.sim });
      } else {
        const { w, a } = factFilter("f");
        const row = db.query(`SELECT ${FACT_COLS} FROM facts f LEFT JOIN projects p ON p.id = f.project WHERE f.id = ? ${w.length ? "AND " + w.join(" AND ") : ""}`).get(v.id, ...a);
        if (row && fr < pool) addFact(row, { vec: ++fr, sim: v.sim });
      }
    }
  }

  const now = Date.now() / 1000;
  for (const h of cands.values()) {
    let s = 0;
    if (h.lexRank) s += 1 / (K + h.lexRank);
    if (h.vecRank) s += 1 / (K + h.vecRank);
    if (h.kind === "fact") s *= h.meta.type === "rejected" ? 1.8 : 1.5;
    const ageDays = Math.max(0, (now - h.ts) / 86400);
    s *= 1 + 0.3 * Math.exp(-ageDays / 45);
    if (opts.boostProject && h.project && scopeIds(opts.boostProject).includes(h.project)) s *= 1.5;
    h.score = s;
  }
  return [...cands.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Should this hit be injected without being asked? Silence is the default.
 * With vectors: the dense similarity must clear `minSim` (calibrated on this machine:
 * relevant 0.55–0.68, unrelated 0.39–0.51), or a lexical-only hit must match nearly all terms.
 * Lexical only: needs most query terms present and a top lexical rank.
 */
export function confident(h: Hit, hasVec: boolean, termCount: number, minSim = 0.53): boolean {
  if (termCount < 2) return false;
  if (hasVec) {
    if (h.sim !== undefined) return h.sim >= minSim;
    return h.coverage >= 0.8 && (h.lexRank ?? 99) <= 2;
  }
  return h.coverage >= (h.kind === "fact" ? 0.5 : 0.65) && (h.lexRank ?? 99) <= 5;
}
