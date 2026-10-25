// Local embeddings (EmbeddingGemma via transformers.js). Only the daemon loads the model;
// hooks and the CLI ask the daemon, or fall back to lexical search.

import { cpus } from "node:os";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";

// One worker thread; queries jump the queue ahead of backlog batches.
let worker: Worker | undefined;
let ready: Promise<void> | undefined;
let seq = 0;
const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const queue: { id: number; kind: "query" | "docs"; texts: string[]; deadline?: number }[] = [];
let busy = 0; // id of the job currently in the worker, 0 = idle

export function embeddingsEnabled(): boolean {
  return loadConfig().embed.enabled;
}

function pump() {
  if (busy || !worker) return;
  // Queries whose caller already gave up aren't worth computing.
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) {
    const j = queue[i];
    if (j.deadline && j.deadline < now) {
      queue.splice(i, 1);
      waiting.get(j.id)?.reject(new Error("expired"));
      waiting.delete(j.id);
    }
  }
  if (!queue.length) return;
  const i = queue.findIndex((j) => j.kind === "query");
  const job = queue.splice(i >= 0 ? i : 0, 1)[0];
  busy = job.id;
  worker.postMessage({ id: job.id, kind: job.kind, texts: job.texts });
}

function call(kind: "init" | "query" | "docs", payload: any, deadlineMs?: number): Promise<any> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    if (kind === "init") worker!.postMessage({ id, kind, init: payload });
    else {
      queue.push({ id, kind, texts: payload, deadline: deadlineMs ? Date.now() + deadlineMs : undefined });
      pump();
    }
  });
}

/** Worker died or failed to load: fail everything pending and allow a clean restart. */
function reset(err: Error) {
  for (const w of waiting.values()) w.reject(err);
  waiting.clear();
  queue.length = 0;
  busy = 0;
  try {
    worker?.terminate();
  } catch {}
  worker = undefined;
  ready = undefined;
}

function start(): Promise<void> {
  if (!ready) {
    worker = new Worker(new URL("./embedWorker.ts", import.meta.url).href);
    worker.onmessage = (ev: MessageEvent) => {
      const { id, ok, vecs, error } = ev.data;
      const w = waiting.get(id);
      waiting.delete(id);
      if (id === busy) busy = 0;
      if (ok) w?.resolve(vecs);
      else w?.reject(new Error(error));
      pump();
    };
    worker.onerror = (ev: ErrorEvent) => reset(new Error(`embedding worker crashed: ${ev.message}`));
    worker.addEventListener("close", () => reset(new Error("embedding worker exited")));
    const cfg = loadConfig().embed;
    ready = call("init", { cacheDir: paths.models, model: cfg.model, dtype: cfg.dtype, threads: Math.max(2, Math.floor(cpus().length / 2)) });
    ready.catch((e) => reset(e));
  }
  return ready;
}

// EmbeddingGemma prompt formats for asymmetric retrieval.
const queryPrefix = (q: string) => `task: search result | query: ${q}`;
const docPrefix = (title: string, text: string) => `title: ${title || "none"} | text: ${text}`;

export async function embedQuery(q: string, deadlineMs?: number): Promise<Float32Array> {
  await start();
  const [v] = await call("query", [queryPrefix(q.slice(0, 1000))], deadlineMs);
  return v;
}

export async function embedDocs(docs: { title: string; text: string }[]): Promise<Float32Array[]> {
  await start();
  return call("docs", docs.map((d) => docPrefix(d.title, d.text.slice(0, 1200))));
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b); // align
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Embed turns and facts that changed since they were last embedded. Returns how many were embedded. */
export async function embedBacklog(limit = 256): Promise<number> {
  if (!embeddingsEnabled()) return 0;
  const db = openDb();
  const model = loadConfig().embed.model;
  let done = 0;
  const turns = db
    .query("SELECT t.id, t.project, t.user, t.assistant, t.tools, length(t.user) + length(t.assistant) len, p.slug FROM turns t LEFT JOIN projects p ON p.id = t.project WHERE t.embedded = 0 AND t.complete = 1 AND t.ts_start > ? ORDER BY t.ts_start DESC LIMIT ?")
    .all(Date.now() / 1000 - loadConfig().embed.horizonDays * 86400, limit) as any[];
  const facts = db
    .query("SELECT f.id, f.project, f.type, f.text, f.why, p.slug FROM facts f LEFT JOIN projects p ON p.id = f.project WHERE f.status = 'active' AND f.id NOT IN (SELECT id FROM vectors WHERE kind = 'fact') LIMIT ?")
    .all(limit) as any[];
  const put = db.query("INSERT OR REPLACE INTO vectors(kind, id, project, model, vec) VALUES (?, ?, ?, ?, ?)");
  // Only mark embedded if the turn didn't change while we were computing its vector.
  const mark = db.query("UPDATE turns SET embedded = 1 WHERE id = ? AND length(user) + length(assistant) = ?");
  for (let i = 0; i < turns.length; i += 4) {
    const chunk = turns.slice(i, i + 4);
    const vecs = await embedDocs(
      chunk.map((t) => ({ title: t.slug ?? "", text: `${t.user.slice(0, 500)}\n${(t.assistant ?? "").slice(-350)}` })),
    );
    db.transaction(() => {
      chunk.forEach((t, j) => {
        put.run("turn", t.id, t.project, model, toBlob(vecs[j]));
        mark.run(t.id, t.len);
        cacheVector("turn", t.id, t.project, vecs[j]);
      });
    })();
    done += chunk.length;
  }
  for (let i = 0; i < facts.length; i += 8) {
    const chunk = facts.slice(i, i + 8);
    const vecs = await embedDocs(chunk.map((f) => ({ title: `${f.slug ?? ""} ${f.type}`, text: `${f.text}${f.why ? " — " + f.why : ""}` })));
    db.transaction(() =>
      chunk.forEach((f, j) => {
        put.run("fact", f.id, f.project, model, toBlob(vecs[j]));
        cacheVector("fact", f.id, f.project, vecs[j]);
      }),
    )();
    done += chunk.length;
  }
  return done;
}

interface VecRow {
  kind: string;
  id: string;
  project: string | null;
  vec: Float32Array;
}

// In-memory copy of all vectors, loaded once and kept current by embedBacklog.
let cache: Map<string, VecRow> | undefined;

function loadCache(): Map<string, VecRow> {
  if (!cache) {
    cache = new Map();
    for (const r of openDb().query("SELECT kind, id, project, vec FROM vectors").all() as any[]) {
      cache.set(`${r.kind}:${r.id}`, { kind: r.kind, id: r.id, project: r.project, vec: fromBlob(r.vec) });
    }
  }
  return cache;
}

export function cacheVector(kind: string, id: string, project: string | null, vec: Float32Array) {
  if (cache) cache.set(`${kind}:${id}`, { kind, id, project, vec });
}

export function dropVector(kind: string, id: string) {
  cache?.delete(`${kind}:${id}`);
}

/** Brute-force cosine over in-memory vectors (fine for tens of thousands of rows). */
export function vectorSearch(q: Float32Array, opts: { projects?: string[]; kinds?: string[]; limit: number }): { kind: string; id: string; sim: number }[] {
  const scored: { kind: string; id: string; sim: number }[] = [];
  for (const r of loadCache().values()) {
    if (opts.projects && !opts.projects.includes(r.project ?? "")) continue;
    if (opts.kinds && !opts.kinds.includes(r.kind)) continue;
    scored.push({ kind: r.kind, id: r.id, sim: dot(q, r.vec) });
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, opts.limit);
}
