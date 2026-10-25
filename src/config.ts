import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CTX_HOME = process.env.CTX_HOME ?? join(HOME, ".ctx");

export const paths = {
  home: CTX_HOME,
  config: join(CTX_HOME, "config.json"),
  db: join(CTX_HOME, "index.sqlite"),
  archive: join(CTX_HOME, "archive"),
  events: join(CTX_HOME, "events"),
  projects: join(CTX_HOME, "projects"),
  runtime: join(CTX_HOME, "runtime"),
  models: join(CTX_HOME, "models"),
  logs: join(CTX_HOME, "logs"),
  socket: join(CTX_HOME, "ctxd.sock"),
  pid: join(CTX_HOME, "ctxd.pid"),
};

export interface Config {
  machine: string;
  sources: { claude: string[]; codex: string[] };
  /** Repo ids (e.g. "github.com/me/playground") where each branch is a separate project. */
  branchScopedRepos: string[];
  /**
   * Project aliases: a project also sees the memory of the listed older projects
   * (e.g. a repo that started life as a branch of another repo).
   */
  projectAliases: Record<string, string[]>;
  /**
   * Project ids of catch-all folders where unrelated work happens side by side (e.g. a
   * scratch dir you launch agents from). Their brief carries no topical facts; relevant
   * notes arrive per prompt instead.
   */
  mixedProjects: string[];
  /** Sessions whose cwd contains any of these substrings are ignored. */
  ignoreCwd: string[];
  extract: {
    enabled: boolean;
    model: string;
    minTurns: number;
    idleSeconds: number;
    maxCallsPerDay: number;
    maxInputChars: number;
    /** Only turns newer than this are extracted (older history stays searchable as raw turns). */
    horizonDays: number;
  };
  /** horizonDays: only turns newer than this get vectors (older ones stay keyword-searchable). */
  embed: { enabled: boolean; model: string; dtype: string; horizonDays: number };
  /** staleDays: todos and gotchas not confirmed for this long leave the brief (see `ctx review`). */
  brief: { maxChars: number; staleDays: number };
  recall: { maxSnippets: number; maxChars: number; minSim: number };
}

const defaults: Config = {
  machine: hostname().split(".")[0].toLowerCase(),
  sources: {
    claude: [join(HOME, ".claude", "projects")],
    codex: [join(HOME, ".codex", "sessions")],
  },
  branchScopedRepos: [],
  projectAliases: {},
  mixedProjects: [],
  ignoreCwd: ["/Library/Application Support/Claude/scratch-workspaces/", "/.ctx/"],
  extract: {
    enabled: true,
    model: "haiku",
    minTurns: 3,
    idleSeconds: 120,
    maxCallsPerDay: 200,
    maxInputChars: 24000,
    horizonDays: 10,
  },
  embed: { enabled: true, model: "onnx-community/embeddinggemma-300m-ONNX", dtype: "q8", horizonDays: 90 },
  brief: { maxChars: 6000, staleDays: 30 },
  recall: { maxSnippets: 3, maxChars: 2500, minSim: 0.53 },
};

export function ensureDirs() {
  for (const p of [paths.home, paths.archive, paths.events, paths.projects, paths.runtime, paths.models, paths.logs]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(paths.home, 0o700);
  } catch {}
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;
  ensureDirs();
  let user: Partial<Config> = {};
  if (existsSync(paths.config)) {
    user = JSON.parse(readFileSync(paths.config, "utf8"));
  } else {
    writeFileSync(paths.config, JSON.stringify(defaults, null, 2) + "\n", { mode: 0o600 });
  }
  cached = {
    ...defaults,
    ...user,
    sources: { ...defaults.sources, ...user.sources },
    extract: { ...defaults.extract, ...user.extract },
    embed: { ...defaults.embed, ...user.embed },
    brief: { ...defaults.brief, ...user.brief },
    recall: { ...defaults.recall, ...user.recall },
  };
  return cached;
}
