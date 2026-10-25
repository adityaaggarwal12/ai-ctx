import { redact } from "../redact";
import { type Adapter, type FileState, type Op, oneLine, stripInjected, toTs } from "./types";

const INTERRUPT = /^\[Request interrupted by user/;
const HELPER_PROMPT = /^(Name this chat from the user's first request|Generate a (short )?title for)/;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function cleanPrompt(text: string): string {
  let t = stripInjected(text);
  // Slash commands: keep "/name args", drop the wrapper tags.
  const name = t.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  if (name) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "";
    return `${name.startsWith("/") ? name : "/" + name} ${args}`.trim();
  }
  if (/^<(local-command-stdout|local-command-caveat|task-notification|system-reminder)/.test(t)) return "";
  t = t.replace(/<(system-reminder|system_instruction)>[\s\S]*?<\/\1>/g, "");
  return t.trim();
}

function toolLine(block: any): { line: string; files?: string[] } | undefined {
  const name: string = block.name ?? "tool";
  const input = block.input ?? {};
  if (name === "Bash") return { line: `$ ${oneLine(redact(String(input.command ?? "")), 220)}` };
  if (EDIT_TOOLS.has(name)) {
    const file = input.file_path ?? input.notebook_path;
    return file ? { line: `edit ${file}`, files: [String(file)] } : undefined;
  }
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") return undefined; // navigation noise
  if (name === "WebFetch" || name === "WebSearch") return { line: `${name} ${oneLine(String(input.url ?? input.query ?? ""), 160)}` };
  if (name === "Agent" || name === "Task") return { line: `agent: ${oneLine(String(input.description ?? input.prompt ?? ""), 160)}` };
  if (name.startsWith("mcp__")) return { line: `mcp ${name.slice(5)}` };
  return { line: name };
}

export const claudeAdapter: Adapter = {
  source: "claude",
  accepts(path) {
    return path.endsWith(".jsonl") && !path.includes("/subagents/");
  },
  parse(rec: any, state: FileState): Op[] {
    const ops: Op[] = [];
    if (!rec || typeof rec !== "object") return ops;
    if (rec.type === "ai-title" && rec.aiTitle && state.sessionId) {
      ops.push({ kind: "session", id: state.sessionId, title: String(rec.aiTitle) });
      return ops;
    }
    if (rec.type !== "user" && rec.type !== "assistant") return ops;
    if (rec.isSidechain) return ops;
    const ts = toTs(rec.timestamp);

    if (rec.sessionId && (rec.sessionId !== state.sessionId || rec.cwd !== state.cwd || rec.gitBranch !== state.branch)) {
      state.sessionId = rec.sessionId;
      state.cwd = rec.cwd;
      state.branch = rec.gitBranch;
      ops.push({ kind: "session", id: rec.sessionId, cwd: rec.cwd, branch: rec.gitBranch, ts });
    }

    const content = rec.message?.content;
    if (rec.type === "user") {
      if (rec.isMeta || rec.isCompactSummary || rec.turnOrigin === "task_notification" || rec.promptSource === "system") return ops;
      if (typeof content === "string") {
        const user = cleanPrompt(content);
        if (state.idx === 0 && HELPER_PROMPT.test(user)) {
          // Harness helper calls (e.g. Orca's chat titler) aren't real work sessions.
          state.skip = true;
          if (state.sessionId) ops.push({ kind: "session", id: state.sessionId, skip: true });
          return ops;
        }
        if (user && !INTERRUPT.test(user)) ops.push({ kind: "turn", key: rec.uuid ?? `${ts}`, ts, user });
        return ops;
      }
      if (Array.isArray(content)) {
        const results = content.filter((b: any) => b?.type === "tool_result");
        for (const r of results) {
          if (r.is_error) {
            const txt = typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join(" ") : "";
            ops.push({ kind: "tool", ts, line: `error: ${oneLine(redact(txt), 200)}` });
          }
        }
        if (results.length === 0) {
          const user = cleanPrompt(content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n"));
          if (user && !INTERRUPT.test(user)) ops.push({ kind: "turn", key: rec.uuid ?? `${ts}`, ts, user });
        }
      }
      return ops;
    }

    // assistant
    if (!Array.isArray(content)) return ops;
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) ops.push({ kind: "assistant", ts, text: stripInjected(b.text) });
      else if (b?.type === "tool_use") {
        const t = toolLine(b);
        if (t) ops.push({ kind: "tool", ts, line: t.line, files: t.files });
      }
    }
    const stop = rec.message?.stop_reason;
    if (stop === "end_turn" || stop === "stop_sequence") ops.push({ kind: "turn-end", ts });
    return ops;
  },
};
