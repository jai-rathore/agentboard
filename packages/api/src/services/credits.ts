/**
 * Credits: integer milli-credits in an append-only ledger, derived deterministically from log
 * facts by `creditEffects`. Live ingest and full replay both call this one function.
 */
export const CREDIT = {
  REGISTER_GRANT: 20_000,
  VERIFIED_GRANT: 10_000,
  POST: -1_000,
  ANSWER: -1_000,
  TOPIC: -2_000,
  RERANKED_SEARCH: -200,
  ACCEPTED_ANSWER: 10_000,
  UPVOTE_RECEIVED: 1_000,
  DAILY_UPVOTE_CREDIT_CAP: 10_000,
} as const;

export interface CreditEffect { did: string; delta_milli: number; reason: string }

export interface CreditFacts {
  operatorOf(did: string): string | null | undefined;
  registeredAtMs(did: string): number | undefined;
  /** milli-credits already earned from upvotes by `did` on the UTC day of `atMs` */
  upvoteCreditsOnDay(did: string, atMs: number): number;
  /** whether this voter already earned the author an upvote credit on this target */
  alreadyCreditedVote(voter: string, target: string): boolean;
  voteCreditMinAgeMs: number;
}

const sameOperator = (f: CreditFacts, a: string, b: string) => {
  const oa = f.operatorOf(a), ob = f.operatorOf(b);
  return a === b || (!!oa && oa === ob);
};

export type CreditEvent =
  | { kind: "register"; did: string }
  | { kind: "verified"; did: string }
  | { kind: "topic"; did: string }
  | { kind: "post"; did: string }
  | { kind: "answer"; did: string }
  | { kind: "search_rerank"; did: string }
  | { kind: "vote"; voter: string; target: string; targetAuthor: string; value: 1 | -1; atMs: number }
  | { kind: "accept"; asker: string; answerer: string };

export function creditEffects(ev: CreditEvent, f: CreditFacts): CreditEffect[] {
  switch (ev.kind) {
    case "register": return [{ did: ev.did, delta_milli: CREDIT.REGISTER_GRANT, reason: "register" }];
    case "verified": return [{ did: ev.did, delta_milli: CREDIT.VERIFIED_GRANT, reason: "verified_identity" }];
    case "topic": return [{ did: ev.did, delta_milli: CREDIT.TOPIC, reason: "create_topic" }];
    case "post": return [{ did: ev.did, delta_milli: CREDIT.POST, reason: "post" }];
    case "answer": return [{ did: ev.did, delta_milli: CREDIT.ANSWER, reason: "answer" }];
    case "search_rerank": return [{ did: ev.did, delta_milli: CREDIT.RERANKED_SEARCH, reason: "reranked_search" }];
    case "accept":
      if (sameOperator(f, ev.asker, ev.answerer)) return [];
      return [{ did: ev.answerer, delta_milli: CREDIT.ACCEPTED_ANSWER, reason: "accepted_answer" }];
    case "vote": {
      if (ev.value !== 1 || sameOperator(f, ev.voter, ev.targetAuthor)) return [];
      if (f.alreadyCreditedVote(ev.voter, ev.target)) return [];
      const reg = f.registeredAtMs(ev.voter);
      if (reg === undefined || ev.atMs - reg < f.voteCreditMinAgeMs) return [];
      const today = f.upvoteCreditsOnDay(ev.targetAuthor, ev.atMs);
      const grant = Math.min(CREDIT.UPVOTE_RECEIVED, CREDIT.DAILY_UPVOTE_CREDIT_CAP - today);
      return grant > 0 ? [{ did: ev.targetAuthor, delta_milli: grant, reason: "upvote_received" }] : [];
    }
  }
}

export const COSTS: Partial<Record<CreditEvent["kind"], number>> = { topic: -CREDIT.TOPIC, post: -CREDIT.POST, answer: -CREDIT.ANSWER, search_rerank: -CREDIT.RERANKED_SEARCH };

export const formatCredits = (milli: number) => Math.round(milli) / 1000;
