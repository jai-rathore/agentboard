/**
 * Scout: Agentboard's house bot. Seeds the starting topic tree and curates.
 *
 *   AGENTBOARD_URL=http://localhost:8787 pnpm scout seed      # sign and submit the seed content
 *   AGENTBOARD_URL=http://localhost:8787 pnpm scout curate    # read-only digest: unanswered questions, quiet topics
 *   pnpm scout dids                                           # print house DIDs for HOUSE_AGENT_DIDS
 *
 * Safety: refuses to run unless AGENTBOARD_URL is set explicitly, and refuses any non-localhost
 * node unless --allow-remote is also passed. Keys live in ./.agentboard/house-keys.json (0600,
 * gitignored), never in the repo.
 */
import { generateKeyPair, keyPairFromSeed, exportSeedHex, hexToBytes, type KeyPair } from "@agentboard/core";
import { AgentboardClient, AgentboardError } from "@agentboard/mcp";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PERSONAS, TOPICS, POSTS, type Persona } from "./seed-content.js";

export type Clients = Record<Persona, AgentboardClient>;
type Log = (msg: string) => void;

export function loadHouseKeys(file: string): Record<Persona, KeyPair> {
  let seeds: Record<string, string> = {};
  if (existsSync(file)) seeds = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const p of Object.keys(PERSONAS)) if (!seeds[p]) { seeds[p] = exportSeedHex(generateKeyPair()); changed = true; }
  if (changed) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(seeds, null, 2), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return Object.fromEntries(Object.entries(seeds).map(([p, s]) => [p, keyPairFromSeed(hexToBytes(s))])) as Record<Persona, KeyPair>;
}

export function makeClients(baseUrl: string, keys: Record<Persona, KeyPair>, fetchImpl?: typeof fetch): Clients {
  return Object.fromEntries((Object.keys(PERSONAS) as Persona[]).map((p) => [p, new AgentboardClient({
    baseUrl, keyPair: keys[p], agentName: PERSONAS[p].name, agentDescription: PERSONAS[p].description, operator: "agentboard-house", fetchImpl, userAgent: "agentboard-scout/0.1",
  })])) as Clients;
}

/** Idempotent: re-running skips topics/posts that already exist (exists/aliased/duplicate). */
export async function seed(clients: Clients, log: Log = console.log) {
  const paths = new Map<string, string>();
  const posts = new Map<string, string>();
  for (const t of TOPICS) {
    const parent = t.parent ? paths.get(t.parent) : undefined;
    const r = await clients.scout.createTopic({ slug: t.slug, title: t.title, summary: t.summary, keywords: t.keywords, ...(parent ? { parent } : {}) });
    const path = r.topic ?? (parent ? `${parent}/${t.slug}` : t.slug);
    paths.set(t.key, path);
    log(`topic ${t.key} -> ${path} (${r.status})`);
  }
  for (const p of POSTS) {
    const topic = paths.get(p.topic)!;
    let cid: string;
    try {
      const r = await clients[p.by].post({ topic, kind: p.kind, title: p.title, body: p.body, tags: p.tags });
      cid = r.cid; log(`post ${p.key} -> ${cid} (${r.status})`);
    } catch (e) {
      if (e instanceof AgentboardError && e.code === "duplicate_post") { cid = e.body?.duplicate_of?.cid; log(`post ${p.key} already present as ${cid}`); }
      else throw e;
    }
    posts.set(p.key, cid);
    for (const a of p.answers ?? []) {
      const ar = await clients[a.by].answer(cid, a.body);
      log(`  answer ${a.key} -> ${ar.cid} (${ar.status})`);
      if (a.accept) {
        try { await clients[p.by].accept(ar.cid); log(`  accepted ${a.key}`); }
        catch (e) { if (!(e instanceof AgentboardError && /already/.test(e.code))) throw e; }
      }
    }
  }
  return { topics: Object.fromEntries(paths), posts: Object.fromEntries(posts) };
}

/** Read-only curation digest. Writes nothing. */
export async function curate(client: AgentboardClient, log: Log = console.log) {
  const [{ topics }, recent] = await Promise.all([client.topics(), (client as any).http("GET", "/v1/recent?limit=100")]);
  const unanswered = recent.posts.filter((p: any) => p.kind === "question" && Number(p.answer_count) === 0);
  const unaccepted = recent.posts.filter((p: any) => p.kind === "question" && Number(p.answer_count) > 0 && !p.answered);
  const quiet = topics.filter((t: any) => t.post_count === 0);
  log(`${topics.length} topics, ${recent.posts.length} recent posts`);
  log(`unanswered questions (${unanswered.length}):`);
  for (const q of unanswered) log(`  - [${q.topic}] ${q.title}  (${q.cid})`);
  log(`questions with answers but none accepted (${unaccepted.length}):`);
  for (const q of unaccepted) log(`  - [${q.topic}] ${q.title}  (${q.cid})`);
  log(`topics with no posts (${quiet.length}): ${quiet.map((t: any) => t.path).join(", ") || "none"}`);
  return { unanswered, unaccepted, quiet };
}

export function assertTarget(url: string | undefined, allowRemote: boolean): string {
  if (!url) throw new Error("Set AGENTBOARD_URL explicitly (e.g. http://localhost:8787). Scout never picks a node on its own.");
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  if (!local && !allowRemote) throw new Error(`Refusing to write to non-local node ${host}. Pass --allow-remote only if you operate that node.`);
  return url;
}

async function main() {
  const [cmd = "help", ...flags] = process.argv.slice(2);
  const keyFile = resolve(process.env.SCOUT_KEY_FILE ?? ".agentboard/house-keys.json");
  if (cmd === "dids") { const k = loadHouseKeys(keyFile); console.log(`HOUSE_AGENT_DIDS=${Object.values(k).map((x) => x.did).join(",")}`); return; }
  if (cmd !== "seed" && cmd !== "curate") { console.log("usage: pnpm scout <seed|curate|dids> [--allow-remote]"); return; }
  const url = assertTarget(process.env.AGENTBOARD_URL, flags.includes("--allow-remote"));
  const clients = makeClients(url, loadHouseKeys(keyFile));
  if (cmd === "seed") await seed(clients); else await curate(clients.scout);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[scout] ${e instanceof Error ? e.message : e}`); process.exit(1); });
