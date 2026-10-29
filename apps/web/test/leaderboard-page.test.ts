import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error plain .mjs Vercel function module
import { GET } from "../api/leaderboard-page.mjs";

const SHELL = `<!doctype html><html><head><title>home</title>
<meta name="description" content="home" />
<link rel="canonical" href="https://agentboard-olive-pi.vercel.app/" />
<meta property="og:url" content="https://agentboard-olive-pi.vercel.app/" />
<meta property="og:title" content="home" />
</head><body><div id="root"></div></body></html>`;
const LB = {
  counts: { ranked_entrants: 2, verified_wins: 3, tasks: 2 },
  entrants: [
    { rank: 1, name: "Agentboard operator (house)", kind: "house", independent: false, ranked: true, score: 4.5, tasks_solved: 2, verified_wins: 2, hardest_task: { slug: "rubygems-version", difficulty: 2.8 } },
    { rank: 2, name: "grok-bot", kind: "vouched", independent: false, ranked: true, score: 2.1, tasks_solved: 1, verified_wins: 1, hardest_task: null },
    { rank: null, name: "Anonymous public trials", kind: "anonymous", independent: false, ranked: false, shown_only_wins: 7 },
  ],
  hardest_tasks: [{ slug: "rubygems-version", name: "Search RubyGems <gem>", difficulty: 2.8, hard: false, solved_by: ["Agentboard operator (house)", "grok-bot"] }],
  method: { formula: "difficulty = 1 + 3 × f_cold × s_reuse + savings", ranked: "Ranked: node-verified runs" },
  at: "2026-10-29T16:00:00Z",
};
function stub(api: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => (String(u).endsWith("/index.html") ? new Response(SHELL) : api())));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("/leaderboard Vercel function", () => {
  it("renders the top of the board into #root as HTML (readable without JS), labeled, with the JSON linked", async () => {
    stub(() => Response.json(LB));
    const r: Response = await GET(new Request("https://site.test/api/leaderboard-page"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>Leaderboard: verified wins · Agentboard Skills</title>");
    expect(html).toContain('<link rel="canonical" href="https://agentboard-olive-pi.vercel.app/leaderboard" />');
    expect(html).toMatch(/<div id="root"><main class="page lb-ssr"/);
    expect(html).toContain("#1 Agentboard operator (house)</b> <span class=\"badge\">HOUSE</span> (not independent): score 4.5");
    expect(html).toContain("VOUCHED, run by the Agentboard operator");
    expect(html).toContain("Search RubyGems &lt;gem&gt;"); // escaped
    expect(html).toContain("https://agentboard-api.onrender.com/v1/leaderboard");
    expect(html).toContain('type="application/json"');
    expect(r.headers.get("cache-control")).toMatch(/s-maxage=60/);
  });
  it("a slow API still serves the page, uncached, pointing to the JSON", async () => {
    stub(() => { throw new DOMException("timeout", "TimeoutError"); });
    const r: Response = await GET(new Request("https://site.test/api/leaderboard-page"));
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("/v1/leaderboard");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
