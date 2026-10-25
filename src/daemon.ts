// ctxd: watches transcripts, extracts facts, embeds, and serves hooks over a unix socket.

import { appendFileSync, existsSync, readFileSync, unlinkSync, watch, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { writeLive } from "./brief";
import { loadConfig, paths } from "./config";
import { getMeta, openDb, setMeta } from "./db";
import { embedBacklog, embedQuery, embeddingsEnabled } from "./embed";
import { extractPending } from "./extract";
import { rebuildFacts } from "./facts";
import { handleHook, type Harness, type HookEvent } from "./hooks";
import { adapterFor, closeIdleTurns, compactArchive, ingestFile, scanAllAsync, setIngestLogger } from "./ingest";
import { projectBySlugOrId } from "./project";
import { serveUi } from "./ui-server";

const started = Date.now();
let embedReady = false;
const daemonInfo = () => ({ pid: process.pid, uptime: (Date.now() - started) / 1000, embedReady });

export function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  appendFileSync(join(paths.logs, "ctxd.log"), line, { mode: 0o600 });
  if (process.stdout.isTTY) process.stdout.write(line);
}

/** Query embedding with a deadline: past it, the hook answers lexical-only rather than wait. */
async function safeEmbed(q: string, deadlineMs = 600): Promise<Float32Array | undefined> {
  if (!embedReady) return undefined;
  return Promise.race([embedQuery(q, deadlineMs).catch(() => undefined), Bun.sleep(deadlineMs).then(() => undefined)]);
}

function every(ms: number, name: string, fn: () => unknown | Promise<unknown>) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e: any) {
      log(`${name} failed: ${e?.stack ?? e}`);
    } finally {
      running = false;
    }
  };
  setInterval(tick, ms);
  return tick;
}

/** pid of a live ctxd, if any. */
export function daemonPid(): number | undefined {
  try {
    const pid = Number(readFileSync(paths.pid, "utf8"));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      return pid;
    }
  } catch {}
  return undefined;
}

export async function runDaemon() {
  const other = daemonPid();
  if (other) {
    console.error(`ctxd already running (pid ${other}); refusing to start a second writer.`);
    process.exit(1);
  }
  const cfg = loadConfig();
  const db = openDb();
  writeFileSync(paths.pid, String(process.pid), { mode: 0o600 });
  setIngestLogger(log);
  log(`ctxd starting pid=${process.pid} machine=${cfg.machine}`);

  // Facts table is derived; rebuild if empty but logs exist (fresh index or synced logs).
  const factCount = (db.query("SELECT COUNT(*) n FROM facts").get() as any).n;
  if (!factCount) {
    const n = rebuildFacts();
    if (n) log(`rebuilt facts from ${n} events`);
  }

  // Listen first: hooks and doctor get answers even while a long backfill runs.
  if (existsSync(paths.socket)) unlinkSync(paths.socket);
  Bun.serve({
    unix: paths.socket,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/hook" && req.method === "POST") {
          const { harness, event, input } = (await req.json()) as { harness: Harness; event: HookEvent; input: any };
          // Make sure the very latest turns of every session are in before answering.
          const ctx = await handleHook(harness, event, input, safeEmbed);
          return Response.json({ context: ctx ?? null });
        }
        if (url.pathname === "/embed" && req.method === "POST") {
          const { q } = (await req.json()) as { q: string };
          const v = await safeEmbed(q, 5000);
          return Response.json({ vec: v ? Array.from(v) : null });
        }
        if (url.pathname === "/extract" && req.method === "POST") {
          await extractTick();
          return Response.json({ ok: true });
        }
        if (url.pathname === "/status") {
          return Response.json(daemonInfo());
        }
        if (url.pathname === "/ui" && req.method === "POST") {
          const { port } = (await req.json()) as { port?: number };
          const r = serveUi(daemonInfo, port);
          log(`ui listening on http://127.0.0.1:${r.port}`);
          return Response.json(r);
        }
        return new Response("not found", { status: 404 });
      } catch (e: any) {
        log(`request ${url.pathname} failed: ${e?.stack ?? e}`);
        return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
      }
    },
  });
  try {
    chmodSync(paths.socket, 0o600);
  } catch {}
  log(`listening on ${paths.socket}`);
  if (cfg.ui.enabled) {
    try {
      log(`ui listening on http://127.0.0.1:${serveUi(daemonInfo).port}`);
    } catch (e: any) {
      log(`ui failed to start: ${e?.message}`);
    }
  }

  const t0 = performance.now();
  const r = await scanAllAsync();
  log(`initial scan: ${r.files} files, ${r.records} records in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  setMeta("last_scan", String(Date.now() / 1000));

  // fs events are hints; the periodic rescan is the backstop (FSEvents can coalesce/drop).
  const pending = new Map<string, Timer>();
  for (const [source, roots] of Object.entries(cfg.sources)) {
    for (const root of roots) {
      if (!existsSync(root)) continue;
      try {
        watch(root, { recursive: true }, (_ev, rel) => {
          if (!rel || !String(rel).endsWith(".jsonl")) return;
          const path = join(root, String(rel));
          const adapter = adapterFor(path);
          if (!adapter) return;
          clearTimeout(pending.get(path));
          pending.set(
            path,
            setTimeout(() => {
              pending.delete(path);
              try {
                ingestFile(path, adapter);
                setMeta("last_ingest", String(Date.now() / 1000));
              } catch (e: any) {
                log(`ingest ${path} failed: ${e?.message}`);
              }
            }, 400),
          );
        });
        log(`watching ${source}: ${root}`);
      } catch (e: any) {
        log(`watch ${root} failed (${e?.message}); relying on rescans`);
      }
    }
  }

  every(30_000, "rescan", async () => {
    await scanAllAsync();
    setMeta("last_scan", String(Date.now() / 1000));
  });
  every(15_000, "close-idle", () => closeIdleTurns(600));
  const extractTick = every(20_000, "extract", async () => {
    await extractPending({
      maxSessions: 3,
      log: (r) => log(`extract ${r.session.slice(0, 8)}: ${r.turns} turns → ${r.ops} ops${r.skipped ? ` (${r.skipped})` : ""}${r.cost ? ` $${r.cost.toFixed(4)}` : ""}`),
    });
  });
  every(3600_000, "compact", () => {
    if (Date.now() / 1000 - Number(getMeta("last_compact") ?? 0) < 86400) return;
    const r = compactArchive();
    setMeta("last_compact", String(Date.now() / 1000));
    if (r.dropped) log(`archive compacted: ${r.dropped} stale turn copies dropped from ${r.files} files`);
  });
  every(5 * 60_000, "live", () => {
    const rows = db.query("SELECT DISTINCT project FROM sessions WHERE last_ts > ? AND project IS NOT NULL").all(Date.now() / 1000 - 86400) as any[];
    for (const r of rows) {
      const p = projectBySlugOrId(r.project);
      if (p) writeLive(p);
    }
  });

  if (embeddingsEnabled()) {
    (async () => {
      try {
        await embedQuery("warmup");
        embedReady = true;
        log("embeddings ready");
      } catch (e: any) {
        log(`embeddings unavailable: ${e?.message}`);
      }
    })();
    every(10_000, "embed", async () => {
      if (!embedReady) {
        // Worker crashed earlier: try to bring it back.
        embedReady = await embedQuery("warmup").then(() => true, () => false);
        if (!embedReady) return;
      }
      const n = await embedBacklog(128);
      if (n) setMeta("last_embed", String(Date.now() / 1000));
    });
  }


  extractTick();

  const stop = () => {
    try {
      unlinkSync(paths.socket);
      unlinkSync(paths.pid);
    } catch {}
    log("ctxd stopping");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** Ask the running daemon. Returns undefined if it isn't reachable in time. */
export async function callDaemon<T>(path: string, body?: unknown, timeoutMs = 1500): Promise<T | undefined> {
  if (!existsSync(paths.socket)) return undefined;
  try {
    const res = await fetch(`http://localhost${path}`, {
      unix: paths.socket,
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    } as any);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
