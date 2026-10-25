import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { paths, ensureDirs } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  ino INTEGER, size INTEGER, offset INTEGER NOT NULL DEFAULT 0,
  mtime REAL, session_id TEXT, state TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  root TEXT,
  remote TEXT
);
CREATE TABLE IF NOT EXISTS cwd_projects (
  cwd TEXT PRIMARY KEY,
  project TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  harness TEXT,
  machine TEXT,
  project TEXT,
  cwd TEXT,
  branch TEXT,
  title TEXT,
  started REAL,
  last_ts REAL,
  turns INTEGER NOT NULL DEFAULT 0,
  skip INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project, last_ts);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT,
  machine TEXT,
  source TEXT,
  harness TEXT,
  branch TEXT,
  idx INTEGER,
  ts_start REAL,
  ts_end REAL,
  user TEXT,
  assistant TEXT,
  tools TEXT,
  files TEXT,
  complete INTEGER NOT NULL DEFAULT 0,
  extracted INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0,
  extracted_len INTEGER NOT NULL DEFAULT 0,
  archived_len INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, idx);
CREATE INDEX IF NOT EXISTS turns_project ON turns(project, ts_start);
CREATE INDEX IF NOT EXISTS turns_extract ON turns(extracted, complete);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
  turn_id UNINDEXED, body, tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  why TEXT,
  files TEXT,
  origin TEXT,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  session_id TEXT,
  turns TEXT,
  quote TEXT,
  harness TEXT,
  machine TEXT,
  created REAL,
  updated REAL
);
CREATE INDEX IF NOT EXISTS facts_project ON facts(project, status, type);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  fact_id UNINDEXED, body, tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS vectors (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  project TEXT,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS vectors_project ON vectors(project);

CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

CREATE TABLE IF NOT EXISTS extract_state (
  session_id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  next_at REAL NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

let db: Database | undefined;

export function openDb(opts: { readonly?: boolean } = {}): Database {
  if (db) return db;
  ensureDirs();
  const fresh = !existsSync(paths.db);
  if (opts.readonly && !fresh) {
    db = new Database(paths.db, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    return db;
  }
  db = new Database(paths.db, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  // Additive migrations for stores created by older versions.
  for (const col of ["extracted_len INTEGER NOT NULL DEFAULT 0", "archived_len INTEGER NOT NULL DEFAULT 0"]) {
    try {
      db.exec(`ALTER TABLE turns ADD COLUMN ${col}`);
    } catch {}
  }
  if (fresh) {
    try {
      chmodSync(paths.db, 0o600);
    } catch {}
  }
  return db;
}

export function getMeta(key: string): string | undefined {
  const row = openDb().query("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | null;
  return row?.v;
}

export function setMeta(key: string, value: string) {
  openDb().query("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function bumpUsage(kind: string, fields: { calls?: number; failures?: number; cost?: number }) {
  openDb()
    .query(
      `INSERT INTO usage(day, kind, calls, failures, cost) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day, kind) DO UPDATE SET calls = calls + excluded.calls,
         failures = failures + excluded.failures, cost = cost + excluded.cost`,
    )
    .run(today(), kind, fields.calls ?? 0, fields.failures ?? 0, fields.cost ?? 0);
}

export function usageToday(kind: string): { calls: number; failures: number; cost: number } {
  const row = openDb().query("SELECT calls, failures, cost FROM usage WHERE day = ? AND kind = ?").get(today(), kind) as any;
  return row ?? { calls: 0, failures: 0, cost: 0 };
}
