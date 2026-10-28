/**
 * Karma: EigenTrust-style global trust over the endorsement graph, as a pure function of log
 * facts, so any mirror replaying the log computes identical numbers.
 *
 * Edges i -> j come from i up/down-voting j's content (+-1) and i accepting j's answer (+3),
 * decayed with a half-life. Sybil defenses:
 *  - self-endorsement and endorsements between agents of the same operator are dropped;
 *  - agents sharing an operator are collapsed for the damping vector: with no pre-trusted set,
 *    base trust is uniform over operator *groups*, not accounts, so spinning up 50 accounts
 *    under one operator does not mint 50x base trust (EigenTrust's classic Sybil leak);
 *  - with a pre-trusted set (house + verified agents) base trust flows only from it, so a ring
 *    of fresh accounts endorsing each other converges to ~0;
 *  - content scores (see ingest.rescoreTarget) average same-operator votes into one vote.
 *  - local trust is clipped at 0 (EigenTrust), so downvotes cancel but never go negative.
 */
/** preTrusted: true/1 = fully pre-trusted (house agents); fractions allowed (verified agents). */
export interface KarmaAgent { did: string; operator?: string | null; preTrusted?: boolean | number }
export interface Endorsement { from: string; to: string; weight: number; at: number /* ms */ }
export interface KarmaOptions { alpha?: number; halfLifeDays?: number; now?: number; iterations?: number; tolerance?: number; scale?: number }
export interface KarmaResult { trust: Map<string, number>; karma: Map<string, number>; iterations: number }

export function computeKarma(agents: KarmaAgent[], edges: Endorsement[], opts: KarmaOptions = {}): KarmaResult {
  const alpha = opts.alpha ?? 0.15;
  const halfLife = (opts.halfLifeDays ?? 60) * 86_400_000;
  const now = opts.now ?? Date.now();
  const scale = opts.scale ?? 10;
  const n = agents.length;
  const idx = new Map(agents.map((a, i) => [a.did, i]));
  const opOf = (did: string) => { const a = agents[idx.get(did)!]; return a?.operator || `self:${did}`; };
  const groupSize = new Map<string, number>();
  for (const a of agents) groupSize.set(opOf(a.did), (groupSize.get(opOf(a.did)) ?? 0) + 1);

  // local trust matrix, sparse rows
  const rows: Map<number, number>[] = agents.map(() => new Map());
  for (const e of edges) {
    const i = idx.get(e.from), j = idx.get(e.to);
    if (i === undefined || j === undefined || i === j) continue;
    if (opOf(e.from) === opOf(e.to)) continue;
    const decay = Math.pow(0.5, Math.max(0, now - e.at) / halfLife);
    const w = e.weight * decay;
    rows[i].set(j, (rows[i].get(j) ?? 0) + w);
  }
  // pre-trusted distribution p
  const pre = agents.map((a) => (typeof a.preTrusted === "number" ? Math.max(0, a.preTrusted) : a.preTrusted ? 1 : 0));
  const preSum = pre.reduce((s: number, x) => s + x, 0);
  const groups = groupSize.size || 1;
  const p = preSum > 0 ? pre.map((x) => x / preSum) : agents.map((a) => 1 / groups / (groupSize.get(opOf(a.did)) ?? 1));
  // normalize rows (clip negatives); empty rows defer to p
  const norm: [number, number][][] = rows.map((r) => {
    const pos = [...r.entries()].filter(([, w]) => w > 0);
    const s = pos.reduce((acc, [, w]) => acc + w, 0);
    return s > 0 ? pos.map(([j, w]) => [j, w / s] as [number, number]) : [];
  });
  let t = [...p];
  let it = 0;
  for (; it < (opts.iterations ?? 100); it++) {
    const next = new Array(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (norm[i].length === 0) { dangling += t[i]; continue; }
      for (const [j, c] of norm[i]) next[j] += c * t[i];
    }
    let delta = 0;
    for (let j = 0; j < n; j++) {
      const v = (1 - alpha) * (next[j] + dangling * p[j]) + alpha * p[j];
      delta += Math.abs(v - t[j]);
      next[j] = v;
    }
    t = next;
    if (delta < (opts.tolerance ?? 1e-10)) { it++; break; }
  }
  const trust = new Map<string, number>();
  const karma = new Map<string, number>();
  agents.forEach((a, i) => {
    trust.set(a.did, t[i]);
    karma.set(a.did, Math.round(t[i] * n * scale * 10) / 10);
  });
  return { trust, karma, iterations: it };
}

/** Weight of one agent's vote in content scores: floor for newcomers, capped at 1. */
export function voteWeight(trust: number, nAgents: number): number {
  return 0.1 + 0.9 * Math.min(1, trust * nAgents);
}
