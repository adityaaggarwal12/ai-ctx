import { existsSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { openDb } from "./db";
import { HOME, loadConfig } from "./config";

export interface Project {
  id: string;
  slug: string;
  root?: string;
  remote?: string;
}

function git(cwd: string, ...args: string[]): string | undefined {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore", timeout: 1500 });
  if (r.exitCode !== 0) return undefined;
  return r.stdout.toString().trim() || undefined;
}

/** git@github.com:o/r.git, https://u:p@github.com/o/r, ssh://git@host:22/o/r → host/o/r */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^[a-z+]+:\/\//i, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(/^([^/:]+):(\d+)\//, "$1/");
  u = u.replace(/^([^/:]+):/, "$1/");
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  const [host, ...rest] = u.split("/");
  return [host.toLowerCase(), ...rest].join("/");
}

// Harness workspace layouts: ~/conductor/workspaces/<repo>/<name>, ~/orca/workspaces/<repo>/<name>
const WORKSPACE_RE = /\/(?:conductor|orca)\/workspaces\/([^/]+)\/[^/]+/;

export function detectHarness(cwd: string | undefined, hint?: string): string {
  if (hint) return hint;
  if (!cwd) return "cli";
  if (cwd.includes("/orca/workspaces/")) return "orca";
  if (cwd.includes("/conductor/workspaces/") || cwd.includes("/conductor/repos/")) return "conductor";
  if (cwd.includes("/Library/Application Support/Claude/")) return "claude-desktop";
  return "cli";
}

function nearestExisting(p: string): string | undefined {
  let cur = p;
  while (cur && cur !== "/" && cur !== HOME) {
    if (existsSync(cur)) return cur;
    cur = dirname(cur);
  }
  return undefined;
}

function slugFor(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.replace(/^(root|dir):/, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "project";
}

function upsertProject(p: Project): Project {
  const db = openDb();
  const existing = db.query("SELECT id, slug, root, remote FROM projects WHERE id = ?").get(p.id) as Project | null;
  if (existing) return existing;
  // keep slugs unique
  let slug = p.slug;
  for (let i = 2; db.query("SELECT 1 FROM projects WHERE slug = ?").get(slug); i++) slug = `${p.slug}-${i}`;
  db.query("INSERT INTO projects(id, slug, root, remote) VALUES (?, ?, ?, ?)").run(p.id, slug, p.root ?? null, p.remote ?? null);
  return { ...p, slug };
}

/** Resolve a cwd (and optionally a known remote URL) to a stable project id. Cached per cwd. */
export function resolveProject(cwdRaw: string | undefined, remoteHint?: string): Project | undefined {
  if (!cwdRaw) return undefined;
  const cwd = cwdRaw.replace(/^file:\/\//, "");
  const db = openDb();
  const cached = db
    .query("SELECT p.id, p.slug, p.root, p.remote FROM cwd_projects c JOIN projects p ON p.id = c.project WHERE c.cwd = ?")
    .get(cwd) as Project | null;
  if (cached) return cached;

  let project: Project | undefined;
  if (remoteHint) {
    const id = normalizeRemote(remoteHint);
    project = { id, slug: slugFor(id), remote: remoteHint };
  }
  const live = nearestExisting(cwd);
  if (!project && live) {
    const top = git(live, "rev-parse", "--show-toplevel");
    if (top) {
      const remote = git(live, "remote", "get-url", "origin");
      const common = git(live, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const root = common ? dirname(common) : top;
      if (remote) {
        const id = normalizeRemote(remote);
        project = { id, slug: slugFor(id), root, remote };
      } else {
        const first = git(live, "rev-list", "--max-parents=0", "HEAD")?.split("\n")[0];
        const id = first ? `root:${first.slice(0, 12)}` : `dir:${root}`;
        project = { id, slug: basename(root), root };
      }
    }
  }
  if (!project) {
    // Deleted worktree: reuse whatever project its sibling workspaces resolved to.
    const m = cwd.match(WORKSPACE_RE);
    if (m) {
      const sib = db
        .query("SELECT p.id, p.slug, p.root, p.remote FROM cwd_projects c JOIN projects p ON p.id = c.project WHERE c.cwd LIKE ? LIMIT 1")
        .get(`%/workspaces/${m[1]}/%`) as Project | null;
      project = sib ?? { id: `ws:${m[1]}`, slug: m[1] };
    }
  }
  if (!project) {
    let dir = live ?? cwd;
    try {
      dir = realpathSync(dir);
    } catch {}
    if (dir === HOME) return undefined;
    project = { id: `dir:${dir}`, slug: basename(dir), root: dir };
  }
  try {
    project = upsertProject(project);
    db.query("INSERT OR REPLACE INTO cwd_projects(cwd, project) VALUES (?, ?)").run(cwd, project.id);
  } catch {} // read-only or busy DB: still return the resolved id
  return project;
}

/**
 * Some repos hold unrelated work on separate branches (e.g. a playground repo with one
 * idea per worktree). For those, each branch is its own project: `<repo>#<branch>`.
 */
export function scopeProject(base: Project | undefined, branch: string | undefined, branchScoped: string[]): Project | undefined {
  if (!base || !branch || branch === "HEAD" || !branchScoped.includes(base.id)) return base;
  const id = `${base.id}#${branch}`;
  const slug = branch.split("/").pop()!.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60);
  try {
    return upsertProject({ id, slug, root: base.root, remote: base.remote });
  } catch {
    return { id, slug, root: base.root, remote: base.remote };
  }
}

/** A project's own id plus any older projects it inherits memory from. */
export function scopeIds(id: string): string[] {
  const aliases = loadConfig().projectAliases ?? {};
  return [id, ...(aliases[id] ?? []).filter((a) => a !== id)];
}

/** A catch-all folder whose facts span unrelated topics (see Config.mixedProjects). */
export function isMixed(id: string): boolean {
  return (loadConfig().mixedProjects ?? []).includes(id);
}

export function inList(ids: string[]): string {
  return `(${ids.map(() => "?").join(",")})`;
}

export function projectBySlugOrId(key: string): Project | undefined {
  return (openDb().query("SELECT id, slug, root, remote FROM projects WHERE id = ? OR slug = ?").get(key, key) as Project) ?? undefined;
}
