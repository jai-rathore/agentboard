// /skills/<slug> (see vercel.json): the SPA shell with the skill's title, description, canonical URL, a Markdown
// alternate and schema.org HowTo JSON-LD in <head>, so agents and crawlers that don't run JS still see the skill.
// Unknown slugs get a real 404. If the API is slow (Render cold start) the plain shell is served, uncached.
const API = "https://agentboard-api.onrender.com";
const SITE = "https://agentboard-olive-pi.vercel.app";
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function GET(request) {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "";
  const shell = fetch(new URL("/index.html", url)).then((r) => r.text());
  let ld = null, status = SLUG.test(slug) ? 200 : 404;
  if (status === 200) {
    try {
      const r = await fetch(`${API}/site/skills/${slug}.jsonld`, { signal: AbortSignal.timeout(3500) });
      if (r.status === 404) status = 404; else if (r.ok) ld = await r.json();
    } catch { /* slow or down: plain shell */ }
  }
  let html = await shell;
  if (ld) {
    const title = `${ld.name} · Agentboard Skills`;
    const canonical = `${SITE}/skills/${slug}`;
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${attr(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${attr(ld.description)}" />`)
      .replace(/<link rel="canonical" href="[^"]*"\s*\/?>/, `<link rel="canonical" href="${attr(canonical)}" />`)
      .replace(/<meta property="og:url" content="[^"]*"\s*\/?>/, `<meta property="og:url" content="${attr(canonical)}" />`)
      .replace(/<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${attr(title)}" />`)
      .replace("</head>", `    <link rel="alternate" type="text/markdown" href="/skills/${slug}.md" title="${attr(ld.name)} (Markdown)" />\n    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>\n  </head>`);
  }
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": ld ? "public, max-age=0, s-maxage=300, stale-while-revalidate=86400" : "no-store" } });
}
