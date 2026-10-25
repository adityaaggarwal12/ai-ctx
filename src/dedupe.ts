// Near-duplicate facts: the extractor only sees ~40 existing facts, so on large projects it
// re-adds reworded copies. Same type + word overlap (Jaccard) >= DUP_SIM counts as the same fact.
// Calibrated on real memory: rewordings scored 0.45–0.66, distinct facts on one topic <= 0.38.

import type { Fact, FactType } from "./facts";

export const DUP_SIM = 0.45;

export function factWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu) ?? []).filter((t) => t.length > 2));
}

export function similarity(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  const union = a.size + b.size - n;
  return union ? n / union : 0;
}

/** The existing fact of the same type that `text` restates, if any. */
export function findDuplicate(text: string, type: FactType, facts: Fact[]): Fact | undefined {
  const words = factWords(text);
  let best: Fact | undefined;
  let bestSim = DUP_SIM;
  for (const f of facts) {
    if (f.type !== type) continue;
    const sim = similarity(words, factWords(f.text));
    if (sim >= bestSim) (best = f), (bestSim = sim);
  }
  return best;
}

const ORIGIN_RANK = { agent: 0, agreed: 1, user: 2, manual: 3 } as const;

/** The more trustworthy of two origins (a restatement shouldn't downgrade a user-stated fact). */
export function strongerOrigin<O extends keyof typeof ORIGIN_RANK>(a: O, b: O): O {
  return ORIGIN_RANK[a] >= ORIGIN_RANK[b] ? a : b;
}

/** Duplicate clusters among existing facts: each older copy paired with the newest one to keep. */
export function duplicatePairs(facts: Fact[]): { keep: Fact; drop: Fact }[] {
  const byNewest = [...facts].sort((a, b) => b.created - a.created);
  const words = new Map(byNewest.map((f) => [f.id, factWords(f.text)]));
  const dropped = new Set<string>();
  const out: { keep: Fact; drop: Fact }[] = [];
  for (const keep of byNewest) {
    if (dropped.has(keep.id)) continue;
    for (const other of byNewest) {
      if (other === keep || other.created > keep.created || dropped.has(other.id) || other.type !== keep.type || other.project !== keep.project) continue;
      if (similarity(words.get(keep.id)!, words.get(other.id)!) >= DUP_SIM) {
        dropped.add(other.id);
        out.push({ keep, drop: other });
      }
    }
  }
  return out;
}
