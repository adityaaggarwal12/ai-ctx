#!/usr/bin/env bun
// Extraction eval: runs the real extractor prompt over hand-labelled conversations and scores
// what it proposes. Uses your claude login (one Haiku call per case per run, ~$0.004 each).
//   bun run eval [--runs 3] [--case <name substring>] [--verbose]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPrompt, claudeCli, SYSTEM, turnBlock, type LlmResult } from "../src/extract";

interface Expected {
  op?: "add" | "supersede" | "done" | "retract";
  type?: string; // "a|b" = either
  target?: string;
  all?: string[]; // every entry must appear in the text; "a|b" = either
}
interface Case {
  name: string;
  memory?: { id: string; type: string; text: string; why?: string }[];
  turns: { user: string; agent: string }[];
  expect: Expected[];
  allowExtra?: boolean;
  forbid?: string[];
}
type Op = LlmResult["ops"][number];

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runs = Number(arg("runs") ?? 1);
const only = arg("case");
const verbose = argv.includes("--verbose");

const cases = (JSON.parse(readFileSync(join(import.meta.dir, "cases.json"), "utf8")) as Case[]).filter((c) => !only || c.name.includes(only));

const anyOf = (pattern: string, value: string) => pattern.split("|").some((p) => value.toLowerCase().includes(p.toLowerCase()));

function matches(e: Expected, o: Op): boolean {
  const op = o.op === "supersede" && (e.op ?? "add") === "add" ? "add" : o.op; // a supersede still captures the fact
  if ((e.op ?? "add") !== op) return false;
  if (e.target && o.target !== e.target) return false;
  if (e.type && !(o.type && anyOf(e.type, o.type))) return false;
  return (e.all ?? []).every((k) => anyOf(k, `${o.text ?? ""} ${o.why ?? ""}`));
}

function score(c: Case, ops: Op[]) {
  const counted = ops.filter((o) => o.op !== "reaffirm"); // reaffirming known memory is neutral
  const used = new Set<number>();
  let found = 0;
  for (const e of c.expect) {
    const i = counted.findIndex((o, j) => !used.has(j) && matches(e, o));
    if (i >= 0) (used.add(i), found++);
  }
  const extra = c.allowExtra ? 0 : counted.length - used.size;
  const leaked = (c.forbid ?? []).some((f) => counted.some((o) => `${o.text ?? ""} ${o.why ?? ""} ${o.quote ?? ""}`.includes(f)));
  return { found, extra, leaked, pass: found === c.expect.length && extra === 0 && !leaked };
}

async function runCase(c: Case) {
  const ts = Date.now() / 1000;
  const blocks = c.turns.map((t, i) => turnBlock({ ts_start: ts, harness: "eval", branch: "main", user: t.user, assistant: t.agent, tools: "" }, i + 1));
  const prompt = buildPrompt("eval-project", (c.memory ?? []).map((m) => ({ ...m, type: m.type as any, why: m.why ?? null })), blocks);
  const res = await claudeCli(SYSTEM, prompt);
  return { ops: res.ops, cost: res.cost, ...score(c, res.ops) };
}

let expected = 0, found = 0, extra = 0, passed = 0, leaks = 0, cost = 0, total = 0;
for (let r = 0; r < runs; r++) {
  // A few at a time: each case is a separate `claude -p` process.
  const results: Awaited<ReturnType<typeof runCase>>[] = [];
  for (let i = 0; i < cases.length; i += 4) results.push(...(await Promise.all(cases.slice(i, i + 4).map(runCase))));
  results.forEach((res, i) => {
    const c = cases[i];
    total++;
    expected += c.expect.length;
    found += res.found;
    extra += res.extra;
    leaks += res.leaked ? 1 : 0;
    passed += res.pass ? 1 : 0;
    cost += res.cost;
    const why = res.pass ? "" : `  (found ${res.found}/${c.expect.length}, extra ${res.extra}${res.leaked ? ", LEAKED forbidden text" : ""})`;
    console.log(`${res.pass ? "✓" : "✗"} ${c.name}${why}`);
    if (verbose || !res.pass) for (const o of res.ops) console.log(`    ${o.op} ${o.type ?? ""}${o.target ? " →" + o.target : ""}: ${o.text ?? o.why ?? ""}`);
  });
}

console.log(
  `\n${passed}/${total} cases passed · recall ${expected ? ((found / expected) * 100).toFixed(0) : 100}% (${found}/${expected} expected facts) · ` +
    `${extra} unwanted ops · ${leaks} leaks · $${cost.toFixed(3)}`,
);
process.exit(passed === total ? 0 : 1);
