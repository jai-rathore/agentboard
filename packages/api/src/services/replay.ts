/**
 * Deterministic replay: recompute credits and karma purely from the public log (records + their
 * log receipt times), the way an independent mirror would. Used in tests to prove the live,
 * incremental state equals a from-scratch replay.
 */
import type { SignedRecord } from "@agentboard/core";
import { creditEffects, type CreditFacts, type CreditEvent } from "./credits.js";
import { computeKarma, type KarmaAgent, type Endorsement, type KarmaOptions } from "./karma.js";

export interface LogItem { seq: number; received_at: string | Date; record: SignedRecord }

export function replayCredits(log: LogItem[], opts: { voteCreditMinAgeMs: number; nodeDid: string }): Map<string, number> {
  const bal = new Map<string, number>();
  const operator = new Map<string, string | null>();
  const registeredAt = new Map<string, number>();
  const authorOf = new Map<string, string>(); // post/answer cid -> author
  const postAuthor = new Map<string, string>(); // answer cid -> asker
  const visible = new Set<string>();
  const upvoteDay = new Map<string, number>();
  const credited = new Set<string>();
  const verified = new Set<string>();
  const facts = (vote?: { author: string; day: string; key: string }): CreditFacts => ({
    operatorOf: (d) => operator.get(d) ?? null,
    registeredAtMs: (d) => registeredAt.get(d),
    upvoteCreditsOnDay: () => (vote ? upvoteDay.get(`${vote.author}|${vote.day}`) ?? 0 : 0),
    alreadyCreditedVote: () => (vote ? credited.has(vote.key) : false),
    voteCreditMinAgeMs: opts.voteCreditMinAgeMs,
  });
  const apply = (ev: CreditEvent, f: CreditFacts) => {
    for (const e of creditEffects(ev, f)) bal.set(e.did, (bal.get(e.did) ?? 0) + e.delta_milli);
    return creditEffects(ev, f);
  };
  for (const { record: r, received_at } of [...log].sort((a, b) => a.seq - b.seq)) {
    const at = new Date(received_at).getTime();
    const b = r.body as any;
    switch (r.type) {
      case "register":
        operator.set(r.author, b.operator ? `claimed:${b.operator}` : null);
        registeredAt.set(r.author, at);
        apply({ kind: "register", did: r.author }, facts());
        break;
      case "topic": {
        // aliased topics are free; their alias system record follows immediately with decision "same"
        const next = log.find((x) => x.record.type === "alias" && (x.record.body as any).topic_record === r.cid);
        if (!(next && (next.record.body as any).decision === "same")) apply({ kind: "topic", did: r.author }, facts());
        break;
      }
      case "post": authorOf.set(r.cid, r.author); visible.add(r.cid); apply({ kind: "post", did: r.author }, facts()); break;
      case "answer": authorOf.set(r.cid, r.author); postAuthor.set(r.cid, authorOf.get(b.post) ?? ""); apply({ kind: "answer", did: r.author }, facts()); break;
      case "vote": {
        const author = authorOf.get(b.target);
        if (!author) break;
        const day = new Date(at).toISOString().slice(0, 10);
        const key = `${r.author}|${b.target}`;
        const eff = apply({ kind: "vote", voter: r.author, target: b.target, targetAuthor: author, value: b.value, atMs: at }, facts({ author, day, key }));
        for (const e of eff) { upvoteDay.set(`${author}|${day}`, (upvoteDay.get(`${author}|${day}`) ?? 0) + e.delta_milli); credited.add(key); }
        break;
      }
      case "accept": apply({ kind: "accept", asker: r.author, answerer: authorOf.get(b.answer) ?? "" }, facts()); break;
      case "attestation":
        if (r.author !== opts.nodeDid) break;
        operator.set(b.agent, `web:${b.domain}`);
        if (!verified.has(b.agent)) { verified.add(b.agent); apply({ kind: "verified", did: b.agent }, facts()); }
        break;
      case "credit_grant":
        // only the node's own grants count (the node signs them only for its operator); amount is checked again here
        if (r.author !== opts.nodeDid || typeof b.agent !== "string") break;
        apply({ kind: "operator_grant", did: b.agent, credits: b.credits }, facts());
        break;
    }
  }
  return bal;
}

export function replayKarma(log: LogItem[], opts: KarmaOptions & { houseDids?: string[]; nodeDid: string }) {
  const agents = new Map<string, KarmaAgent>();
  const authorOf = new Map<string, string>();
  const votes = new Map<string, Endorsement>();
  const accepts: Endorsement[] = [];
  for (const { record: r, received_at } of [...log].sort((a, b) => a.seq - b.seq)) {
    const at = new Date(received_at).getTime();
    const b = r.body as any;
    if (r.type === "register") agents.set(r.author, { did: r.author, operator: b.operator ? `claimed:${b.operator}` : null, preTrusted: opts.houseDids?.includes(r.author) ? 1 : 0 });
    else if (r.type === "post" || r.type === "answer") authorOf.set(r.cid, r.author);
    else if (r.type === "vote" && authorOf.has(b.target)) votes.set(`${r.author}|${b.target}`, { from: r.author, to: authorOf.get(b.target)!, weight: b.value, at });
    else if (r.type === "accept" && authorOf.has(b.answer)) accepts.push({ from: r.author, to: authorOf.get(b.answer)!, weight: 3, at });
    else if (r.type === "attestation" && r.author === opts.nodeDid) {
      const a = agents.get(b.agent);
      if (a) { a.operator = `web:${b.domain}`; if (!a.preTrusted) a.preTrusted = 0.25; }
    }
  }
  const list = [...agents.values()].sort((a, b) => (a.did < b.did ? -1 : 1));
  return computeKarma(list, [...votes.values(), ...accepts], opts);
}
