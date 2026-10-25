#!/usr/bin/env bun
import { existsSync, readFileSync, statSync } from "node:fs";
import { oneLine } from "./adapters/types";
import { renderBrief, writeLive } from "./brief";
import { loadConfig, paths } from "./config";
import { getMeta, openDb, usageToday } from "./db";
import { callDaemon, daemonPid, runDaemon } from "./daemon";
import { extractPending, pendingSessions } from "./extract";
import { emit, getFact, newFactId, rebuildFacts, FACT_TYPES, type FactType } from "./facts";
import { formatHit, handleHook, hookOutput, projectForCwd, shortTurnId, type Harness, type HookEvent } from "./hooks";
import { install, installedChecks } from "./install";
import { scanAll } from "./ingest";
import { inList, projectBySlugOrId, scopeIds, type Project } from "./project";
import { queryTerms, search } from "./search";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}
function opt(name: string, short?: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` || (short && argv[i] === `-${short}`)) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      if (!a.includes("=") && i + 1 < argv.length && !["--json", "--all", "--apply", "--dry-run", "--inactive"].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
function since(v?: string): number | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+)([hdw])$/);
  if (!m) return undefined;
  const mult = { h: 3600, d: 86400, w: 604800 }[m[2] as "h" | "d" | "w"];
  return Date.now() / 1000 - Number(m[1]) * mult;
}
function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function currentProject(required = true): Project | undefined {
  const key = opt("project", "p");
  const p = key ? projectBySlugOrId(key) : projectForCwd(process.cwd());
  if (!p && required) {
    console.error(key ? `Unknown project "${key}". See: ctx projects` : "Not inside a known project. Use --project <slug> (see: ctx projects).");
    process.exit(1);
  }
  return p;
}
function sessionByPrefix(prefix: string): any {
  const rows = openDb().query("SELECT * FROM sessions WHERE id LIKE ? ORDER BY last_ts DESC LIMIT 2").all(`${prefix}%`) as any[];
  if (rows.length > 1 && rows[0].id !== prefix) console.error(`(ambiguous prefix ${prefix}; using most recent)`);
  return rows[0];
}

const HELP = `ctx — shared memory across Claude Code / Codex sessions (Orca, Conductor, terminal)

Reading
  ctx brief [-p project] [--all]    project brief (what new sessions get; --all: everything)
  ctx search <query> [-p proj|--all] [--type decision|rejected|…] [--since 7d] [-n 10] [--json]
  ctx show <id>                      fact (f…) or turn (t:session.idx) with neighbours
  ctx sessions [-p proj|--all]       recent sessions (any harness)
  ctx tail <session-prefix> [-n 6]   latest turns of a session
  ctx facts [-p proj] [--type t] [--inactive]
  ctx projects

Writing
  ctx note <text> [--type decision|gotcha|preference|progress] [--why reason]
  ctx reject <text> --why <reason>
  ctx todo <text>
  ctx done <fact-id> | ctx retract <fact-id> [--why reason]

Admin
  ctx status | ctx doctor
  ctx scan | ctx extract [--dry-run] | ctx rebuild
  ctx install [--apply] | ctx uninstall [--apply]
  ctx daemon                         run ctxd in the foreground
  ctx hook <claude|codex> <session-start|prompt>   (used by harness hooks; reads JSON on stdin)
`;

async function main() {
  switch (cmd) {
    case "hook": {
      // Must never break or slow the harness: fail open on anything.
      const harness = argv[1] as Harness;
      const event = argv[2] as HookEvent;
      if (process.env.CTX_INTERNAL) return;
      let input: any = {};
      try {
        input = JSON.parse(await Bun.stdin.text());
      } catch {}
      // Hard ceiling well under the harness timeout (5 s): exit quietly no matter what.
      setTimeout(() => process.exit(0), 4000).unref();
      try {
        const viaDaemon = await callDaemon<{ context: string | null }>("/hook", { harness, event, input }, event === "prompt" ? 2500 : 3000);
        let ctx: string | undefined;
        if (viaDaemon) ctx = viaDaemon.context ?? undefined;
        else if (!daemonPid()) ctx = await handleHook(harness, event, input); // daemon down: lexical fallback
        const out = hookOutput(harness, event, ctx);
        if (out) process.stdout.write(out);
      } catch {}
      process.exit(0);
    }

    case "daemon":
      await runDaemon();
      return;

    case "scan": {
      const pid = daemonPid();
      if (pid) return console.log(`ctxd (pid ${pid}) is ingesting continuously; no manual scan needed.`);
      const t = performance.now();
      const r = scanAll({ onFile: flag("verbose") ? (p, n) => console.log(n, p) : undefined });
      console.log(`ingested ${r.records} records from ${r.files} changed files in ${((performance.now() - t) / 1000).toFixed(1)}s`);
      return;
    }

    case "extract": {
      if (flag("dry-run")) {
        for (const p of pendingSessions()) console.log(`${p.session_id.slice(0, 8)}  ${p.project}  ${p.n} turns`);
        return;
      }
      const res = await extractPending({ maxSessions: Number(opt("max") ?? 10), log: (r) => console.log(`${r.session.slice(0, 8)}: ${r.turns} turns → ${r.ops} ops${r.skipped ? ` (${r.skipped})` : ""}`) });
      if (!res.length) console.log("nothing pending");
      return;
    }

    case "rebuild": {
      const n = rebuildFacts();
      console.log(`replayed ${n} events`);
      return;
    }

    case "brief": {
      const p = currentProject()!;
      writeLive(p);
      console.log(renderBrief(p, { wrap: false, maxChars: flag("all") ? 100_000 : undefined, full: flag("all") }) || `No shared context yet for ${p.slug}.`);
      return;
    }

    case "search": {
      const q = positional().join(" ");
      if (!q) return console.error("usage: ctx search <query>");
      const p = flag("all") ? undefined : currentProject(false);
      const type = opt("type") as FactType | undefined;
      const remote = await callDaemon<{ vec: number[] | null }>("/embed", { q }, 3000);
      const qvec = remote?.vec ? Float32Array.from(remote.vec) : undefined;
      let hits = search(q, { project: p?.id, qvec, limit: Number(opt("n", "n") ?? 10) * (type ? 3 : 1), kinds: type ? ["fact"] : undefined, since: since(opt("since")) });
      if (type) hits = hits.filter((h) => h.meta.type === type).slice(0, Number(opt("n", "n") ?? 10));
      if (flag("json")) return console.log(JSON.stringify(hits, null, 2));
      if (!hits.length) return console.log(`no results${p ? ` in ${p.slug} (try --all)` : ""}`);
      console.log(`${hits.length} results${p ? ` in ${p.slug}` : ""}${qvec ? " (hybrid)" : " (lexical)"}:`);
      const terms = queryTerms(q);
      for (const h of hits) console.log(formatHit(h, 500, terms) + (p ? "" : `  {${h.meta.slug ?? "?"}}`));
      return;
    }

    case "show": {
      const id = positional()[0];
      if (!id) return console.error("usage: ctx show <id>");
      const db = openDb();
      if (/^f[a-z0-9]{6}$/.test(id)) {
        const f = getFact(id);
        if (!f) return console.error("no such fact");
        console.log(`[${f.id}] ${f.type} (${f.status}, origin ${f.origin}, confidence ${f.confidence})\n${f.text}`);
        if (f.why) console.log(`why: ${f.why}`);
        if (f.quote) console.log(`quote: "${f.quote}"`);
        if (f.superseded_by) console.log(`superseded by: ${f.superseded_by}`);
        console.log(`from: ${f.harness ?? "?"} session ${f.session_id?.slice(0, 8) ?? "-"} · ${new Date(f.created * 1000).toISOString().slice(0, 16)}`);
        for (const tid of JSON.parse(f.turns || "[]")) {
          const t = db.query("SELECT id, idx FROM turns WHERE id = ?").get(tid) as any;
          if (t) console.log(`source turn: ${shortTurnId(t.id, t.idx)}`);
        }
        return;
      }
      const m = id.match(/^t:([0-9a-z-]+)\.(\d+)$/i);
      if (!m) return console.error("ids look like f1a2b3c (fact) or t:1a2b3c4d.12 (turn)");
      const s = sessionByPrefix(m[1]);
      if (!s) return console.error("no such session");
      const idx = Number(m[2]);
      const rows = db.query("SELECT * FROM turns WHERE session_id = ? AND idx BETWEEN ? AND ? ORDER BY idx").all(s.id, idx - 1, idx + 1) as any[];
      console.log(`session ${s.id} · ${s.harness}/${s.source} · ${s.branch ?? ""} · ${s.cwd}`);
      for (const t of rows) {
        console.log(`\n${t.idx === idx ? "▶" : " "} turn ${t.idx} · ${new Date(t.ts_start * 1000).toISOString().slice(0, 16)}`);
        console.log(`USER: ${t.user}`);
        if (t.assistant) console.log(`AGENT: ${t.idx === idx ? t.assistant : oneLine(t.assistant, 400)}`);
        if (t.tools && t.idx === idx) console.log(`TOOLS:\n${t.tools}`);
      }
      return;
    }

    case "sessions": {
      const p = flag("all") ? undefined : currentProject(false);
      const rows = openDb()
        .query(`SELECT s.*, p.slug FROM sessions s LEFT JOIN projects p ON p.id = s.project WHERE s.skip = 0 AND s.turns > 0 ${p ? `AND s.project IN ${inList(scopeIds(p.id))}` : ""} ORDER BY s.last_ts DESC LIMIT ?`)
        .all(...((p ? scopeIds(p.id) : []) as any[]), Number(opt("n", "n") ?? 15)) as any[];
      for (const s of rows) {
        console.log(`${s.id.slice(0, 8)}  ${ago(s.last_ts).padEnd(8)} ${(s.harness + "/" + s.source).padEnd(20)} ${String(s.turns).padStart(4)} turns  ${p ? "" : (s.slug ?? "-").padEnd(24)} ${oneLine(s.title ?? "", 60)}`);
      }
      if (!rows.length) console.log("no sessions");
      return;
    }

    case "tail": {
      const prefix = positional()[0];
      if (!prefix) return console.error("usage: ctx tail <session-prefix>");
      const s = sessionByPrefix(prefix);
      if (!s) return console.error("no such session");
      const rows = (openDb().query("SELECT * FROM turns WHERE session_id = ? ORDER BY idx DESC LIMIT ?").all(s.id, Number(opt("n", "n") ?? 6)) as any[]).reverse();
      console.log(`session ${s.id} · ${s.harness}/${s.source} · ${s.branch ?? ""} · last ${ago(s.last_ts)}`);
      for (const t of rows) {
        console.log(`\n[${shortTurnId(t.id, t.idx)} · ${ago(t.ts_end)}${t.complete ? "" : " · in progress"}]`);
        console.log(`USER: ${oneLine(t.user, 600)}`);
        if (t.assistant) console.log(`AGENT: ${oneLine(t.assistant.slice(-1200), 800)}`);
      }
      return;
    }

    case "facts": {
      const p = currentProject()!;
      const type = opt("type");
      const rows = openDb()
        .query(`SELECT * FROM facts WHERE project IN ${inList(scopeIds(p.id))} ${flag("inactive") ? "" : "AND status = 'active'"} ${type ? "AND type = ?" : ""} ORDER BY type, updated DESC`)
        .all(...([...scopeIds(p.id), type].filter(Boolean) as string[])) as any[];
      for (const f of rows) console.log(`[${f.id}] ${f.type.padEnd(10)} ${f.status === "active" ? "" : `(${f.status}) `}${f.text}${f.why ? ` — ${f.why}` : ""}  (${f.origin} · ${f.harness ?? ""})`);
      if (!rows.length) console.log("no facts");
      return;
    }

    case "projects": {
      const rows = openDb()
        .query(`SELECT p.slug, p.id, COUNT(DISTINCT s.id) sessions, MAX(s.last_ts) last, (SELECT COUNT(*) FROM facts f WHERE f.project = p.id AND f.status = 'active') facts
                FROM projects p LEFT JOIN sessions s ON s.project = p.id AND s.skip = 0 GROUP BY p.id ORDER BY last DESC`)
        .all() as any[];
      for (const r of rows) if (r.sessions) console.log(`${r.slug.padEnd(36)} ${String(r.sessions).padStart(4)} sessions ${String(r.facts).padStart(4)} facts  ${r.last ? ago(r.last).padEnd(8) : ""}  ${r.id}`);
      return;
    }

    case "note":
    case "reject":
    case "todo": {
      const text = positional().join(" ");
      if (!text) return console.error(`usage: ctx ${cmd} <text>${cmd === "reject" ? " --why <reason>" : ""}`);
      const type = (cmd === "reject" ? "rejected" : cmd === "todo" ? "todo" : (opt("type") ?? "decision")) as FactType;
      if (!FACT_TYPES.includes(type)) return console.error(`--type must be one of ${FACT_TYPES.join(", ")}`);
      const p = currentProject()!;
      const session = process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_SESSION_ID;
      const [e] = emit([{ op: "add", fact: newFactId(), project: p.id, type, text, why: opt("why"), origin: "manual", confidence: 1, session, harness: process.env.ORCA_PANE_KEY ? "orca" : undefined }]);
      writeLive(p);
      console.log(`saved [${e.fact}] ${type}: ${text} → ${p.slug}`);
      return;
    }

    case "done":
    case "retract": {
      const id = positional()[0];
      const f = id && getFact(id);
      if (!f) return console.error("usage: ctx " + cmd + " <fact-id>");
      emit([{ op: cmd, fact: f.id, project: f.project, reason: opt("why") }]);
      const p = projectBySlugOrId(f.project);
      if (p) writeLive(p);
      console.log(`${cmd === "done" ? "marked done" : "retracted"} [${f.id}] ${f.text}`);
      return;
    }

    case "status": {
      const db = openDb();
      const cfg = loadConfig();
      const d = await callDaemon<{ pid: number; uptime: number; embedReady: boolean }>("/status", undefined, 1000);
      console.log(`ctxd: ${d ? `running (pid ${d.pid}, up ${Math.round(d.uptime / 60)}m, embeddings ${d.embedReady ? "ready" : "loading/off"})` : "NOT RUNNING"}`);
      // Ingest lag per source: newest transcript write vs what we've consumed.
      for (const [source] of Object.entries(cfg.sources)) {
        const lag = db.query("SELECT MAX(mtime) m, SUM(size - offset) behind FROM files WHERE source = ?").get(source) as any;
        const newest = db.query("SELECT MAX(last_ts) t FROM sessions WHERE source = ?").get(source) as any;
        console.log(`${source.padEnd(6)} files tracked: ${(db.query("SELECT COUNT(*) n FROM files WHERE source = ?").get(source) as any).n}, unread bytes: ${lag?.behind ?? 0}, newest turn: ${newest?.t ? ago(newest.t) : "-"}`);
      }
      const c = (q: string) => (db.query(q).get() as any).n;
      console.log(`turns: ${c("SELECT COUNT(*) n FROM turns")} (embedded ${c("SELECT COUNT(*) n FROM turns WHERE embedded = 1")}), sessions: ${c("SELECT COUNT(*) n FROM sessions WHERE skip = 0")}, active facts: ${c("SELECT COUNT(*) n FROM facts WHERE status = 'active'")}`);
      const u = usageToday("extract");
      console.log(`extraction today: ${u.calls}/${cfg.extract.maxCallsPerDay} calls, ${u.failures} failures, ~$${u.cost.toFixed(3)} list-price; pending sessions: ${pendingSessions().length}`);
      const last = getMeta("last_scan");
      if (last) console.log(`last scan: ${ago(Number(last))}`);
      if (existsSync(paths.db)) console.log(`index: ${(statSync(paths.db).size / 1e6).toFixed(1)} MB at ${paths.db}`);
      return;
    }

    case "doctor": {
      const checks = installedChecks();
      // Give a just-restarted daemon a few seconds to come up before calling it down.
      let d = await callDaemon<any>("/status", undefined, 1000);
      for (let i = 0; !d && i < 8; i++) {
        await Bun.sleep(1000);
        d = await callDaemon<any>("/status", undefined, 1000);
      }
      checks.unshift({ ok: Boolean(d), name: "ctxd running", detail: d ? `pid ${d.pid}` : `not reachable at ${paths.socket}` });
      const claudeOk = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
      checks.push({ ok: claudeOk, name: "claude CLI (extractor)", detail: claudeOk ? "found" : "not on PATH — extraction disabled" });
      const logFile = `${paths.logs}/ctxd.log`;
      if (existsSync(logFile)) {
        // Only errors since the daemon last started count as current problems.
        const lines = readFileSync(logFile, "utf8").split("\n").slice(-2000);
        const start = lines.findLastIndex((l) => l.includes("ctxd starting"));
        const errs = lines.slice(Math.max(0, start)).filter((l) => /failed|error/i.test(l));
        checks.push({ ok: errs.length === 0, name: "daemon errors since start", detail: errs.length ? errs.slice(-3).join(" | ") : "none" });
      }
      for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      return;
    }

    case "install":
    case "uninstall":
      install(flag("apply"), cmd);
      return;

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    default:
      console.error(`unknown command "${cmd}"\n`);
      console.log(HELP);
      process.exit(1);
  }
}

await main();
