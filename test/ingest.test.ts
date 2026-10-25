import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "ctx-ingest-"));
process.env.CTX_HOME = join(home, ".ctx");
const claudeRoot = join(home, "claude");
mkdirSync(join(claudeRoot, "proj"), { recursive: true });
mkdirSync(process.env.CTX_HOME, { recursive: true });
writeFileSync(join(process.env.CTX_HOME, "config.json"), JSON.stringify({ sources: { claude: [claudeRoot], codex: [join(home, "codex")] }, ignoreCwd: [] }));

const { scanAll, ingestFile, adapterFor, compactArchive } = await import("../src/ingest");
const { openDb } = await import("../src/db");
const { redact } = await import("../src/redact");

const cwd = join(home, "work");
mkdirSync(cwd, { recursive: true });
const rec = (o: any) => JSON.stringify({ sessionId: "s1", cwd, gitBranch: "main", timestamp: "2026-10-24T10:00:00Z", ...o }) + "\n";
const user = (uuid: string, text: string) => rec({ type: "user", uuid, message: { content: text } });
const asst = (text: string, stop = "end_turn") => rec({ type: "assistant", message: { stop_reason: stop, content: [{ type: "text", text }] } });
const file = join(claudeRoot, "proj", "s1.jsonl");
const turns = () => openDb().query("SELECT id, user, assistant, complete FROM turns ORDER BY idx").all() as any[];

describe("ingest", () => {
  test("partial trailing line is not consumed; second read completes it", () => {
    writeFileSync(file, user("u1", "use sqlite for storage") + asst("ok, sqlite").slice(0, 20));
    scanAll();
    expect(turns()).toHaveLength(1);
    expect(turns()[0].assistant).toBe("");
    appendFileSync(file, asst("ok, sqlite").slice(20));
    ingestFile(file, adapterFor(file)!);
    expect(turns()[0].assistant).toBe("ok, sqlite");
    expect(turns()[0].complete).toBe(1); // end_turn closes the turn
  });

  test("a malformed record does not stop ingestion of later records or files", () => {
    appendFileSync(file, rec({ type: "assistant", message: { content: [{ type: "text", text: { weird: true } }] } }));
    appendFileSync(file, "{not json\n");
    appendFileSync(file, user("u2", "second prompt here"));
    const other = join(claudeRoot, "proj", "s2.jsonl");
    writeFileSync(other, JSON.stringify({ sessionId: "s2", cwd, gitBranch: "main", type: "user", uuid: "v1", timestamp: "2026-10-24T11:00:00Z", message: { content: "other session prompt" } }) + "\n");
    scanAll();
    const all = turns().map((t) => t.user);
    expect(all).toContain("second prompt here");
    expect(all).toContain("other session prompt");
  });

  test("re-reading the same bytes never duplicates assistant text", () => {
    ingestFile(file, adapterFor(file)!);
    scanAll();
    expect(turns()[0].assistant).toBe("ok, sqlite");
  });

  test("rewritten file (new inode) keeps extraction flags of unchanged turns", () => {
    openDb().query("UPDATE turns SET extracted = 1, extracted_len = length(user) + length(assistant) WHERE id LIKE 'c:s1:%'").run();
    const copy = file + ".tmp";
    copyFileSync(file, copy);
    renameSync(copy, file);
    scanAll();
    const rows = openDb().query("SELECT extracted FROM turns WHERE session_id = 's1'").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.extracted === 1)).toBe(true);
    expect(turns().filter((t) => t.user === "use sqlite for storage")[0].assistant).toBe("ok, sqlite");
  });

  test("interrupt markers don't become turns; a mid-session cd doesn't move the session", () => {
    appendFileSync(file, user("u3", "[Request interrupted by user for tool use]"));
    appendFileSync(file, JSON.stringify({ sessionId: "s1", cwd: join(home, ".ctx", "x"), gitBranch: "other", type: "user", uuid: "u4", timestamp: "2026-10-24T12:00:00Z", message: { content: "prompt after cd" } }) + "\n");
    scanAll();
    const all = turns().map((t) => t.user);
    expect(all.some((u) => u.startsWith("[Request interrupted"))).toBe(false);
    expect(all).toContain("prompt after cd");
    const s = openDb().query("SELECT cwd, skip, branch FROM sessions WHERE id = 's1'").get() as any;
    expect(s.cwd).toBe(cwd);
    expect(s.skip).toBe(0);
  });

  test("secrets are redacted before storage", () => {
    appendFileSync(file, user("u5", "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123"));
    scanAll();
    const stored = JSON.stringify(turns());
    expect(stored).not.toContain("sk-ant-api03");
    expect(redact("const authHeader = req.headers.authorization")).toBe("const authHeader = req.headers.authorization");
    expect(redact("DB_PASS=hunter22x")).toBe("DB_PASS=[REDACTED:kv]");
  });
});

describe("archive", () => {
  test("compaction keeps the latest copy of each turn and nothing else changes", () => {
    const dir = join(home, "arch", "claude");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "s9.jsonl");
    writeFileSync(f, [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "a", v: 2 }].map((x) => JSON.stringify(x)).join("\n") + "\nnot json\n");
    expect(compactArchive(join(home, "arch"))).toEqual({ files: 1, dropped: 1 });
    expect(readFileSync(f, "utf8")).toBe('{"id":"b","v":1}\n{"id":"a","v":2}\nnot json\n');
    expect(compactArchive(join(home, "arch"))).toEqual({ files: 0, dropped: 0 });
  });
});
