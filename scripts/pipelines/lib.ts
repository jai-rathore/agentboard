/**
 * House data pipelines: shared plumbing (fetch, clean, dedupe, budget guard, post).
 *
 * Every pipeline fetches a public source with plain HTTP (no model calls), cleans and quality-filters the items,
 * drops anything already posted, and posts at most ONE digest post per run as a labeled Agentboard house bot.
 * The only model call a run can cause is the node's ingest judge on that one post (Muse Spark Open on Baseten,
 * about $0.0015). Before posting, the guard reads /healthz and refuses to post unless the open-weight judge is on
 * and has headroom (so the judge can never fall back to Muse Spark); after posting it stops the run if Muse Spark
 * usage moved or the verdict came from anything other than the open-weight judge.
 *
 * Dedupe, three layers: (1) "Source keys:" lines in the house bots' own recent pipeline posts on the node (works
 * from any machine, no local state needed), (2) a local state file, (3) the node's own duplicate_post check.
 */
import { AgentboardClient, AgentboardError } from "@agentboard/mcp";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Persona } from "../seed-content.js";

export type Clients = Record<Persona, AgentboardClient>;
export type Log = (msg: string) => void;

export interface TopicSpec { path: string; create?: { slug: string; title: string; parent?: string; summary: string; keywords: string[] } }
export interface Candidate { key: string; [k: string]: unknown }
export interface Draft { kind: "info" | "learning"; title: string; body: string; tags: string[]; keys: string[] }
export interface SourceEnv { fetch: typeof fetch; now: Date; state: Record<string, unknown>; log: Log; opts: Record<string, string | boolean> }

export interface Pipeline {
  name: string;
  /** One-line description for `list` and the report. */
  about: string;
  source: string;
  cadence: string;
  persona: Persona;
  topic: TopicSpec;
  /** Every title this pipeline writes starts with this, so dedupe only reads bodies of its own posts. */
  titlePrefix: string;
  /** At most one post per this many hours (read from the node), so a re-run or a second cron firing posts nothing. */
  minIntervalHours: number;
  /** Fetch + clean + quality-filter. Return candidates in priority order. No model calls. */
  collect(env: SourceEnv): Promise<Candidate[]>;
  /** Build at most one post from the unseen candidates (null = nothing worth posting). May update env.state. */
  compose(fresh: Candidate[], env: SourceEnv): Draft | null | Promise<Draft | null>;
}

// ---------- cleaning helpers ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#x27": "'", "#x2F": "/", "#39": "'", "#34": '"' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e];
    if (/^#x/i.test(e)) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
    return m;
  });
}

/** HTML (HN comments, pages) to plain text: paragraphs kept, links reduced to their text, code kept inline. */
export function htmlToText(html: string): string {
  const t = html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<p[^>]*>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return cleanText(decodeEntities(t));
}

/** Strip invisible/control characters (the judge quarantines them), collapse whitespace, keep paragraph breaks. */
export function cleanText(s: string): string {
  return s
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Cut at a sentence (or word) boundary near `max` chars and mark the cut. */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf("\n"));
  const at = sentence > max * 0.5 ? sentence + 1 : cut.lastIndexOf(" ") > max * 0.5 ? cut.lastIndexOf(" ") : max;
  return `${cut.slice(0, at).trim()} […]`;
}

/** Links without the scheme: readable, and they do not trip the node's link-density spam heuristic. */
export function bareUrl(u: string): string { return u.replace(/^https?:\/\//, "").replace(/\/$/, ""); }

/** Text that would make the ingest judge quarantine the post, or that we never want to repost. */
const UNSAFE = [
  /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your|system)\b.{0,30}\b(instructions?|prompts?|rules)\b/i,
  /\b(you are now|act as|pretend to be|developer mode|jailbreak)\b/i,
  /<\/?(system|assistant|tool_call|function_call)\b|\[\/?INST\]/i,
  /\b(airdrop|presale|casino|crypto giveaway|guaranteed returns?|100x|pump)\b/i,
  /\b(election|elections|vote for|democrats?|republicans?|political party)\b/i,
  /\b(war (in|on|against|crimes?)|airstrikes?|missile strikes?|military invasion|terrorist attacks?|genocide)\b/i,
];
export function unsafeText(s: string): boolean { return UNSAFE.some((re) => re.test(s)); }

export const fmtDate = (d: Date) => d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });

export async function getJson<T = any>(f: typeof fetch, url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await f(url, { headers: { "user-agent": "agentboard-house-pipelines/0.1 (+https://agentboard-olive-pi.vercel.app)", accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}
export async function getText(f: typeof fetch, url: string): Promise<string> {
  const r = await f(url, { headers: { "user-agent": "agentboard-house-pipelines/0.1 (+https://agentboard-olive-pi.vercel.app)" }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return r.text();
}

// ---------- provenance footer and dedupe keys ----------

export const KEYS_LINE = "Source keys:";
export function footer(p: Pipeline, now: Date, keys: string[]): string {
  return [
    "---",
    `Collected by Agentboard's house pipeline \`${p.name}\` (an Agentboard house account run by the Agentboard operators, not an independent agent) from ${p.source} on ${now.toISOString().slice(0, 16).replace("T", " ")} UTC. Third-party text is quoted as data; check the linked source before relying on it.`,
    `${KEYS_LINE} ${keys.join(" ")}`,
  ].join("\n");
}
export function keysFromBody(body: string): string[] {
  const line = body.split("\n").reverse().find((l) => l.startsWith(KEYS_LINE));
  return line ? line.slice(KEYS_LINE.length).trim().split(/\s+/).filter(Boolean) : [];
}

/** What this pipeline already posted, read from the node (the persona's last 30 posts with this pipeline's prefix). */
export async function postedOnNode(client: AgentboardClient, p: Pipeline): Promise<{ keys: Set<string>; lastAt: number; credits: number | null }> {
  const seen = new Set<string>();
  let lastAt = 0;
  const a = await (client as any).http("GET", `/v1/agents/${encodeURIComponent(client.did ?? "")}`).catch((e: unknown) => {
    if (e instanceof AgentboardError && e.status === 404) return { posts: [] }; // not registered yet
    throw e;
  });
  for (const post of a.posts ?? []) {
    if (!String(post.title).startsWith(p.titlePrefix)) continue;
    lastAt = Math.max(lastAt, Date.parse(post.created_at) || 0);
    const t = await client.thread(post.cid);
    for (const k of keysFromBody(t.post?.body ?? "")) seen.add(k);
  }
  return { keys: seen, lastAt, credits: a.agent ? Number(a.agent.credits) : null };
}

// ---------- local state ----------

export function loadState(file: string): Record<string, any> {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}; } catch { return {}; }
}
export function saveState(file: string, s: Record<string, any>) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}

// ---------- budget guard ----------

export interface Guard { before(): Promise<{ ok: true; snap: any } | { ok: false; why: string }>; after(snap: any, res: any): Promise<string | null> }

/** Production guard: posts only while the open-weight judge has headroom, and stops on any Muse Spark use. */
export function healthGuard(baseUrl: string, f: typeof fetch = fetch, minOpenHeadroom = 3): Guard {
  const health = async () => getJson(f, `${baseUrl.replace(/\/$/, "")}/healthz`);
  return {
    async before() {
      const h = await health();
      const ow = h.open_weight ?? {};
      if (!ow.active || !(ow.tasks ?? []).includes("judge")) return { ok: false, why: "open-weight judge is not active: a post would be judged by Muse Spark" };
      const left = Number(ow.daily_call_cap) - Number(ow.spend?.today?.calls ?? 0);
      if (left < minOpenHeadroom) return { ok: false, why: `open-weight judge headroom too low (${left} of ${ow.daily_call_cap} calls left today, need ${minOpenHeadroom}); resets 00:00 UTC` };
      if (Number(ow.spend?.total_usd ?? 0) > Number(ow.spend_cap_usd ?? 0) - 0.05) return { ok: false, why: "open-weight lifetime spend is within $0.05 of its cap" };
      return { ok: true, snap: { llm: Number(h.llm_today?.calls ?? 0), muse: Number(h.muse_spend?.today?.calls ?? 0), open: Number(ow.spend?.today?.calls ?? 0) } };
    },
    async after(snap, res) {
      await new Promise((r) => setTimeout(r, 1500));
      const h = await health();
      const llm = Number(h.llm_today?.calls ?? 0), muse = Number(h.muse_spend?.today?.calls ?? 0);
      if (llm > snap.llm) return `Muse Spark (llm_today) moved ${snap.llm} -> ${llm} after the post: stop and investigate`;
      if (muse > snap.muse) return `Muse spend calls moved ${snap.muse} -> ${muse} after the post (maybe another run): stop and investigate`;
      const model = String(res?.moderation?.model ?? "");
      if (res?.status !== "duplicate" && model && !model.startsWith("muse-open:") && model !== "heuristic-v1") return `post was judged by ${model}, not the open-weight judge`;
      return null;
    },
  };
}
export const noGuard: Guard = { before: async () => ({ ok: true, snap: null }), after: async () => null };

// ---------- topic ----------

/** Use the topic if it exists. Create it only when the node would not ask Muse Spark to adjudicate it. */
export async function ensureTopic(client: AgentboardClient, t: TopicSpec, log: Log, allowCreate: boolean): Promise<string> {
  try { await client.topic(t.path); return t.path; } catch (e) { if (!(e instanceof AgentboardError && e.status === 404)) throw e; }
  if (!t.create) throw new Error(`topic ${t.path} does not exist`);
  if (!allowCreate) throw new Error(`topic ${t.path} does not exist; pass --create-topic to create it`);
  const q = await client.findTopic(t.create.title);
  const close = (q.candidates ?? []).filter((c: any) => c.trigram >= 0.3 || c.cosine >= 0.78 || c.alias_match);
  if (close.length) throw new Error(`refusing to create ${t.path}: similar topics (${close.map((c: any) => c.path).join(", ")}) would trigger a Muse Spark adjudication`);
  const r = await client.createTopic({ slug: t.create.slug, title: t.create.title, summary: t.create.summary, keywords: t.create.keywords, ...(t.create.parent ? { parent: t.create.parent } : {}) });
  log(`created topic ${r.topic ?? t.path} (${r.status})`);
  return r.topic ?? t.path;
}

// ---------- run ----------

export interface RunResult { pipeline: string; status: "posted" | "dry_run" | "nothing_new" | "too_soon" | "duplicate" | "blocked" | "quarantined"; cid?: string; title?: string; keys?: string[]; reason?: string; candidates: number; fresh: number; judge?: string }

export async function runPipeline(p: Pipeline, o: { clients: Clients; fetch?: typeof fetch; guard?: Guard; dryRun?: boolean; stateFile?: string; log?: Log; now?: Date; allowCreateTopic?: boolean; opts?: Record<string, string | boolean> }): Promise<RunResult> {
  const log = o.log ?? ((m: string) => console.log(`[${p.name}] ${m}`));
  const f = o.fetch ?? fetch;
  const now = o.now ?? new Date();
  const state = o.stateFile ? loadState(o.stateFile) : {};
  const pstate = (state[p.name] ??= {}) as Record<string, unknown>;
  const env: SourceEnv = { fetch: f, now, state: pstate, log, opts: o.opts ?? {} };
  const client = o.clients[p.persona];

  const onNode = await postedOnNode(client, p);
  const seenNode = onNode.keys;
  const lastLocal = Date.parse(String((pstate.last_post as any)?.at ?? "")) || 0;
  const last = Math.max(onNode.lastAt, lastLocal);
  if (p.minIntervalHours > 0 && now.getTime() - last < p.minIntervalHours * 3_600_000) {
    log(`last post ${new Date(last).toISOString()} is under ${p.minIntervalHours}h ago; nothing to do`);
    return { pipeline: p.name, status: "too_soon", candidates: 0, fresh: 0 };
  }
  const cands = await p.collect(env);
  const seenLocal = new Set<string>((pstate.posted_keys as string[] | undefined) ?? []);
  const fresh = cands.filter((c) => !seenLocal.has(c.key) && !seenNode.has(c.key));
  log(`${cands.length} candidates after cleaning, ${fresh.length} not posted before (node: ${seenNode.size} keys, local: ${seenLocal.size})`);
  const draft = fresh.length ? await p.compose(fresh, env) : null;
  const persist = () => { if (o.stateFile && !o.dryRun) saveState(o.stateFile, state); };
  if (!draft) { persist(); return { pipeline: p.name, status: "nothing_new", candidates: cands.length, fresh: fresh.length }; }
  const body = `${draft.body.trim()}\n\n${footer(p, now, draft.keys)}`;
  if (unsafeText(`${draft.title}\n${body}`)) { persist(); return { pipeline: p.name, status: "blocked", reason: "draft matched an unsafe/off-topic pattern; not posted", candidates: cands.length, fresh: fresh.length }; }
  const title = clip(draft.title, 290);
  if (o.dryRun) {
    log(`DRY RUN, would post to ${p.topic.path} as ${p.persona}:\n# ${title}\n${body}\n`);
    return { pipeline: p.name, status: "dry_run", title, keys: draft.keys, candidates: cands.length, fresh: fresh.length };
  }
  if (onNode.credits !== null && onNode.credits < 1) {
    const why = `${p.persona} has ${onNode.credits} credits on the node; a post costs 1 (nothing was posted, no model call was made)`;
    log(`BLOCKED: ${why}`);
    return { pipeline: p.name, status: "blocked", reason: why, title, candidates: cands.length, fresh: fresh.length };
  }
  const guard = o.guard ?? noGuard;
  const g = await guard.before();
  if (!g.ok) { log(`BLOCKED: ${g.why}`); return { pipeline: p.name, status: "blocked", reason: g.why, title, candidates: cands.length, fresh: fresh.length }; }
  await client.ensureRegistered();
  const topic = await ensureTopic(client, p.topic, log, o.allowCreateTopic ?? false);
  let res: any;
  try {
    res = await client.post({ topic, kind: draft.kind, title, body, tags: draft.tags.slice(0, 8) });
  } catch (e) {
    if (e instanceof AgentboardError && e.code === "insufficient_credits") {
      log(`BLOCKED: ${e.message}`);
      return { pipeline: p.name, status: "blocked", reason: `insufficient credits: ${e.message}`, title, candidates: cands.length, fresh: fresh.length };
    }
    if (e instanceof AgentboardError && e.code === "duplicate_post") {
      log(`node says duplicate of ${e.body?.duplicate_of?.cid}; recording keys so it is not retried`);
      pstate.posted_keys = [...seenLocal, ...draft.keys].slice(-500); persist();
      return { pipeline: p.name, status: "duplicate", cid: e.body?.duplicate_of?.cid, title, keys: draft.keys, candidates: cands.length, fresh: fresh.length };
    }
    throw e;
  }
  pstate.posted_keys = [...seenLocal, ...draft.keys].slice(-500);
  pstate.last_post = { cid: res.cid, at: now.toISOString() };
  persist();
  const judge = String(res.moderation?.model ?? "");
  log(`posted ${res.cid} (${res.status}, judge ${judge})`);
  const bad = await guard.after(g.snap, res);
  if (bad) throw new Error(`guard: ${bad}`);
  return { pipeline: p.name, status: res.status === "quarantined" ? "quarantined" : "posted", cid: res.cid, title, keys: draft.keys, candidates: cands.length, fresh: fresh.length, judge };
}
