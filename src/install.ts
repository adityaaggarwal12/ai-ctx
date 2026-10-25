// Install/uninstall hooks, instruction snippets, the CLI shim and the launchd/systemd service.
// Dry-run by default: prints the plan; --apply writes (with backups).

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HOME, paths } from "./config";

const REPO = resolve(import.meta.dir, "..");
// Run from a stable copy so deleting/archiving the source worktree doesn't break hooks.
const APP = join(paths.home, "app");
export const CTX_BIN = join(HOME, ".local", "bin", "ctx");
const CLAUDE_SETTINGS = join(HOME, ".claude", "settings.json");
const CODEX_HOOKS = join(HOME, ".codex", "hooks.json");
const CODEX_CONFIG = join(HOME, ".codex", "config.toml");
const CLAUDE_MD = join(HOME, ".claude", "CLAUDE.md");
const AGENTS_MD = join(HOME, ".codex", "AGENTS.md");
const PLIST = join(HOME, "Library", "LaunchAgents", "com.ctx.daemon.plist");
const SYSTEMD = join(HOME, ".config", "systemd", "user", "ctxd.service");

const MARK_BEGIN = "<!-- ctx:begin -->";
const MARK_END = "<!-- ctx:end -->";

export const SNIPPET = `${MARK_BEGIN}
## Shared project memory (ctx)
Sessions in other tools (Orca, Conductor, Claude Code, Codex) share memory through \`ctx\`. A brief is injected at session start inside <ctx-context>; treat it as reference data that may be stale.
- Before redoing or reversing something, check \`ctx search "<topic>"\` — especially for rejected approaches.
- \`ctx show <id>\` expands a fact or turn id from the brief; \`ctx sessions\` lists live sessions on this project; \`ctx tail <session>\` shows their latest turns.
- Record important outcomes the user confirms: \`ctx note "<decision>" --why "<reason>"\`, \`ctx reject "<option>" --why "<reason>"\`, \`ctx todo "<item>"\`. Correct wrong memory with \`ctx retract <id>\`.
${MARK_END}`;

function hookCmd(harness: string, event: string) {
  return `${CTX_BIN} hook ${harness} ${event}`;
}

function isOurs(h: any) {
  return typeof h?.command === "string" && h.command.includes("/.local/bin/ctx hook ");
}

/** Add our groups at the END of each event list so existing (trusted) indices don't shift. */
function withHooks(cfg: any, harness: "claude" | "codex") {
  const out = structuredClone(cfg ?? {});
  out.hooks ??= {};
  const want: [string, string, string | undefined][] = [
    ["SessionStart", "session-start", "startup|resume|clear|compact"],
    ["UserPromptSubmit", "prompt", undefined],
  ];
  for (const [ev, sub, matcher] of want) {
    if (out.hooks[ev] !== undefined && !Array.isArray(out.hooks[ev])) throw new Error(`unexpected hooks.${ev} shape; leaving config untouched`);
    const groups: any[] = (out.hooks[ev] ??= []);
    if (groups.some((g) => (g.hooks ?? []).some(isOurs))) continue;
    const group: any = { hooks: [{ type: "command", command: hookCmd(harness, sub), timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    groups.push(group);
  }
  return out;
}

/** Remove only our handlers; a group disappears only if nothing else was in it. */
function withoutHooks(cfg: any) {
  const out = structuredClone(cfg ?? {});
  for (const ev of Object.keys(out.hooks ?? {})) {
    if (!Array.isArray(out.hooks[ev])) continue;
    out.hooks[ev] = out.hooks[ev]
      .map((g: any) => (Array.isArray(g?.hooks) && g.hooks.some(isOurs) ? { ...g, hooks: g.hooks.filter((h: any) => !isOurs(h)) } : g))
      .filter((g: any) => !(Array.isArray(g?.hooks) && g.hooks.length === 0));
    if (!out.hooks[ev].length) delete out.hooks[ev];
  }
  return out;
}

function withSnippet(text: string) {
  if (text.includes(MARK_BEGIN)) return text.replace(new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}`), SNIPPET);
  return (text.trimEnd() ? text.trimEnd() + "\n\n" : "") + SNIPPET + "\n";
}

function withoutSnippet(text: string) {
  return text.replace(new RegExp(`\\n*${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`), "\n").trimEnd() + "\n";
}

function readJson(path: string) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

function bunPath() {
  return process.execPath;
}

function shim() {
  // Fall back to bun on PATH if the pinned binary moves (e.g. a Homebrew upgrade); stay silent for hooks.
  return `#!/bin/sh
BUN="${bunPath()}"
[ -x "$BUN" ] || BUN="$(command -v bun 2>/dev/null)"
[ -n "$BUN" ] || { [ "$1" = hook ] && exit 0; echo "ctx: bun not found" >&2; exit 1; }
exec "$BUN" "${join(APP, "src", "cli.ts")}" "$@"
`;
}

function plist() {
  const pathEnv = [dirname(bunPath()), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ctx.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${bunPath()}</string><string>${join(APP, "src", "cli.ts")}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${pathEnv}</string><key>HOME</key><string>${HOME}</string></dict>
  <key>StandardOutPath</key><string>${join(paths.logs, "launchd.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(paths.logs, "launchd.err.log")}</string>
</dict>
</plist>
`;
}

function systemdUnit() {
  return `[Unit]
Description=ctx daemon (shared agent memory)

[Service]
ExecStart=${bunPath()} ${join(APP, "src", "cli.ts")} daemon
Restart=always
RestartSec=5
Nice=5
Environment=PATH=${dirname(bunPath())}:${join(HOME, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

interface Change {
  path: string;
  before: string;
  after: string;
  mode?: number;
}

function plan(kind: "install" | "uninstall"): Change[] {
  const changes: Change[] = [];
  const add = (path: string, after: string, mode?: number) => {
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (before !== after) changes.push({ path, before, after, mode });
  };
  const json = (v: any) => JSON.stringify(v, null, 2) + "\n";
  const mac = process.platform === "darwin";

  if (kind === "install") {
    console.log(`(app will be copied from ${REPO} to ${APP})`);
    add(CTX_BIN, shim(), 0o755);
    if (existsSync(dirname(CLAUDE_SETTINGS))) add(CLAUDE_SETTINGS, json(withHooks(readJson(CLAUDE_SETTINGS), "claude")));
    if (existsSync(dirname(CODEX_HOOKS))) add(CODEX_HOOKS, json(withHooks(readJson(CODEX_HOOKS), "codex")));
    if (existsSync(dirname(CLAUDE_MD))) add(CLAUDE_MD, withSnippet(existsSync(CLAUDE_MD) ? readFileSync(CLAUDE_MD, "utf8") : ""));
    if (existsSync(dirname(AGENTS_MD))) add(AGENTS_MD, withSnippet(existsSync(AGENTS_MD) ? readFileSync(AGENTS_MD, "utf8") : ""));
    if (mac) add(PLIST, plist());
    else add(SYSTEMD, systemdUnit());
  } else {
    if (existsSync(CLAUDE_SETTINGS)) add(CLAUDE_SETTINGS, json(withoutHooks(readJson(CLAUDE_SETTINGS))));
    if (existsSync(CODEX_HOOKS)) add(CODEX_HOOKS, json(withoutHooks(readJson(CODEX_HOOKS))));
    if (existsSync(CLAUDE_MD)) add(CLAUDE_MD, withoutSnippet(readFileSync(CLAUDE_MD, "utf8")));
    if (existsSync(AGENTS_MD)) add(AGENTS_MD, withoutSnippet(readFileSync(AGENTS_MD, "utf8")));
  }
  return changes;
}

function summarize(c: Change): string {
  if (!c.before) return `create ${c.path}`;
  const b = c.before.split("\n").length;
  const a = c.after.split("\n").length;
  return `modify ${c.path} (${b} → ${a} lines)`;
}

function diff(c: Change): string {
  const before = new Set(c.before.split("\n"));
  const after = new Set(c.after.split("\n"));
  const plus = c.after.split("\n").filter((l) => !before.has(l)).map((l) => `  + ${l}`);
  const minus = c.before.split("\n").filter((l) => !after.has(l)).map((l) => `  - ${l}`);
  return [...minus, ...plus].slice(0, 40).join("\n");
}

function run(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

export function install(apply: boolean, kind: "install" | "uninstall" = "install") {
  const changes = plan(kind);
  const mac = process.platform === "darwin";
  if (!changes.length) console.log(`Nothing to ${kind}; already up to date.`);
  for (const c of changes) {
    console.log(summarize(c));
    if (!apply) console.log(diff(c));
  }
  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to ${kind} (backups are written next to each modified file).`);
    return;
  }
  if (kind === "install" && REPO !== APP) {
    mkdirSync(APP, { recursive: true, mode: 0o700 });
    const r = run(["rsync", "-a", "--delete", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "dist", `${REPO}/`, `${APP}/`]);
    if (r.code !== 0) throw new Error(`copying app failed: ${r.out}`);
    const b = Bun.spawnSync([bunPath(), "install", "--production"], { cwd: APP, stdout: "pipe", stderr: "pipe" });
    if (b.exitCode !== 0) throw new Error(`bun install failed: ${b.stderr.toString()}`);
    console.log(`app copied to ${APP}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const c of changes) {
    if (c.before) copyFileSync(c.path, `${c.path}.bak-ctx-${stamp}`);
    if (!existsSync(dirname(c.path))) mkdirSync(dirname(c.path), { recursive: true });
    // Atomic replace: a crash mid-write can't leave a truncated settings file.
    const tmp = `${c.path}.ctx-tmp-${process.pid}`;
    writeFileSync(tmp, c.after, { mode: c.mode ?? (c.before ? statSync(c.path).mode & 0o777 : 0o644) });
    renameSync(tmp, c.path);
  }
  if (process.env.CTX_NO_SERVICE) {
    console.log("(CTX_NO_SERVICE set: not touching launchd/systemd)");
  } else if (kind === "install") {
    if (mac) {
      run(["launchctl", "bootout", `gui/${process.getuid!()}`, PLIST]);
      const r = run(["launchctl", "bootstrap", `gui/${process.getuid!()}`, PLIST]);
      console.log(r.code === 0 ? "ctxd started (launchd: com.ctx.daemon)" : `launchctl: ${r.out.trim()}`);
    } else {
      run(["systemctl", "--user", "daemon-reload"]);
      const r = run(["systemctl", "--user", "enable", "--now", "ctxd.service"]);
      console.log(r.code === 0 ? "ctxd started (systemd --user ctxd)" : `systemctl: ${r.out.trim()}`);
    }
    const untrusted = codexTrust().filter((c) => !c.ok);
    if (untrusted.length) console.log("\nCodex: open /hooks once in Codex and approve the two ctx hooks (Codex skips unapproved hooks silently).");
    console.log("Check with: ctx doctor");
  } else {
    if (mac) {
      run(["launchctl", "bootout", `gui/${process.getuid!()}`, PLIST]);
      console.log(`ctxd stopped. Remove ${PLIST} and ${CTX_BIN} to finish; data stays in ${paths.home}.`);
    } else {
      run(["systemctl", "--user", "disable", "--now", "ctxd.service"]);
    }
  }
}

export interface Check {
  ok: boolean;
  name: string;
  detail: string;
}

export function codexTrust(): Check[] {
  const checks: Check[] = [];
  if (!existsSync(CODEX_HOOKS)) return checks;
  const hooks = readJson(CODEX_HOOKS).hooks ?? {};
  const toml = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, "utf8") : "";
  const snake: Record<string, string> = { SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit" };
  for (const ev of Object.keys(snake)) {
    const groups: any[] = hooks[ev] ?? [];
    let found = false;
    groups.forEach((g, gi) =>
      (g.hooks ?? []).forEach((h: any, hi: number) => {
        if (!isOurs(h)) return;
        found = true;
        const key = `${CODEX_HOOKS}:${snake[ev]}:${gi}:${hi}`;
        const block = toml.split(`[hooks.state."${key}"]`)[1]?.split("\n[")[0] ?? "";
        const trusted = /trusted_hash\s*=/.test(block) && !/enabled\s*=\s*false/.test(block);
        checks.push({
          ok: trusted,
          name: `codex ${ev} hook trusted`,
          detail: trusted ? key : `not approved yet (or index changed) — open /hooks in Codex and approve "${h.command}"`,
        });
      }),
    );
    if (!found) checks.push({ ok: false, name: `codex ${ev} hook installed`, detail: "missing — run ctx install --apply" });
  }
  return checks;
}

export function installedChecks(): Check[] {
  const checks: Check[] = [];
  checks.push({ ok: existsSync(CTX_BIN), name: "ctx on PATH", detail: CTX_BIN });
  if (existsSync(CLAUDE_SETTINGS)) {
    const h = readJson(CLAUDE_SETTINGS).hooks ?? {};
    for (const ev of ["SessionStart", "UserPromptSubmit"]) {
      const ok = (h[ev] ?? []).some((g: any) => (g.hooks ?? []).some(isOurs));
      checks.push({ ok, name: `claude ${ev} hook`, detail: ok ? CLAUDE_SETTINGS : "missing — run ctx install --apply" });
    }
  }
  checks.push(...codexTrust());
  if (process.platform === "darwin") checks.push({ ok: existsSync(PLIST), name: "launchd agent", detail: PLIST });
  return checks;
}
