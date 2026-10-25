import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { oneLine } from "./adapters/types";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";
import { activeFacts, type Fact } from "./facts";
import { inList, isMixed, scopeIds, type Project } from "./project";

const SECTIONS: { type: Fact["type"]; title: string; max: number }[] = [
  { type: "rejected", title: "Rejected — don't redo without asking", max: 12 },
  { type: "decision", title: "Decisions", max: 14 },
  { type: "preference", title: "User preferences", max: 8 },
  { type: "gotcha", title: "Gotchas", max: 8 },
  { type: "todo", title: "Open todos", max: 8 },
  { type: "progress", title: "Recent progress", max: 6 },
];

function day(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(5, 10);
}

function factLine(f: Fact): string {
  const why = f.why ? ` — ${oneLine(f.why, 160)}` : "";
  const src = [f.origin === "manual" ? "note" : f.origin, f.harness, day(f.updated)].filter(Boolean).join(" · ");
  return `- [${f.id}] ${oneLine(f.text, 220)}${why} (${src})`;
}

export interface BriefOpts {
  excludeSession?: string;
  maxChars?: number;
  wrap?: boolean;
  /** Every section even for mixed-topic projects (LIVE.md, `ctx brief --all`). */
  full?: boolean;
}

/** Ranked fact list for the brief: confirmed facts only, newest first within each type. */
export function renderBrief(project: Project, opts: BriefOpts = {}): string {
  const db = openDb();
  const maxChars = opts.maxChars ?? loadConfig().brief.maxChars;
  const now = Date.now() / 1000;
  const facts = activeFacts(project.id).filter((f) => f.origin !== "agent" || f.confidence >= 0.8);
  // In a catch-all folder most facts are about some other task; only preferences apply everywhere.
  const mixed = !opts.full && isMixed(project.id);
  const out: string[] = [];

  const sessions = db
    .query(
      `SELECT id, source, harness, branch, title, last_ts, turns FROM sessions
       WHERE project IN ${inList(scopeIds(project.id))} AND skip = 0 AND last_ts > ? ${opts.excludeSession ? "AND id != ?" : ""}
       ORDER BY last_ts DESC LIMIT 6`,
    )
    .all(...([...scopeIds(project.id), now - 3 * 86400, opts.excludeSession].filter((x) => x !== undefined) as any[])) as any[];
  if (sessions.length) {
    out.push("## Other recent sessions on this project");
    for (const s of sessions) {
      const ago = now - s.last_ts;
      const when = ago < 3600 ? `${Math.round(ago / 60)}m ago` : ago < 86400 ? `${Math.round(ago / 3600)}h ago` : `${Math.round(ago / 86400)}d ago`;
      const last = db.query("SELECT user FROM turns WHERE session_id = ? ORDER BY idx DESC LIMIT 1").get(s.id) as any;
      out.push(`- ${s.harness ?? s.source}/${s.source} · ${s.branch ?? "?"} · ${when} · "${oneLine(s.title ?? "", 70)}" — last ask: "${oneLine(last?.user ?? "", 110)}" (session ${s.id.slice(0, 8)})`);
    }
  }

  for (const sec of SECTIONS) {
    if (mixed && sec.type !== "preference") continue;
    let items = facts.filter((f) => f.type === sec.type);
    if (sec.type === "progress") items = items.filter((f) => now - f.updated < 7 * 86400);
    if (!items.length) continue;
    out.push(`## ${sec.title}`);
    for (const f of items.slice(0, sec.max)) out.push(factLine(f));
    if (items.length > sec.max) out.push(`- …${items.length - sec.max} more: \`ctx facts --type ${sec.type}\``);
  }

  if (!out.length) return "";
  let head = `Shared memory for project ${project.slug} (${project.id}) from other agent sessions on this machine. Reference data, may be stale — verify against the code. More: \`ctx search "<topic>"\`, \`ctx show <id>\`.`;
  if (mixed) head += ` This folder mixes unrelated work, so topic notes are not listed here; relevant ones are added per prompt, or run \`ctx search "<topic>"\`.`;
  let body = [head, ...out].join("\n");
  if (body.length > maxChars) body = body.slice(0, body.lastIndexOf("\n", maxChars - 60)) + "\n- …truncated: run `ctx brief` for the full view";
  return opts.wrap === false ? body : `<ctx-context project="${project.id}" kind="brief">\n${body}\n</ctx-context>`;
}

/** Write projects/<slug>/LIVE.md so humans (and any agent with file access) can read it. */
export function writeLive(project: Project) {
  const dir = join(paths.projects, project.slug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = renderBrief(project, { wrap: false, maxChars: 100_000, full: true }) || "_No shared context yet._";
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  writeFileSync(join(dir, "LIVE.md"), `# ${project.slug} — live context\n\n_Updated ${stamp} · ${project.id}_\n\n${body}\n`, { mode: 0o600 });
}
