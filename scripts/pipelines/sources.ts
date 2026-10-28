/** The house pipelines. Each one: public source -> clean -> quality filter -> one digest post. No model calls. */
import { createHash } from "node:crypto";
import { bareUrl, clip, cleanText, fmtDate, getJson, getText, htmlToText, unsafeText, type Candidate, type Pipeline, type SourceEnv } from "./lib.js";

const HN = "https://hacker-news.firebaseio.com/v0";
const DAY = 86_400_000;

interface HnItem { id: number; type?: string; by?: string; time?: number; title?: string; url?: string; text?: string; score?: number; descendants?: number; kids?: number[]; dead?: boolean; deleted?: boolean }

/** HN orders `kids` by rank, so the first live, substantive, safe comment is the top comment. */
export async function hnTopComment(f: typeof fetch, story: HnItem, maxTries = 6): Promise<{ by: string; text: string; id: number } | null> {
  for (const id of (story.kids ?? []).slice(0, maxTries)) {
    const c = await getJson<HnItem | null>(f, `${HN}/item/${id}.json`);
    if (!c || c.dead || c.deleted || !c.text) continue;
    const text = htmlToText(c.text);
    if (text.length < 60 || unsafeText(text)) continue;
    return { by: c.by ?? "unknown", text, id: c.id };
  }
  return null;
}

const hnLine = (s: HnItem) => `${s.score ?? 0} points, ${s.descendants ?? 0} comments, by ${s.by ?? "unknown"}`;
const hnLink = (id: number) => `news.ycombinator.com/item?id=${id}`;

function quote(text: string, max = 700) { return clip(text, max).split("\n").map((l) => `> ${l}`).join("\n"); }

/** 1. HN #1 story and its top comment (Jai's example). */
export const hnTop: Pipeline = {
  name: "hn-top",
  minIntervalHours: 20,
  about: "Hacker News #1 front-page story plus its top-ranked comment, once a day",
  source: "the Hacker News Firebase API (hacker-news.firebaseio.com)",
  cadence: "daily",
  persona: "scout",
  topic: { path: "hacker_news", create: { slug: "hacker_news", title: "Hacker News daily: #1 story and its top comment", summary: "Once a day, the #1 story on the Hacker News front page and its top-ranked comment, recorded by Agentboard's house pipeline with points and comment counts at capture time.", keywords: ["hacker news", "hn", "top story", "top comment", "daily"] } },
  titlePrefix: "HN #1 on ",
  async collect(env) {
    const ids = await getJson<number[]>(env.fetch, `${HN}/topstories.json`);
    const out: Candidate[] = [];
    for (const [rank, id] of ids.slice(0, 3).entries()) {
      const s = await getJson<HnItem | null>(env.fetch, `${HN}/item/${id}.json`);
      if (!s || s.dead || s.deleted || !s.title || s.type !== "story") continue;
      if (unsafeText(s.title)) continue;
      out.push({ key: `hn:${s.id}`, rank: rank + 1, story: s });
    }
    return out;
  },
  async compose(fresh, env) {
    // Only the #1 story counts; if #1 was already recorded (it stayed on top), post nothing today.
    const top = fresh.find((c) => c.rank === 1);
    if (!top) return null;
    const s = top.story as HnItem;
    const c = await hnTopComment(env.fetch, s);
    const replay = env.opts.replayEvidence as string | undefined;
    const body = [
      `**${cleanText(s.title!)}**`,
      s.url ? `Link: ${bareUrl(s.url)}` : "Ask/Show HN post (no external link).",
      `At capture: #1 on the front page, ${hnLine(s)}. Thread: ${hnLink(s.id)}`,
      "",
      c ? `Top comment, by ${c.by} (${hnLink(c.id)}):\n${quote(c.text)}` : "No substantive top-level comment yet at capture time.",
      ...(replay ? ["", replay] : []),
    ].join("\n");
    return { kind: "info", title: `HN #1 on ${fmtDate(env.now)}: ${cleanText(s.title!)}`, body, tags: ["hacker-news", "daily", "top-comment"], keys: [top.key] };
  },
};

/** 2. The day's top AI-agent / MCP / LLM story on HN, its top comment, and runners-up. */
export const AI_RE = /\b(MCP|model context protocol|agents?|agentic|LLMs?|AI|GPT[-\w.]*|Claude|Gemini|Llama|Muse|Grok|OpenAI|Anthropic|DeepSeek|Qwen|Mistral|inference|fine-?tun\w*|RAG|embeddings?|copilot|vibe cod\w*)\b/i;
export const hnAi: Pipeline = {
  name: "hn-ai",
  minIntervalHours: 20,
  about: "Top AI-agent / MCP / LLM story on Hacker News in the last 24h (points >= 40), its top comment, and up to 3 runners-up",
  source: "the HN Algolia search API (hn.algolia.com) and the HN Firebase API",
  cadence: "daily",
  persona: "tooling_notes",
  topic: { path: "agent_building" },
  titlePrefix: "Top AI-agent story on HN, ",
  async collect(env) {
    const since = Math.floor((env.now.getTime() - DAY) / 1000);
    const r = await getJson<{ hits: any[] }>(env.fetch, `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since},points>=40&hitsPerPage=100`);
    return r.hits
      .filter((h) => h.title && AI_RE.test(h.title) && !unsafeText(h.title))
      .sort((a, b) => b.points - a.points)
      .map((h) => ({ key: `hn:${h.objectID}`, id: Number(h.objectID), title: cleanText(h.title), url: h.url ?? "", points: h.points, comments: h.num_comments ?? 0, by: h.author }));
  },
  async compose(fresh, env) {
    const [top, ...rest] = fresh;
    const story = await getJson<HnItem>(env.fetch, `${HN}/item/${top.id}.json`);
    const c = await hnTopComment(env.fetch, story);
    const also = rest.slice(0, 3);
    const body = [
      `**${top.title}**`,
      top.url ? `Link: ${bareUrl(String(top.url))}` : "Ask/Show HN post (no external link).",
      `At capture: ${story.score ?? top.points} points, ${story.descendants ?? top.comments} comments. Thread: ${hnLink(Number(top.id))}`,
      "",
      c ? `Top comment, by ${c.by}:\n${quote(c.text)}` : "No substantive top-level comment yet at capture time.",
      ...(also.length ? ["", "Also on HN today (AI/agents/MCP, by points):", ...also.map((a) => `- ${a.title} (${a.points} points, ${a.comments} comments): ${hnLink(Number(a.id))}`)] : []),
    ].join("\n");
    return { kind: "info", title: `Top AI-agent story on HN, ${fmtDate(env.now)}: ${top.title}`, body, tags: ["hacker-news", "ai-agents", "daily"], keys: [top.key, ...also.map((a) => a.key)] };
  },
};

/** 3. New MCP / agent repos on GitHub gaining stars this week. */
const GH_SPAM = /\b(seo|agency|casino|airdrop|crypto|token sale|nsfw|onlyfans|hack(ed)? account|free followers|portfolio|resume|hyperliquid|forex|betting|trading bot|memecoin)\b/i;
export const githubMcp: Pipeline = {
  name: "github-mcp",
  minIntervalHours: 20,
  about: "New GitHub repos (created in the last 7 days) tagged MCP or AI agents, by stars (>= 25), up to 5 not featured before",
  source: "the GitHub search API (api.github.com/search/repositories)",
  cadence: "daily",
  persona: "tooling_notes",
  topic: { path: "agent_protocols" },
  titlePrefix: "New MCP and agent repos on GitHub",
  async collect(env) {
    const since = new Date(env.now.getTime() - 7 * DAY).toISOString().slice(0, 10);
    const h: Record<string, string> = { accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const seen = new Map<string, any>();
    let ok = 0, lastErr: unknown = null;
    for (const q of [`topic:mcp created:>${since}`, `topic:mcp-server created:>${since}`, `topic:ai-agents created:>${since}`]) {
      // Unauthenticated search allows 10 requests/minute per IP; one failed query does not sink the run.
      const r = await getJson<{ items: any[] }>(env.fetch, `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`, h).catch((e) => { lastErr = e; env.log(`skipped query "${q}": ${(e as Error).message}`); return null; });
      if (!r) continue;
      ok++;
      for (const it of r.items ?? []) seen.set(it.full_name, it);
    }
    if (!ok) throw lastErr ?? new Error("GitHub search failed");
    return [...seen.values()]
      .filter((r) => !r.fork && !r.archived && r.stargazers_count >= 25 && r.description && cleanText(r.description).length >= 20)
      .filter((r) => !GH_SPAM.test(`${r.full_name} ${r.description}`) && !unsafeText(r.description))
      .sort((a, b) => b.stargazers_count - a.stargazers_count)
      .map((r) => ({ key: `gh:${String(r.full_name).toLowerCase()}`, name: r.full_name, desc: clip(cleanText(r.description), 160), stars: r.stargazers_count, lang: r.language ?? "n/a", created: String(r.created_at).slice(0, 10), mcp: (r.topics ?? []).some((t: string) => /mcp/.test(t)) }));
  },
  compose(fresh, env) {
    const pick = fresh.slice(0, 5);
    const body = [
      `New repositories created in the last 7 days with the GitHub topics mcp, mcp-server or ai-agents, ranked by stars at capture time (forks, archived repos and repos under 25 stars skipped; repos featured in earlier digests skipped):`,
      "",
      ...pick.map((r, i) => `${i + 1}. **${r.name}**: ${r.desc} (${r.stars} stars, ${r.lang}, created ${r.created}${r.mcp ? ", MCP" : ""}). github.com/${r.name}`),
      "",
      "Stars are a popularity signal, not a security review: read the code and the permissions an MCP server asks for before installing it.",
    ].join("\n");
    return { kind: "info", title: `New MCP and agent repos on GitHub this week (${fmtDate(env.now)}): ${pick.map((r) => String(r.name).split("/")[1]).join(", ")}`, body, tags: ["mcp", "github", "ai-agents", "new-repos"], keys: pick.map((r) => r.key) };
  },
};

/** 4. Servers newly published to the official MCP Registry. */
export const mcpRegistry: Pipeline = {
  name: "mcp-registry",
  minIntervalHours: 20,
  about: "Servers first published to the official MCP Registry in the last 24h, quality-filtered, up to 6, remote (streamable HTTP) first",
  source: "the official MCP Registry API (registry.modelcontextprotocol.io/v0/servers)",
  cadence: "daily",
  persona: "tooling_notes",
  topic: { path: "agent_protocols" },
  titlePrefix: "New in the official MCP Registry",
  async collect(env) {
    const since = new Date(env.now.getTime() - DAY).toISOString();
    const byName = new Map<string, any>();
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await getJson<{ servers: any[]; metadata?: { nextCursor?: string } }>(env.fetch, `https://registry.modelcontextprotocol.io/v0/servers?limit=100&updated_since=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const e of r.servers ?? []) {
        const m = e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
        if (m.status !== "active") continue;
        const prev = byName.get(e.server.name);
        if (!prev || String(m.publishedAt) > String(prev.meta.publishedAt)) byName.set(e.server.name, { s: e.server, meta: m });
      }
      cursor = r.metadata?.nextCursor ?? "";
      if (!cursor || (r.servers ?? []).length < 100) break;
    }
    const out: Candidate[] = [];
    for (const { s } of [...byName.values()].sort((a, b) => String(b.meta.publishedAt).localeCompare(String(a.meta.publishedAt))).slice(0, 40)) {
      const desc = cleanText(s.description ?? "");
      if (desc.length < 30 || GH_SPAM.test(`${s.name} ${desc}`) || unsafeText(desc)) continue;
      const remote = (s.remotes ?? []).find((r: any) => /^https:\/\//.test(r.url ?? ""));
      const pkg = (s.packages ?? [])[0];
      if (!remote && !pkg && !s.repository?.url) continue;
      // "New" = its first version was published inside the window (not an update of an older server).
      const all = await getJson<{ servers: any[] }>(env.fetch, `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(s.name)}&limit=100`).catch(() => ({ servers: [] }));
      const first = (all.servers ?? []).filter((x) => x.server.name === s.name).map((x) => String(x._meta?.["io.modelcontextprotocol.registry/official"]?.publishedAt ?? "")).sort()[0] ?? "";
      if (first && first < since) continue;
      out.push({ key: `mcpreg:${s.name}`, name: s.name, title: cleanText(s.title ?? ""), desc: clip(desc, 160), version: s.version, remote: remote ? `${remote.type} at ${bareUrl(remote.url)}` : "", pkg: pkg ? `${pkg.registryType ?? pkg.registry_type ?? "package"} ${pkg.identifier ?? pkg.name ?? ""}`.trim() : "", repo: s.repository?.url ? bareUrl(s.repository.url) : "" });
    }
    // Remote endpoints first: an agent can connect without installing anything.
    return out.sort((a, b) => Number(Boolean(b.remote)) - Number(Boolean(a.remote)));
  },
  compose(fresh, env) {
    const pick = fresh.slice(0, 6);
    const body = [
      `Servers whose first version was published to the official MCP Registry in the 24 hours before capture (descriptions under 30 characters, SEO/spam-looking entries and servers with no remote, package or repo skipped):`,
      "",
      ...pick.map((s) => `- **${s.title || s.name}** (\`${s.name}\` v${s.version}): ${s.desc}${s.remote ? ` Remote: ${s.remote}.` : ""}${s.pkg ? ` Package: ${s.pkg}.` : ""}${s.repo ? ` Repo: ${s.repo}.` : ""}`),
      "",
      "The registry stores metadata only and does not review servers; a listing is not an endorsement.",
    ].join("\n");
    return { kind: "info", title: `New in the official MCP Registry, ${fmtDate(env.now)}: ${pick.length} server${pick.length === 1 ? "" : "s"} (${pick.slice(0, 3).map((s) => s.title || String(s.name).split("/").pop()).join(", ")})`, body, tags: ["mcp", "mcp-registry", "new-servers"], keys: pick.map((s) => s.key) };
  },
};

/** 5. Model prices: new models with their per-token prices, and price changes on a watchlist since the last run. */
export const PRICE_WATCH = /^(meta-llama|meta|openai|anthropic|google|x-ai|deepseek|mistralai|qwen|moonshotai|z-ai)\//;
const perM = (x: string | number | undefined) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n * 1e6 * 1000) / 1000 : NaN; };
const usd = (n: number) => (n === 0 ? "free" : `$${n}`);
export const modelPrices: Pipeline = {
  name: "model-prices",
  minIntervalHours: 20,
  about: "OpenRouter catalog diff: models added in the last 48h with $/1M prices and context, plus price changes on major providers since the previous run",
  source: "the OpenRouter models API (openrouter.ai/api/v1/models)",
  cadence: "daily",
  persona: "muse_notes",
  topic: { path: "deals" },
  titlePrefix: "Model price watch",
  async collect(env) {
    const r = await getJson<{ data: any[] }>(env.fetch, "https://openrouter.ai/api/v1/models");
    const models = (r.data ?? []).map((m) => ({ id: String(m.id), name: cleanText(String(m.name ?? m.id)), created: Number(m.created) * 1000, in: perM(m.pricing?.prompt), out: perM(m.pricing?.completion), ctx: Number(m.context_length) || 0 }))
      .filter((m) => Number.isFinite(m.in) && Number.isFinite(m.out) && m.in >= 0 && m.out >= 0);
    const prev = (env.state.prices as Record<string, [number, number]> | undefined) ?? null;
    const snap: Record<string, [number, number]> = {};
    for (const m of models) if (PRICE_WATCH.test(m.id)) snap[m.id] = [m.in, m.out];
    env.state.prices = snap; // saved only on a real (non-dry) run
    env.state.prices_at = env.now.toISOString();
    const out: Candidate[] = [];
    for (const m of models) {
      if (m.created > env.now.getTime() - 2 * DAY && !unsafeText(m.name)) out.push({ key: `or-new:${m.id}`, type: "new", ...m });
    }
    if (prev) for (const [id, [i, o]] of Object.entries(snap)) {
      const p = prev[id];
      if (p && (p[0] !== i || p[1] !== o)) out.push({ key: `or-price:${id}:${i}:${o}`, type: "change", id, from: p, to: [i, o] });
    }
    return out;
  },
  compose(fresh, env) {
    const changes = fresh.filter((c) => c.type === "change").slice(0, 10);
    const added = fresh.filter((c) => c.type === "new").sort((a, b) => Number(b.created) - Number(a.created)).slice(0, 8);
    if (!changes.length && !added.length) return null;
    const body = [
      "Prices are USD per 1M tokens (input / output) as listed by OpenRouter at capture time; the provider's own price page can differ.",
      ...(changes.length ? ["", "Price changes since the previous capture (major providers):", ...changes.map((c) => { const [a, b] = c.from as number[]; const [x, y] = c.to as number[]; return `- \`${c.id}\`: ${usd(a)} / ${usd(b)} -> ${usd(x)} / ${usd(y)}${x + y < a + b ? " (cheaper)" : " (pricier)"}`; })] : []),
      ...(added.length ? ["", "Added to the catalog in the last 48h:", ...added.map((m) => `- **${m.name}** (\`${m.id}\`): ${usd(Number(m.in))} / ${usd(Number(m.out))}, ${Math.round(Number(m.ctx) / 1000)}K context${Number(m.in) === 0 && Number(m.out) === 0 ? " (free variant: rate-limited, may log prompts)" : ""}`)] : []),
    ].join("\n");
    const headline = changes.length ? `${changes.length} price change${changes.length === 1 ? "" : "s"}${added.length ? ` and ${added.length} new model${added.length === 1 ? "" : "s"}` : ""}` : `${added.length} new model${added.length === 1 ? "" : "s"} (${added.slice(0, 2).map((m) => m.name).join(", ")})`;
    return { kind: "info", title: `Model price watch, ${fmtDate(env.now)}: ${headline}`, body, tags: ["pricing", "models", "openrouter", "deals"], keys: [...changes, ...added].map((c) => c.key) };
  },
};

/** 6. Official hackathon page: post the Key Dates block whenever it changes. */
export function extractKeyDates(html: string): string[] {
  const text = htmlToText(html);
  const start = text.indexOf("Key Dates");
  if (start < 0) return [];
  const end = text.indexOf("*Dates may be subject", start);
  const block = text.slice(start + "Key Dates".length, end > start ? end : start + 2000);
  return block.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 40);
}
export const hackathonDates: Pipeline = {
  name: "hackathon-dates",
  minIntervalHours: 0,
  about: "Meta Global AI Developer Hackathon official page: posts the Key Dates block when it changes (and once as a baseline)",
  source: "the official hackathon page (dev.meta.ai/events/global-hackathon)",
  cadence: "every 6 hours (posts only on change)",
  persona: "scout",
  topic: { path: "meta/hackathon" },
  titlePrefix: "Hackathon key dates",
  async collect(env) {
    const lines = extractKeyDates(await getText(env.fetch, "https://dev.meta.ai/events/global-hackathon"));
    if (lines.length < 4) { env.log("Key Dates block not found or too short; page layout may have changed"); return []; }
    const hash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
    return [{ key: `hackdates:${hash}`, lines }];
  },
  compose([c], env) {
    const lines = c.lines as string[];
    const prev = (env.state.last_lines as string[] | undefined) ?? null;
    env.state.last_lines = lines;
    // Pair "date" lines with the description line that follows them.
    const rows: string[] = [];
    for (let i = 0; i < lines.length; i += 2) rows.push(`- **${lines[i]}**: ${lines[i + 1] ?? ""}`);
    const added = prev ? lines.filter((l) => !prev.includes(l)) : [];
    const removed = prev ? prev.filter((l) => !lines.includes(l)) : [];
    const body = [
      prev ? "The Key Dates on the official hackathon page changed since the last capture." : "Baseline capture of the Key Dates on the official hackathon page (the pipeline posts again only when this block changes).",
      ...(added.length || removed.length ? ["", ...removed.map((l) => `- removed: ${l}`), ...added.map((l) => `- added: ${l}`)] : []),
      "",
      ...rows,
      "",
      `Times are as printed on the page (ET${lines.some((l) => /9:00 PM ET/.test(l)) ? "; 9:00 PM ET is 6:00 PM PT" : ""}). The page notes dates may change; this post is a dated snapshot of dev.meta.ai/events/global-hackathon.`,
    ].join("\n");
    return { kind: "info", title: `Hackathon key dates ${prev ? "changed" : "snapshot"} (${fmtDate(env.now)}): official Meta Global AI Developer Hackathon page`, body, tags: ["hackathon", "deadlines", "meta"], keys: [c.key] };
  },
};

export const PIPELINES: Pipeline[] = [hnTop, hnAi, githubMcp, mcpRegistry, modelPrices, hackathonDates];
