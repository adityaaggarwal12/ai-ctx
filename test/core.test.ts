import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CTX_HOME = mkdtempSync(join(tmpdir(), "ctx-test-"));

const { redact } = await import("../src/redact");
const { normalizeRemote } = await import("../src/project");
const { claudeAdapter } = await import("../src/adapters/claude");
const { codexAdapter } = await import("../src/adapters/codex");
const { stripInjected } = await import("../src/adapters/types");
const { emit, activeFacts, getFact, rebuildFacts, newFactId } = await import("../src/facts");
const { search, queryTerms, confident } = await import("../src/search");
const { bestWindow } = await import("../src/hooks");
const { openDb } = await import("../src/db");
const { renderBrief } = await import("../src/brief");
const { loadConfig } = await import("../src/config");

describe("redact", () => {
  test("known token formats", () => {
    const s = redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789 AKIAABCDEFGHIJKLMNOP");
    expect(s).not.toContain("sk-ant-api03");
    expect(s).not.toContain("ghp_");
    expect(s).not.toContain("AKIAABCDEFGHIJKLMNOP");
  });
  test("key=value secrets but not ordinary config", () => {
    expect(redact("API_KEY=9f8e7d6c5b4a3f2e1d0c")).toBe("API_KEY=[REDACTED:kv]");
    expect(redact('"password": "hunter2hunter2xx"')).toContain("[REDACTED:kv]");
    expect(redact("token_count=5")).toBe("token_count=5");
    expect(redact("auth=true")).toBe("auth=true");
  });
  test("url credentials", () => {
    expect(redact("postgres://admin:s3cret@db.local/x")).toBe("postgres://[REDACTED]@db.local/x");
  });
});

describe("project ids", () => {
  test("remote normalization", () => {
    expect(normalizeRemote("git@github.com:Me/Repo.git")).toBe("github.com/Me/Repo");
    expect(normalizeRemote("https://user:pw@GitHub.com/Me/Repo")).toBe("github.com/Me/Repo");
    expect(normalizeRemote("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("gitlab.example.com/team/app");
  });
});

describe("adapters", () => {
  test("claude: human prompt, tools, assistant; skips meta/notifications/sidechains", () => {
    const st: any = { idx: 0 };
    const base = { sessionId: "s1", cwd: "/tmp/x", gitBranch: "main", timestamp: "2026-10-24T10:00:00Z" };
    const ops = [
      ...claudeAdapter.parse({ ...base, type: "user", uuid: "u1", message: { content: "use sqlite please" } }, st),
      ...claudeAdapter.parse({ ...base, type: "assistant", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "Edit", input: { file_path: "/tmp/x/a.ts" } }] } }, st),
      ...claudeAdapter.parse({ ...base, type: "user", isMeta: true, message: { content: "[Image ...]" } }, st),
      ...claudeAdapter.parse({ ...base, type: "user", turnOrigin: "task_notification", message: { content: "<task-notification>" } }, st),
      ...claudeAdapter.parse({ ...base, type: "user", isSidechain: true, message: { content: "sub" } }, st),
    ];
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toEqual(["session", "turn", "assistant", "tool"]);
    expect((ops[3] as any).files).toEqual(["/tmp/x/a.ts"]);
  });
  test("claude: slash command and injected context", () => {
    const st: any = { idx: 0, sessionId: "s1", cwd: "/tmp/x", branch: "main" };
    const [op] = claudeAdapter.parse({ sessionId: "s1", cwd: "/tmp/x", gitBranch: "main", type: "user", uuid: "u", message: { content: "<command-name>/review</command-name><command-args>pr 12</command-args>" } }, st) as any;
    expect(op.user).toBe("/review pr 12");
    expect(stripInjected('a <ctx-context kind="brief">secret brief</ctx-context> b')).toBe("a  b");
  });
  test("codex: meta, conductor wrapper stripped, guardian skipped", () => {
    const st: any = { idx: 0 };
    const ts = "2026-10-24T10:00:00Z";
    const ops = [
      ...codexAdapter.parse({ timestamp: ts, type: "session_meta", payload: { id: "x1", cwd: "/w", git: { branch: "b", repository_url: "git@github.com:a/b.git" } } }, st),
      ...codexAdapter.parse({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text: "<system_instruction>You are working inside Conductor</system_instruction>" }] } } }, st),
      ...codexAdapter.parse({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "UserMessage", content: [{ type: "text", text: "make light mode default" }] } } }, st),
      ...codexAdapter.parse({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", turn_id: "t1", item: { type: "CommandExecution", command: '["/bin/zsh","-lc","npm test"]', exit_code: "1" } } }, st),
    ];
    expect(ops.map((o) => o.kind)).toEqual(["session", "session", "turn", "tool"]);
    expect((ops[1] as any).harness).toBe("conductor");
    expect((ops[3] as any).line).toBe("$ npm test → exit 1");
    const g: any = { idx: 0 };
    codexAdapter.parse({ timestamp: ts, type: "session_meta", payload: { id: "g", cwd: "/w", source: { subagent: { other: "guardian" } } } }, g);
    expect(g.skip).toBe(true);
  });
});

describe("facts reducer", () => {
  beforeAll(() => openDb());
  test("add, supersede, retract, rebuild is deterministic", () => {
    const a = newFactId();
    emit([{ op: "add", fact: a, project: "p1", type: "decision", text: "Use Postgres for storage", origin: "user", confidence: 0.9 }]);
    const b = newFactId();
    emit([{ op: "supersede", fact: b, target: a, project: "p1", type: "decision", text: "Use SQLite instead of Postgres", why: "single user", origin: "user", confidence: 0.9 }]);
    expect(getFact(a)?.status).toBe("superseded");
    expect(activeFacts("p1").map((f) => f.id)).toEqual([b]);
    emit([{ op: "retract", fact: b, project: "p1" }]);
    expect(activeFacts("p1")).toHaveLength(0);
    rebuildFacts();
    expect(getFact(a)?.status).toBe("superseded");
    expect(getFact(b)?.status).toBe("retracted");
  });
});

describe("search", () => {
  test("OR semantics + facts found; stopwords dropped", () => {
    expect(queryTerms("why did we not use the redis cache?")).toEqual(["redis", "cache"]);
    emit([{ op: "add", fact: newFactId(), project: "p2", type: "rejected", text: "Redis cache for sessions", why: "overkill for v1", origin: "user", confidence: 1 }]);
    const hits = search("should we add a redis cache layer", { project: "p2" });
    expect(hits[0]?.kind).toBe("fact");
    expect(confident(hits[0], false, queryTerms("should we add a redis cache layer").length)).toBe(true);
    expect(search("totally unrelated words here", { project: "p2" })).toHaveLength(0);
  });
  test("best window picks the matching region", () => {
    const text = "intro ".repeat(200) + "the redis cache decision was rejected" + " outro".repeat(200);
    expect(bestWindow(text, ["redis", "cache"], 120)).toContain("redis cache");
  });
});

describe("brief", () => {
  test("mixed-topic projects list preferences only, unless full", () => {
    emit([
      { op: "add", fact: newFactId(), project: "mix", type: "decision", text: "Ship the wallet sweep script", origin: "user", confidence: 1 },
      { op: "add", fact: newFactId(), project: "mix", type: "preference", text: "Answer with short checklists", origin: "user", confidence: 1 },
    ]);
    const p = { id: "mix", slug: "mix" };
    expect(renderBrief(p)).toContain("wallet sweep");
    loadConfig().mixedProjects = ["mix"];
    const brief = renderBrief(p);
    expect(brief).toContain("short checklists");
    expect(brief).not.toContain("wallet sweep");
    expect(renderBrief(p, { full: true })).toContain("wallet sweep");
    loadConfig().mixedProjects = [];
  });
});
