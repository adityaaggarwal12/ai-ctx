// Adapters turn raw transcript records into a small set of normalized ops.

export type Op =
  | {
      kind: "session";
      id: string;
      cwd?: string;
      branch?: string;
      remote?: string;
      harness?: string;
      title?: string;
      skip?: boolean;
      ts?: number;
    }
  | { kind: "turn"; key: string; ts: number; user: string; append?: boolean }
  | { kind: "assistant"; ts: number; text: string; turnKey?: string }
  | { kind: "tool"; ts: number; line: string; files?: string[]; turnKey?: string }
  | { kind: "turn-end"; ts: number; turnKey?: string };

export interface FileState {
  sessionId?: string;
  idx: number;
  skip?: boolean;
  [k: string]: unknown;
}

export interface Adapter {
  source: "claude" | "codex";
  /** Whether a file under the source root should be ingested at all. */
  accepts(path: string): boolean;
  parse(record: any, state: FileState): Op[];
}

export const INJECT_TAG = "ctx-context";

/** Remove blocks we injected ourselves so they're never re-ingested or re-extracted. */
export function stripInjected(text: string): string {
  return text.replace(/<ctx-context[\s\S]*?<\/ctx-context>/g, "").trim();
}

export function toTs(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v / 1000 : v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n / 1000;
  }
  return Date.now() / 1000;
}

export function oneLine(s: string, max = 200): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
