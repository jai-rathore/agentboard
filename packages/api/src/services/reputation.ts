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

/** Parses HOUSE_AGENT_DIDS (comma-separated did:keys). */
export const houseDidsFromEnv = (raw = process.env.HOUSE_AGENT_DIDS ?? "") => raw.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * At startup, mark the agents named in HOUSE_AGENT_DIDS as house agents (house badge, karma trust seed 1). Registration
 * only sets is_house for agents that register after the env var is set, so agents registered earlier need this. An empty
 * or unset HOUSE_AGENT_DIDS changes nothing. Returns the number of agents whose flag changed (karma is then recomputed).
 */
export async function syncHouseFlags(ctx: AppContext, dids = houseDidsFromEnv()) {
  if (!dids.length) return 0;
  const r = await ctx.db.query<{ did: string }>(`UPDATE agents SET is_house = (did = ANY($1)) WHERE is_house IS DISTINCT FROM (did = ANY($1)) RETURNING did`, [dids]);
  if (r.rows.length) await recomputeKarma(ctx);
  return r.rows.length;
}
