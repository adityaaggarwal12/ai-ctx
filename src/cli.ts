#!/usr/bin/env bun
import { oneLine } from "./adapters/types";
import { renderBrief, withWhy, writeLive } from "./brief";
import { loadConfig, paths, updateConfig } from "./config";
import { openDb, setMeta } from "./db";
import { callDaemon, daemonPid, runDaemon } from "./daemon";
import { estimateBacklog, extractPending, extractSince, pendingSessions } from "./extract";
import { getFact, rebuildFacts, FACT_TYPES, type FactType } from "./facts";
import { formatHit, handleHook, hookOutput, projectForCwd, shortTurnId, type Harness, type HookEvent } from "./hooks";
import { install } from "./install";
import { addNote, applyFactAction, doctorChecks, duplicates, health, listFacts, listProjects, listSessions, mergeDuplicates, recallStats, reviewItems, sessionByPrefix, tailSession, type FactAction } from "./views";
import { scanAll } from "./ingest";
import { uiToken } from "./ui-server";
import { projectBySlugOrId, type Project } from "./project";
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
      if (!a.includes("=") && i + 1 < argv.length && !["--json", "--all", "--apply", "--dry-run", "--inactive", "--off", "--no-open"].includes(a)) i++;
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

const HELP = `ctx: shared memory across Claude Code and Codex sessions (Orca, Conductor, terminal)

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
  ctx done <fact-id…> | ctx retract <fact-id…> [--why reason]
  ctx keep <fact-id…>                still true: confirm and refresh
  ctx review [-p proj|--all] [--days 30]   old todos/gotchas and unconfirmed facts to clear out
  ctx dedupe [-p proj|--all] [--apply]     merge reworded duplicate facts (newest wording wins)

Admin
  ctx status | ctx doctor
  ctx ui [--no-open] | ctx ui --off   local review page (127.0.0.1 only): projects, facts, sessions, health
  ctx recall-stats                   per-prompt recall scores vs recall.minSim (for re-tuning)
  ctx scan | ctx extract [--dry-run] | ctx rebuild
  ctx backfill --days 60 [--dry-run] | ctx backfill --off   extract older history within the daily cap
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

    case "backfill": {
      if (flag("off")) {
        openDb().query("DELETE FROM meta WHERE k = 'backfill_since'").run();
        return console.log("backfill off; extraction is back to the last " + loadConfig().extract.horizonDays + " days");
      }
      const days = Number(opt("days"));
      if (!days || days <= 0) return console.error("usage: ctx backfill --days <n> [--dry-run] | ctx backfill --off");
      const since = Math.min(Date.now() / 1000 - days * 86400, extractSince());
      const est = estimateBacklog(since);
      const cfg = loadConfig().extract;
      const u = openDb().query("SELECT SUM(calls) calls, SUM(cost) cost FROM usage WHERE kind = 'extract'").get() as any;
      const perCall = u?.calls ? u.cost / u.calls : 0.004;
      console.log(
        `${est.sessions} sessions, ${est.turns} turns since ${new Date(since * 1000).toISOString().slice(0, 10)} → about ${est.calls} model calls, ~$${(est.calls * perCall).toFixed(2)} list price, ` +
          `${Math.max(1, Math.ceil(est.calls / cfg.maxCallsPerDay))} day(s) at ${cfg.maxCallsPerDay} calls/day (new chats always go first).`,
      );
      if (flag("dry-run")) return;
      setMeta("backfill_since", String(since));
      console.log(daemonPid() ? "backfill scheduled; ctxd works through it in the background (see ctx status)." : "backfill scheduled; it runs once ctxd is up.");
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
      const rows = listSessions(p?.id, Number(opt("n", "n") ?? 15));
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
      console.log(`session ${s.id} · ${s.harness}/${s.source} · ${s.branch ?? ""} · last ${ago(s.last_ts)}`);
      for (const t of tailSession(s.id, Number(opt("n", "n") ?? 6))) {
        console.log(`\n[${shortTurnId(t.id, t.idx)} · ${ago(t.ts_end)}${t.complete ? "" : " · in progress"}]`);
        console.log(`USER: ${oneLine(t.user, 600)}`);
        if (t.assistant) console.log(`AGENT: ${oneLine(t.assistant.slice(-1200), 800)}`);
      }
      return;
    }

    case "facts": {
      const p = currentProject()!;
      const rows = listFacts(p.id, { type: opt("type"), inactive: flag("inactive") });
      for (const f of rows) console.log(`[${f.id}] ${f.type.padEnd(10)} ${f.status === "active" ? "" : `(${f.status}) `}${withWhy(f.text, f.why)}  (${f.origin} · ${f.harness ?? ""})`);
      if (!rows.length) console.log("no facts");
      return;
    }

    case "projects": {
      for (const r of listProjects()) console.log(`${r.slug.padEnd(36)} ${String(r.sessions).padStart(4)} sessions ${String(r.facts).padStart(4)} facts  ${r.last ? ago(r.last).padEnd(8) : ""}  ${r.id}`);
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
      const e = addNote(p.id, type, text, opt("why"), { session, harness: process.env.ORCA_PANE_KEY ? "orca" : undefined });
      console.log(`saved [${e.fact}] ${type}: ${text} → ${p.slug}`);
      return;
    }

    case "done":
    case "retract":
    case "keep": {
      const ids = positional();
      if (!ids.length) return console.error(`usage: ctx ${cmd} <fact-id…>`);
      const { ok, missing } = applyFactAction(ids, cmd as FactAction, opt("why"));
      for (const id of missing) console.error(`no such fact: ${id}`);
      for (const f of ok) console.log(`${{ done: "marked done", retract: "retracted", keep: "kept" }[cmd as FactAction]} [${f.id}] ${f.text}`);
      return;
    }

    case "dedupe": {
      const p = flag("all") ? undefined : currentProject();
      const pairs = duplicates(p?.id);
      if (!pairs.length) return console.log("no duplicates");
      for (const { keep, drop } of pairs) console.log(`[${drop.id}] ${oneLine(drop.text, 150)}\n  → same as [${keep.id}] ${oneLine(keep.text, 150)}\n`);
      if (!flag("apply")) return console.log(`${pairs.length} duplicates. Run with --apply to merge them into the newer fact.`);
      console.log(`merged ${mergeDuplicates(pairs)} duplicates`);
      return;
    }

    case "review": {
      const p = flag("all") ? undefined : currentProject();
      const days = Number(opt("days") ?? loadConfig().brief.staleDays);
      const rows = reviewItems(p?.id, days);
      if (!rows.length) return console.log(`nothing older than ${days} days to review${p ? ` in ${p.slug}` : ""}`);
      let last = "";
      for (const f of rows) {
        if (!p && f.slug !== last) console.log(`\n${(last = f.slug)}`);
        const unconfirmed = f.origin === "agent" && f.confidence < 0.8 ? ", unconfirmed" : "";
        console.log(`[${f.id}] ${f.type.padEnd(10)} ${ago(f.updated).padEnd(8)} ${oneLine(f.text, 160)}  (${f.origin}${unconfirmed})`);
      }
      console.log(`\n${rows.length} to review. Clear with: ctx done <id…> · ctx retract <id…> · ctx keep <id…> (still true)`);
      return;
    }

    case "status": {
      const cfg = loadConfig();
      const d = await callDaemon<{ pid: number; uptime: number; embedReady: boolean }>("/status", undefined, 1000);
      console.log(`ctxd: ${d ? `running (pid ${d.pid}, up ${Math.round(d.uptime / 60)}m, embeddings ${d.embedReady ? "ready" : "loading/off"})` : "NOT RUNNING"}`);
      const h = health();
      // Ingest lag per source: newest transcript write vs what we've consumed.
      for (const s of h.sources) console.log(`${s.source.padEnd(6)} files tracked: ${s.files}, unread bytes: ${s.unreadBytes}, newest turn: ${s.newest ? ago(s.newest) : "-"}`);
      console.log(`turns: ${h.turns} (embedded ${h.embedded}), sessions: ${h.sessions}, active facts: ${h.facts}`);
      console.log(`extraction today: ${h.extract.calls}/${cfg.extract.maxCallsPerDay} calls, ${h.extract.failures} failures, ~$${h.extract.cost.toFixed(3)} list-price; pending sessions: ${h.extract.pending}`);
      if (h.backfill) console.log(`backfill since ${new Date(h.backfill.since * 1000).toISOString().slice(0, 10)}: ~${h.backfill.calls} calls left (${h.backfill.sessions} sessions)${h.backfill.calls ? "" : "; done, run ctx backfill --off to clear"}`);
      if (h.lastScan) console.log(`last scan: ${ago(h.lastScan)}`);
      if (h.indexBytes) console.log(`index: ${(h.indexBytes / 1e6).toFixed(1)} MB at ${paths.db}`);
      return;
    }

    case "recall-stats": {
      const r = recallStats();
      if (!r.prompts) return console.log("no recall data yet (logged per prompt once embeddings are ready)");
      console.log(`${r.prompts} prompts searched with vectors, ${r.injected} got notes (${((r.injected / r.prompts) * 100).toFixed(0)}%); recall.minSim = ${r.minSim}`);
      console.log("best match per prompt:");
      for (const b of r.buckets) {
        if (b.n || b.threshold) console.log(`  ${b.lo.toFixed(2)}–${(b.lo + 0.02).toFixed(2)} ${"█".repeat(Math.ceil((b.n / r.prompts) * 50))} ${b.n}${b.threshold ? "  ← threshold" : ""}`);
      }
      if (r.near.length) {
        console.log(`\nnear misses (just under the threshold). If these look relevant, lower recall.minSim:`);
        for (const h of r.near) console.log(`  ${h.sim.toFixed(3)}  ctx show ${h.id}`);
      }
      return;
    }

    case "ui": {
      if (flag("off")) {
        updateConfig("ui", { enabled: false });
        return console.log("ui disabled; it stops listening the next time ctxd restarts (launchctl kickstart -k gui/$(id -u)/com.ctx.daemon)");
      }
      if (!loadConfig().ui.enabled) updateConfig("ui", { enabled: true });
      const port = loadConfig().ui.port;
      const r = await callDaemon<{ port: number }>("/ui", { port }, 3000);
      if (!r) return console.error("ctxd isn't reachable, so the page can't be served. Check with: ctx doctor");
      const url = `http://127.0.0.1:${r.port}/?t=${uiToken()}`;
      if (flag("no-open")) return console.log(url);
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      const opened = Bun.spawnSync([opener, url], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
      console.log(opened ? `opened http://127.0.0.1:${r.port}` : `open this link in your browser: ${url}`);
      return;
    }

    case "doctor": {
      const checks = doctorChecks();
      // Give a just-restarted daemon a few seconds to come up before calling it down.
      let d = await callDaemon<any>("/status", undefined, 1000);
      for (let i = 0; !d && i < 8; i++) {
        await Bun.sleep(1000);
        d = await callDaemon<any>("/status", undefined, 1000);
      }
      checks.unshift({ ok: Boolean(d), name: "ctxd running", detail: d ? `pid ${d.pid}` : `not reachable at ${paths.socket}` });
      const ui = loadConfig().ui;
      if (ui.enabled) {
        const up = await fetch(`http://127.0.0.1:${ui.port}/`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
        checks.push({ ok: up, name: "ui page", detail: up ? `http://127.0.0.1:${ui.port} (open with ctx ui)` : `not answering on 127.0.0.1:${ui.port}; run ctx ui` });
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
