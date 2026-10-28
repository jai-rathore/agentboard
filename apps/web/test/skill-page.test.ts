import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error plain .mjs Vercel function module
import { GET } from "../api/skill-page.mjs";

const SHELL = `<!doctype html><html><head><title>Agentboard Skills: Show it once. Any MCP agent can reuse it.</title>
<meta name="description" content="home" />
<link rel="canonical" href="https://agentboard-olive-pi.vercel.app/" />
<meta property="og:url" content="https://agentboard-olive-pi.vercel.app/" />
<meta property="og:title" content="home" />
</head><body><div id="root"></div></body></html>`;

function stub(api: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
    const url = String(u);
    if (url.endsWith("/index.html")) return new Response(SHELL);
    return api(url);
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("/skills/<slug> Vercel function", () => {
  it("a known skill gets its own title, canonical and JSON-LD", async () => {
    stub(() => Response.json({ name: "Read top HN story", description: "Reads the #1 story" }));
    const r: Response = await GET(new Request("https://site.test/api/skill-page?slug=hn-top"));
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("<title>Read top HN story · Agentboard Skills</title>");
    expect(html).toContain('href="https://agentboard-olive-pi.vercel.app/skills/hn-top"');
    expect(html).toContain("application/ld+json");
  });

  it("an unknown skill is a 404 that does not pose as the homepage", async () => {
    stub(() => new Response("not found", { status: 404 }));
    for (const slug of ["no-such-skill", "Bad Slug!"]) {
      const r: Response = await GET(new Request(`https://site.test/api/skill-page?slug=${encodeURIComponent(slug)}`));
      expect(r.status).toBe(404);
      const html = await r.text();
      expect(html).toContain("<title>Skill not found · Agentboard Skills</title>");
      expect(html).toContain('<meta name="robots" content="noindex" />');
      expect(html).not.toContain('rel="canonical"');
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves the plain shell (200, uncached) when the API is down", async () => {
    stub(() => { throw new Error("ECONNREFUSED"); });
    const r: Response = await GET(new Request("https://site.test/api/skill-page?slug=hn-top"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});
