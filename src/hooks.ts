// Hook handlers shared by the daemon (warm, with embeddings) and the direct fallback.

import { oneLine } from "./adapters/types";
import { renderBrief } from "./brief";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { projectBySlugOrId, resolveProject, scopeProject, type Project } from "./project";
import { confident, queryTerms, search, type Hit } from "./search";

export type Harness = "claude" | "codex";
export type HookEvent = "session-start" | "prompt";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  transcript_path?: string;
  [k: string]: unknown;
}

function currentBranch(cwd: string): string | undefined {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
}

export function projectForCwd(cwd: string | undefined): Project | undefined {
  if (!cwd) return undefined;
  const base = resolveProject(cwd);
  return scopeProject(base, currentBranch(cwd), loadConfig().branchScopedRepos);
}

const TRIVIAL = /^(y|yes|no|ok|okay|k|sure|continue|go|go ahead|do it|proceed|thanks|thank you|ty|great|nice|cool|lgtm)\W*$/i;

export function shortTurnId(turnId: string, idx: number): string {
  const session = turnId.split(":")[1] ?? turnId;
  return `t:${session.slice(0, 8)}.${idx}`;
}

function day(ts: number) {
  return new Date(ts * 1000).toISOString().slice(5, 10);
}

/** The window of `text` (about `size` chars) that contains the most query terms. */
export function bestWindow(text: string, terms: string[], size: number): string {
  const flat = oneLine(text, 100_000);
  if (flat.length <= size || !terms.length) return oneLine(flat, size);
  const lower = flat.toLowerCase();
  const step = Math.max(40, Math.floor(size / 4));
  let best = Math.max(0, flat.length - size);
  let bestScore = -1;
  for (let start = 0; start < flat.length - size + step; start += step) {
    const win = lower.slice(start, start + size);
    let score = 0;
    for (const t of terms) if (win.includes(t)) score++;
    if (score > bestScore) (bestScore = score), (best = start);
  }
  const out = flat.slice(best, best + size).trim();
  return `${best > 0 ? "…" : ""}${out}${best + size < flat.length ? "…" : ""}`;
}

export function formatHit(h: Hit, maxLen = 700, terms: string[] = []): string {
  if (h.kind === "fact") {
    const why = h.meta.why ? ` — ${oneLine(h.meta.why, 160)}` : "";
    return `- [${h.id}] ${h.meta.type}: ${oneLine(h.text, 260)}${why} (${h.meta.harness ?? ""} · ${day(h.ts)})`;
  }
  const user = oneLine(h.text, 240);
  const room = Math.max(120, maxLen - user.length - 80);
  const agent = bestWindow(String(h.meta.assistant ?? ""), terms, room);
  return `- [${shortTurnId(h.id, h.meta.idx)} · ${day(h.ts)} · ${h.meta.harness ?? "?"}${h.meta.branch ? " · " + h.meta.branch : ""}] user: "${user}"${agent ? ` → agent: "${agent}"` : ""}`;
}

/** Projects other than the current one that the prompt names explicitly (by slug). */
function mentionedProjects(prompt: string, current?: string): Project[] {
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []);
  const rows = openDb().query("SELECT id, slug, root, remote FROM projects").all() as Project[];
  return rows.filter((p) => p.id !== current && p.slug.length >= 5 && words.has(p.slug.toLowerCase()));
}

export async function handleHook(
  harness: Harness,
  event: HookEvent,
  input: HookInput,
  embedQuery?: (q: string) => Promise<Float32Array | undefined>,
): Promise<string | undefined> {
  if (process.env.CTX_INTERNAL) return undefined;
  const project = projectForCwd(input.cwd);

  if (event === "session-start") {
    if (!project) return undefined;
    const body = renderBrief(project, { excludeSession: input.session_id });
    return body || undefined;
  }

  const prompt = String(input.prompt ?? "").trim();
  if (prompt.length < 15 || prompt.startsWith("/") || TRIVIAL.test(prompt)) return undefined;
  const terms = queryTerms(prompt);
  if (terms.length < 2) return undefined;

  const cfg = loadConfig().recall;
  const qvec = embedQuery ? await embedQuery(prompt.slice(0, 1500)).catch(() => undefined) : undefined;
  const db = openDb();
  const sess = input.session_id ? (db.query("SELECT started FROM sessions WHERE id = ?").get(input.session_id) as any) : null;
  const sessionStart = sess?.started ?? Date.now() / 1000;

  const scopes = [project, ...mentionedProjects(prompt, project?.id)].filter(Boolean) as Project[];
  if (!scopes.length) return undefined;
  const picked: Hit[] = [];
  for (const p of scopes) {
    const hits = search(prompt, { project: p.id, excludeSession: input.session_id, qvec, limit: 8 });
    for (const h of hits) {
      if (!confident(h, Boolean(qvec), terms.length, cfg.minSim)) continue;
      // Facts that existed when this session started were already in its brief.
      if (h.kind === "fact" && p.id === project?.id && h.ts < sessionStart) continue;
      picked.push(h);
    }
  }
  if (!picked.length) return undefined;
  picked.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let size = 0;
  for (const h of picked.slice(0, cfg.maxSnippets)) {
    const line = formatHit(h, 700, terms);
    if (size + line.length > cfg.maxChars) break;
    lines.push(line);
    size += line.length;
  }
  const other = scopes.filter((s) => s.id !== project?.id).map((s) => s.slug);
  const head = `Possibly relevant notes from other agent sessions${other.length ? ` (incl. project ${other.join(", ")})` : ""}. Reference data, may be stale. Details: \`ctx show <id>\`.`;
  return `<ctx-context kind="recall">\n${head}\n${lines.join("\n")}\n</ctx-context>`;
}

export function hookOutput(harness: Harness, event: HookEvent, context: string | undefined): string {
  if (!context) return "";
  const hookEventName = event === "session-start" ? "SessionStart" : "UserPromptSubmit";
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: context } });
}

export { projectBySlugOrId };
