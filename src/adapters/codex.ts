import { redact } from "../redact";
import { type Adapter, type FileState, type Op, oneLine, stripInjected, toTs } from "./types";

const WRAPPERS = /<(environment_context|system_instruction|user_instructions|permissions instructions|collaboration_mode|turn_aborted)>[\s\S]*?<\/\1>/g;

function cleanUser(text: string): string {
  let t = stripInjected(text);
  const delegated = t.match(/<realtime_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>/);
  if (delegated) {
    if (/<source>transcript_tail_flush<\/source>/.test(t)) return "";
    t = delegated[1];
  }
  t = t.replace(WRAPPERS, "");
  t = t.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>/g, (m) => (m.length > 400 ? "" : m)); // drop large injected blocks
  return t.trim();
}

function texts(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n");
}

function commandOf(raw: any): string {
  if (Array.isArray(raw)) return String(raw[raw.length - 1] ?? "");
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return String(arr[arr.length - 1] ?? "");
    } catch {}
    return raw;
  }
  return "";
}

export const codexAdapter: Adapter = {
  source: "codex",
  accepts(path) {
    return /rollout-.*\.jsonl$/.test(path);
  },
  parse(rec: any, state: FileState): Op[] {
    const ops: Op[] = [];
    const ts = toTs(rec?.timestamp);
    const p = rec?.payload;
    if (!p) return ops;

    if (rec.type === "session_meta") {
      const sub = p.source && typeof p.source === "object" && p.source.subagent;
      state.sessionId = p.id ?? p.session_id;
      state.skip = Boolean(sub);
      let harness: string | undefined;
      if (p.originator === "Codex Desktop") harness = "codex-desktop";
      ops.push({
        kind: "session",
        id: state.sessionId!,
        cwd: p.cwd,
        branch: p.git?.branch,
        remote: p.git?.repository_url,
        harness,
        skip: state.skip,
        ts: toTs(p.timestamp ?? rec.timestamp),
      });
      return ops;
    }
    if (state.skip || !state.sessionId) return ops;
    if (rec.type !== "event_msg") return ops;

    if (p.type === "task_complete") {
      ops.push({ kind: "turn-end", ts, turnKey: p.turn_id });
      return ops;
    }
    if (p.type !== "item_completed" || !p.item) return ops;
    const item = p.item;
    const turnKey: string | undefined = p.turn_id;

    switch (item.type) {
      case "UserMessage": {
        const raw = texts(item.content);
        if (/You are working inside Conductor/.test(raw) && state.harness !== "conductor") {
          state.harness = "conductor";
          ops.push({ kind: "session", id: state.sessionId, harness: "conductor" });
        }
        const user = cleanUser(raw);
        if (user) ops.push({ kind: "turn", key: turnKey ?? `${ts}`, ts, user, append: true });
        break;
      }
      case "AgentMessage": {
        const text = stripInjected(texts(item.content));
        if (text) ops.push({ kind: "assistant", ts, text, turnKey });
        break;
      }
      case "CommandExecution": {
        const cmd = commandOf(item.command);
        const code = item.exit_code;
        ops.push({ kind: "tool", ts, turnKey, line: `$ ${oneLine(redact(cmd), 220)}${code && String(code) !== "0" ? ` → exit ${code}` : ""}` });
        break;
      }
      case "FileChange": {
        const files = String(item.stdout ?? "")
          .split("\n")
          .map((l) => l.match(/^[AMD] (.+)$/)?.[1])
          .filter((f): f is string => Boolean(f));
        if (files.length) ops.push({ kind: "tool", ts, turnKey, line: files.map((f) => `edit ${f}`).join("; "), files });
        break;
      }
      case "McpToolCall":
        ops.push({ kind: "tool", ts, turnKey, line: `mcp ${item.server ?? ""}.${item.tool ?? ""}` });
        break;
    }
    return ops;
  },
};
