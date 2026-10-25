// Local review page served by ctxd on 127.0.0.1. A localhost port is reachable from any web page
// the user visits, so every request is checked: Host allowlist (DNS rebinding), a token cookie
// (only `ctx ui` knows the token), and an Origin match on writes (cross-site form posts).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { Server } from "bun";
import { loadConfig, paths } from "./config";
import { openDb } from "./db";
import { FACT_TYPES, getFact, type FactType } from "./facts";
import { shortTurnId } from "./hooks";
import { projectBySlugOrId } from "./project";
import {
  addNote,
  applyFactAction,
  briefPreview,
  doctorChecks,
  duplicates,
  health,
  listFacts,
  listProjects,
  listSessions,
  mergeDuplicates,
  recallStats,
  reviewItems,
  tailSession,
  type Check,
  type FactAction,
} from "./views";

const UI_DIR = join(import.meta.dir, "ui");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const COOKIE = "ctx_ui";

export const tokenPath = () => join(paths.runtime, "ui-token");

/** The page's secret: created once, readable only by the user. */
export function uiToken(): string {
  const file = tokenPath();
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  }
  const t = randomBytes(32).toString("hex");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...SECURITY_HEADERS } });
}

const fail = (status: number, error: string) => json({ error }, status);

export interface DaemonInfo {
  pid: number;
  uptime: number;
  embedReady: boolean;
}

// `claude --version` and file checks are slow-ish; the page polls, so cache them briefly.
let checksCache: { at: number; checks: Check[] } | undefined;
function cachedChecks(): Check[] {
  if (!checksCache || Date.now() - checksCache.at > 5 * 60_000) checksCache = { at: Date.now(), checks: doctorChecks() };
  return checksCache.checks;
}

function factDetail(id: string) {
  const f = getFact(id);
  if (!f) return undefined;
  const db = openDb();
  const turns = (JSON.parse(f.turns || "[]") as string[])
    .map((tid) => db.query("SELECT id, idx, user, ts_start FROM turns WHERE id = ?").get(tid) as any)
    .filter(Boolean)
    .map((t) => ({ id: shortTurnId(t.id, t.idx), user: String(t.user).slice(0, 400), ts: t.ts_start }));
  const mergedFrom = db.query("SELECT id, text, status FROM facts WHERE superseded_by = ?").all(f.id);
  return { ...f, sourceTurns: turns, mergedFrom };
}

async function body(req: Request): Promise<any> {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new Error("expected JSON");
  return req.json();
}

/** Route one request. Exported for tests; `serveUi` wires it to a real listener. */
export async function handleUi(req: Request, port: number, info: () => DaemonInfo): Promise<Response> {
  const url = new URL(req.url);
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  // DNS rebinding: a hostile domain resolving to 127.0.0.1 still sends its own name as Host.
  if (!allowedHosts.includes(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
  const token = uiToken();

  // `ctx ui` opens /?t=<token>: trade it for a cookie, then drop it from the address bar.
  const t = url.searchParams.get("t");
  if (req.method === "GET" && url.pathname === "/" && t) {
    if (!same(t, token)) return new Response("invalid or expired link; run ctx ui again", { status: 403 });
    return new Response(null, {
      status: 303,
      headers: { location: "/", "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`, ...SECURITY_HEADERS },
    });
  }

  const file = STATIC[url.pathname];
  if (req.method === "GET" && file) {
    const path = join(UI_DIR, file);
    if (!existsSync(path)) return new Response("ui files missing; reinstall with ctx install --apply", { status: 500 });
    return new Response(Bun.file(path), { headers: { "content-type": TYPES[file.split(".").pop()!], ...SECURITY_HEADERS } });
  }

  if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
  const c = cookie(req, COOKIE);
  if (!c || !same(c, token)) return fail(401, "not signed in: open the page with `ctx ui`");

  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (!origin || !allowedHosts.map((h) => `http://${h}`).includes(origin)) return fail(403, "cross-origin write refused");
  }

  try {
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/projects":
        return json(listProjects().map((p) => ({ ...p, briefTokens: briefPreview(p.id)?.tokens ?? 0 })));
      case "GET /api/brief": {
        const b = briefPreview(q.get("project") ?? "");
        return b ? json(b) : fail(404, "no such project");
      }
      case "GET /api/facts": {
        const project = q.get("project") || undefined;
        if (q.get("view") === "all") {
          if (!project) return fail(400, "pick a project");
          return json({ facts: listFacts(project, { type: q.get("type") || undefined }), duplicates: [] });
        }
        const type = q.get("type");
        const review = reviewItems(project, Number(q.get("days") ?? loadConfig().brief.staleDays)).filter((f) => !type || f.type === type);
        return json({ facts: review, duplicates: duplicates(project) });
      }
      case "GET /api/fact": {
        const d = factDetail(q.get("id") ?? "");
        return d ? json(d) : fail(404, "no such fact");
      }
      case "GET /api/sessions":
        return json(listSessions(q.get("project") || undefined, Math.min(100, Number(q.get("n") ?? 30))));
      case "GET /api/tail": {
        const id = q.get("session") ?? "";
        return json(tailSession(id, Math.min(30, Number(q.get("n") ?? 6))).map((t) => ({ ...t, shortId: shortTurnId(t.id, t.idx) })));
      }
      case "GET /api/health":
        return json({ daemon: info(), checks: cachedChecks(), health: health(), recall: recallStats(), ui: { port } });
      case "POST /api/facts/action": {
        const { ids, action, why } = await body(req);
        if (!Array.isArray(ids) || !ids.length || !["done", "retract", "keep"].includes(action)) return fail(400, "need ids and action");
        const r = applyFactAction(ids.map(String).slice(0, 200), action as FactAction, why ? String(why).slice(0, 300) : undefined);
        return json({ ok: r.ok.map((f) => f.id), missing: r.missing });
      }
      case "POST /api/dedupe": {
        const { project, drop } = await body(req);
        // Recompute pairs server-side; the client only chooses which detected pairs to merge.
        const wanted = new Set<string>((Array.isArray(drop) ? drop : []).map(String));
        const pairs = duplicates(project ? String(project) : undefined).filter((p) => wanted.has(p.drop.id));
        return json({ merged: mergeDuplicates(pairs) });
      }
      case "POST /api/note": {
        const { project, type, text, why } = await body(req);
        const p = projectBySlugOrId(String(project ?? ""));
        if (!p) return fail(400, "pick a project");
        if (!FACT_TYPES.includes(type)) return fail(400, `type must be one of ${FACT_TYPES.join(", ")}`);
        const clean = String(text ?? "").trim().slice(0, 400);
        if (!clean) return fail(400, "text is empty");
        const e = addNote(p.id, type as FactType, clean, why ? String(why).trim().slice(0, 300) : undefined, { harness: "ui" });
        return json({ id: e.fact });
      }
      default:
        return fail(404, "unknown endpoint");
    }
  } catch (e: any) {
    return fail(500, String(e?.message ?? e));
  }
}

let server: Server<undefined> | undefined;

/** Start the listener (idempotent). Binds 127.0.0.1 only. */
export function serveUi(info: () => DaemonInfo, port = loadConfig().ui.port): { port: number } {
  if (server) return { port: server.port ?? port };
  uiToken();
  server = Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => handleUi(req, port, info) });
  return { port };
}
