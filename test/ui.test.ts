import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CTX_HOME = mkdtempSync(join(tmpdir(), "ctx-ui-"));

const { handleUi, uiToken } = await import("../src/ui-server");
const { emit, getFact, newFactId, rebuildFacts } = await import("../src/facts");
const { openDb } = await import("../src/db");
const { reviewItems } = await import("../src/views");

const PORT = 7770;
const BASE = `http://127.0.0.1:${PORT}`;
const info = () => ({ pid: 1, uptime: 1, embedReady: false });
const token = uiToken();

function req(path: string, opts: { host?: string; cookie?: string | null; origin?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${PORT}` };
  if (opts.cookie !== null) headers.cookie = `ctx_ui=${opts.cookie ?? token}`;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    if (opts.origin !== null) headers.origin = opts.origin ?? BASE;
  }
  return handleUi(new Request(BASE + path, { method: opts.body === undefined ? "GET" : "POST", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), PORT, info);
}

describe("ui access control", () => {
  test("foreign Host is refused (DNS rebinding)", async () => {
    expect((await req("/", { host: "evil.example:7770" })).status).toBe(403);
    expect((await req("/api/projects", { host: "evil.example:7770" })).status).toBe(403);
  });
  test("API needs the token cookie", async () => {
    expect((await req("/api/projects", { cookie: null })).status).toBe(401);
    expect((await req("/api/projects", { cookie: "nope" })).status).toBe(401);
    expect((await req("/api/projects")).status).toBe(200);
  });
  test("link token becomes an HttpOnly SameSite=Strict cookie; a wrong token is refused", async () => {
    expect((await req("/?t=wrong", { cookie: null })).status).toBe(403);
    const ok = await req(`/?t=${token}`, { cookie: null });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/");
    expect(ok.headers.get("set-cookie")).toContain("HttpOnly");
    expect(ok.headers.get("set-cookie")).toContain("SameSite=Strict");
  });
  test("writes need a matching Origin", async () => {
    const body = { ids: ["fnone00"], action: "done" };
    expect((await req("/api/facts/action", { body, origin: null })).status).toBe(403);
    expect((await req("/api/facts/action", { body, origin: "https://evil.example" })).status).toBe(403);
    expect((await req("/api/facts/action", { body })).status).toBe(200);
  });
  test("page is served with a strict CSP", async () => {
    const r = await req("/", { cookie: null });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await r.text()).toContain("/app.js");
  });
});

describe("ui data and actions", () => {
  test("review endpoint matches the CLI's review list", async () => {
    const id = newFactId();
    emit([{ op: "add", fact: id, project: "uiproj", type: "todo", text: "Rotate the staging key", origin: "user", confidence: 1 }]);
    openDb().query("UPDATE facts SET updated = updated - 40 * 86400 WHERE id = ?").run(id);
    const data = (await (await req("/api/facts?view=review&project=uiproj")).json()) as any;
    expect(data.facts.map((f: any) => f.id)).toEqual(reviewItems("uiproj").map((f) => f.id));
    expect(data.facts.map((f: any) => f.id)).toContain(id);
  });
  test("actions are normal events: they survive a rebuild", async () => {
    const id = newFactId();
    emit([{ op: "add", fact: id, project: "uiproj", type: "todo", text: "Write the launch post", origin: "user", confidence: 1 }]);
    const r = (await (await req("/api/facts/action", { body: { ids: [id], action: "done" } })).json()) as any;
    expect(r.ok).toEqual([id]);
    rebuildFacts();
    expect(getFact(id)?.status).toBe("done");
  });
  test("notes need a known project and valid type", async () => {
    expect((await req("/api/note", { body: { project: "nope", type: "decision", text: "x" } })).status).toBe(400);
  });
});
