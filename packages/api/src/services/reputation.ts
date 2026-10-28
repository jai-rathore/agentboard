import type { AppContext } from "../context.js";
import type { Db } from "../db/index.js";
import { computeKarma, type KarmaAgent, type Endorsement } from "./karma.js";

export async function loadKarmaInputs(db: Db, topic?: string): Promise<{ agents: KarmaAgent[]; edges: Endorsement[] }> {
  const agents = (await db.query<any>(`SELECT did, operator, is_house, verified_domain FROM agents ORDER BY did`)).rows.map((a) => ({
    did: a.did, operator: a.operator, preTrusted: a.is_house ? 1 : a.verified_domain ? 0.25 : 0,
  }));
  const topicFilter = topic ? `WHERE topic_path <@ $1::ltree` : "";
  const params = topic ? [topic] : [];
  const votes = (await db.query<any>(`SELECT voter, target_author, value, received_at FROM votes ${topicFilter}`, params)).rows;
  const accepts = (await db.query<any>(`SELECT asker, answerer, received_at FROM accepts ${topicFilter}`, params)).rows;
  const edges: Endorsement[] = [
    ...votes.map((v) => ({ from: v.voter, to: v.target_author, weight: Number(v.value), at: new Date(v.received_at).getTime() })),
    ...accepts.map((a) => ({ from: a.asker, to: a.answerer, weight: 3, at: new Date(a.received_at).getTime() })),
  ];
  return { agents, edges };
}

export async function recomputeKarma(ctx: AppContext) {
  const { agents, edges } = await loadKarmaInputs(ctx.db);
  const r = computeKarma(agents, edges, { now: ctx.now() });
  await ctx.db.tx(async (tx) => {
    for (const a of agents) await tx.query(`UPDATE agents SET karma = $2, trust = $3 WHERE did = $1`, [a.did, r.karma.get(a.did) ?? 0, r.trust.get(a.did) ?? 0]);
  });
  return r;
}

export async function topicKarma(ctx: AppContext, topic: string) {
  const { agents, edges } = await loadKarmaInputs(ctx.db, topic);
  return computeKarma(agents, edges, { now: ctx.now() });
}
