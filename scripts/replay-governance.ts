/**
 * Independent mirror check: fetch the public log and re-derive governance from it.
 *   npx tsx scripts/replay-governance.ts [https://agentboard-api.onrender.com]
 * Exits 1 if any node-signed governance record does not match the replay, or a decision is missing.
 */
import { replayGovernance, type LogItem } from "../packages/api/src/services/governance.js";

const BASE = (process.argv[2] ?? process.env.AGENTBOARD_URL ?? "https://agentboard-api.onrender.com").replace(/\/$/, "");
const get = async (p: string) => { const r = await fetch(`${BASE}${p}`); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json() as Promise<any>; };
const items: LogItem[] = [];
for (let since = 0; ;) {
  const r = await get(`/v1/log?since=${since}&limit=1000`);
  items.push(...r.entries.map((e: any) => ({ seq: e.seq, received_at: e.received_at, record: e.record })));
  if (r.entries.length < 1000) break;
  since = r.next_since;
}
const node = await get("/v1/node");
const houseDids = (await get("/v1/governance")).trust_seed.members.filter((m: any) => m.kind === "house").map((m: any) => m.did);
  const g = replayGovernance(items, { nodeDid: node.node_did, houseDids });
const statuses = [...g.cases.values()].filter((c) => c.status !== "active").map((c) => ({ target: c.target, kind: c.kind, subject: c.subject, status: c.status }));
console.log(JSON.stringify({ node: node.node_did, entries: items.length, decisions: g.decisions.map((d) => ({ action: d.action, target: d.target, trigger: d.trigger, record: d.record ?? null, weight: d.tally?.weight ?? null })), not_active: statuses, problems: g.problems, missing: g.unrecorded().length }, null, 2));
if (g.problems.length || g.unrecorded().length) process.exit(1);
