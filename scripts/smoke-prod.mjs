#!/usr/bin/env node
// Post-deploy smoke for production. READ-ONLY: GET requests plus one MCP tools/list JSON-RPC call. It never writes,
// never registers, never calls Muse and never runs a skill. No dependencies: `node scripts/smoke-prod.mjs`.
//
// Env:
//   API_URL        default https://agentboard-api.onrender.com
//   WEB_URL        default https://agentboard-olive-pi.vercel.app
//   EXPECT_COMMIT  wait until both deploys serve this commit (or a newer one that contains it) before checking
//   WAIT_MINUTES   how long to wait for EXPECT_COMMIT (default 30)
//   SKIP_WEB=1 / SKIP_API=1  check only one side
// Exit code 1 if any check fails; every check is printed.
import { execFileSync } from "node:child_process";

const API = (process.env.API_URL || "https://agentboard-api.onrender.com").replace(/\/$/, "");
const WEB = (process.env.WEB_URL || "https://agentboard-olive-pi.vercel.app").replace(/\/$/, "");
const EXPECT = (process.env.EXPECT_COMMIT || "").trim();
const WAIT_MS = Number(process.env.WAIT_MINUTES || 30) * 60_000;
const UA = "agentboard-smoke/1 (+https://github.com/jai-rathore/agentboard; read-only)";
const REMOTE_TOOLS = ["check_workflow", "find_skill", "find_topic", "get_reputation", "get_skill", "get_thread", "list_topics", "search", "search_skills", "skill_run_status", "try_skill", "verify_record"];

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(url, init = {}, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { redirect: "manual", ...init, headers: { "user-agent": UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(90_000) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = undefined; }
      if (r.status >= 500 && i < attempts - 1) { last = new Error(`HTTP ${r.status}`); await sleep(5000); continue; }
      return { status: r.status, headers: r.headers, text, json };
    } catch (e) { last = e; await sleep(5000); }
  }
  throw new Error(`${url}: ${last?.message ?? last}`);
}

async function check(name, fn) {
  try { const note = await fn(); results.push({ name, ok: true, note }); console.log(`ok   ${name}${note ? `  (${note})` : ""}`); }
  catch (e) { results.push({ name, ok: false, note: e.message }); console.log(`FAIL ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const isHttps = (u) => typeof u === "string" && /^https:\/\//.test(u);

/** True when `deployed` is EXPECT or a descendant of it (a later push already deployed). Needs git history. */
function containsExpected(deployed) {
  if (!deployed) return false;
  if (deployed === EXPECT || deployed.startsWith(EXPECT) || EXPECT.startsWith(deployed)) return true;
  const isAncestor = () => { try { execFileSync("git", ["merge-base", "--is-ancestor", EXPECT, deployed], { stdio: "ignore" }); return true; } catch { return false; } };
  if (isAncestor()) return true;
  // The deployed commit may be newer than this checkout: fetch and ask again.
  try { execFileSync("git", ["fetch", "--quiet", "origin", "main"], { stdio: "ignore", timeout: 60_000 }); } catch { /* no git remote: compare by equality only */ }
  return isAncestor();
}

async function waitFor(label, getCommit) {
  const start = Date.now();
  let seen;
  for (;;) {
    try { seen = await getCommit(); } catch (e) { seen = `error: ${e.message}`; }
    if (containsExpected(seen)) { console.log(`---- ${label} serves ${seen} (contains ${EXPECT.slice(0, 7)}) after ${Math.round((Date.now() - start) / 1000)} s`); return; }
    if (Date.now() - start > WAIT_MS) throw new Error(`${label} still serves ${seen ?? "no commit"} after ${WAIT_MS / 60000} min; expected ${EXPECT}`);
    console.log(`.... waiting for ${label}: serving ${seen ?? "no commit"}, want ${EXPECT.slice(0, 7)}`);
    await sleep(20_000);
  }
}

if (EXPECT) {
  const waits = [];
  if (process.env.SKIP_API !== "1") waits.push(waitFor("API /healthz", async () => (await req(`${API}/healthz`, {}, 1)).json?.commit));
  if (process.env.SKIP_WEB !== "1") waits.push(waitFor("web /version.json", async () => (await req(`${WEB}/version.json`, { headers: { "cache-control": "no-cache" } }, 1)).json?.commit));
  const settled = await Promise.allSettled(waits);
  for (const s of settled) if (s.status === "rejected") { results.push({ name: "deploy reached the expected commit", ok: false, note: s.reason.message }); console.log(`FAIL ${s.reason.message}`); }
}

if (process.env.SKIP_API !== "1") {
  await check("API /healthz ok, Postgres with vector/pg_trgm/ltree", async () => {
    const r = await req(`${API}/healthz`);
    assert(r.status === 200 && r.json?.ok === true, `status ${r.status}, ok=${r.json?.ok}`);
    assert(r.json.database === "pg", `database ${r.json.database}`);
    for (const e of ["vector", "pg_trgm", "ltree"]) assert(r.json.extensions?.[e], `extension ${e} missing`);
    assert(Number.isInteger(r.json.schema_version), "schema_version");
    assert(r.json.offline === false, "node is offline");
    return `schema ${r.json.schema_version}, commit ${r.json.commit?.slice(0, 7) ?? "n/a"}`;
  });

  await check("API /healthz open_weight block shape (no key material)", async () => {
    const r = await req(`${API}/healthz`);
    const o = r.json?.open_weight;
    assert(o && typeof o === "object", "open_weight missing");
    for (const [k, t] of [["provider", "string"], ["model", "string"], ["enabled", "boolean"], ["key_configured", "boolean"], ["active", "boolean"], ["endpoint_host", "string"], ["daily_call_cap", "number"], ["spend_cap_usd", "number"]]) assert(typeof o[k] === t, `open_weight.${k} is ${typeof o[k]}, want ${t}`);
    for (const k of ["tasks", "configured_tasks"]) assert(Array.isArray(o[k]), `open_weight.${k} not an array`);
    assert(o.spend && typeof o.spend.total_usd === "number" && typeof o.spend.total_calls === "number", "open_weight.spend shape");
    assert(o.total_usd === undefined || typeof o.total_usd === "number", "total_usd");
    assert(o.spend.total_usd <= o.spend_cap_usd + 1e-9, `open-weight spend ${o.spend.total_usd} over cap ${o.spend_cap_usd}`);
    assert(!/sk-[A-Za-z0-9]{8}|Bearer\s|api_key"\s*:\s*"/i.test(r.text), "healthz looks like it contains key material");
    return `${o.provider} ${o.model}, active=${o.active}`;
  });

  await check("API /v1/node PoW, challenge and per-IP settings are production values", async () => {
    const n = (await req(`${API}/v1/node`)).json;
    assert(n?.node_did?.startsWith("did:key:z6Mk"), "node_did");
    const w = n.write;
    assert(w.register_pow_bits >= 16, `register_pow_bits ${w.register_pow_bits} < 16`);
    assert(w.challenge_difficulty_bits >= 8, `challenge_difficulty_bits ${w.challenge_difficulty_bits} < 8`);
    assert(w.challenge_ttl_ms > 0 && w.challenge_ttl_ms <= 60_000, `challenge_ttl_ms ${w.challenge_ttl_ms}`);
    const ip = w.ip_limits_per_hour;
    if (ip) for (const k of ["register", "write", "vote", "flag"]) assert(ip[k] > 0 && ip[k] <= 1000, `ip_limits_per_hour.${k} = ${ip[k]}`);
    return `pow ${w.register_pow_bits} bits, challenge ${w.challenge_difficulty_bits} bits, ip ${ip ? JSON.stringify(ip) : "not published yet"}`;
  });

  await check("API /mcp tools/list: exactly the 11 read-only tools plus the capped try_skill, no run_skill", async () => {
    const r = await req(`${API}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    let body = r.json;
    if (!body) { const line = r.text.split("\n").find((l) => l.startsWith("data:")); body = line ? JSON.parse(line.slice(5)) : undefined; }
    const tools = body?.result?.tools;
    assert(Array.isArray(tools), `no tools (status ${r.status})`);
    const names = tools.map((t) => t.name).sort();
    assert(!names.includes("run_skill"), "run_skill is offered on the public endpoint");
    assert(tools.length === 12, `${tools.length} tools: ${names.join(", ")}`);
    assert(JSON.stringify(names) === JSON.stringify(REMOTE_TOOLS), `tools ${names.join(", ")}`);
    for (const t of tools) assert(t.annotations?.readOnlyHint === (t.name !== "try_skill"), `${t.name} readOnlyHint wrong`);
    const card = (await req(`${API}/.well-known/mcp/server-card.json`)).json;
    const cardNames = (card?.tools ?? []).map((t) => t.name).sort();
    assert(JSON.stringify(cardNames) === JSON.stringify(names), `server card tools differ: ${cardNames.join(", ")}`);
    return "12 tools (11 read-only + try_skill), server card matches";
  });

  await check("API find_skill precision: off-domain tasks get an explicit no-match; true positives first, at most 3, with a trust card", async () => {
    for (const q of ["book a restaurant reservation", "book a flight from SFO to JFK", "order a pizza"]) {
      const r = (await req(`${API}/v1/skills/find?q=${encodeURIComponent(q)}`)).json;
      assert(Array.isArray(r?.matches) && r.matches.length === 0, `"${q}" matched ${(r?.matches ?? []).map((s) => s.slug).join(", ")}`);
      assert(/no recently verified workflow/i.test(r.no_match?.message ?? ""), `"${q}": no no_match message`);
    }
    for (const [q, slug] of [["dollars to yen", "x-rates-exchange-rate"], ["latest release of a rust crate", "crates-io-version"]]) {
      const r = (await req(`${API}/v1/skills/find?q=${encodeURIComponent(q)}&limit=10`)).json;
      assert(r?.matches?.[0]?.slug === slug, `"${q}" -> ${(r?.matches ?? []).map((s) => s.slug).join(", ") || "nothing"}, want ${slug}`);
      assert(r.matches.length <= 3, `"${q}": ${r.matches.length} results`);
      assert(r.matches[0].trust?.task && r.matches[0].trust?.runs_7d, `"${q}": no trust card`);
    }
    const c = (await req(`${API}/v1/workflows/check?task=${encodeURIComponent("order a pizza")}`)).json;
    assert(c?.verdict === "no_match" && c.executed === false && c.cost_usd === 0, `check_workflow pizza: ${c?.verdict}`);
    return "restaurant/flight/pizza: no match; dollars to yen, rust crate: first; check_workflow read-only";
  });

  await check("API /v1/benchmarks and /v1/benchmarks/latest (latest headline benchmark: verified and reuse cheaper; 204 when none)", async () => {
    const l = await req(`${API}/v1/benchmarks`);
    assert(l.status === 200 && Array.isArray(l.json?.benchmarks) && l.json?.method?.model_call, `/v1/benchmarks -> ${l.status}`);
    const r = await req(`${API}/v1/benchmarks/latest`);
    const verified = l.json.benchmarks.filter((b) => b.headline_eligible);
    if (r.status === 204) { assert(verified.length === 0, "latest is 204 but the list has a headline-eligible benchmark"); return l.json.benchmarks.length ? `no headline benchmark yet (${l.json.benchmarks.length} listed, none verified with reuse cheaper)` : "no benchmark yet"; }
    assert(r.json?.headline_eligible === true && r.json?.cid === verified[0]?.cid, "latest is not the newest headline-eligible benchmark");
    assert(r.status === 200 && r.json?.record?.type === "benchmark" && typeof r.json.headline === "string" && r.json.headline, `/v1/benchmarks/latest -> ${r.status}`);
    const b = r.json.record.body;
    assert(b.agents?.a?.did && b.agents?.b?.did && b.agents.a.did !== b.agents.b.did, "two distinct agent identities");
    for (const k of ["cold", "reuse"]) { const rec = await req(`${API}/v1/records/${b.runs[k].record}`); assert(rec.status === 200, `${k} run record -> ${rec.status}`); }
    return r.json.headline.slice(0, 120);
  });

  await check("API /v1/leaderboard: ranked identities, hardest tasks, the difficulty formula; only verified wins rank; non-independent identities labeled", async () => {
    const r = await req(`${API}/v1/leaderboard`);
    assert(r.status === 200 && Array.isArray(r.json?.entrants) && Array.isArray(r.json?.hardest_tasks) && Array.isArray(r.json?.tasks), `/v1/leaderboard -> ${r.status}`);
    const d = r.json;
    assert(typeof d.method?.formula === "string" && /f_cold/.test(d.method.formula), "difficulty formula missing");
    const ranked = d.entrants.filter((e) => e.ranked);
    ranked.forEach((e, i) => assert(e.rank === i + 1, `rank order broken at ${e.name}`));
    for (const e of d.entrants) {
      assert(typeof e.label === "string" && e.label, `${e.key} has no label`);
      assert(e.independent === (e.kind === "agent"), `${e.key} independent flag wrong`);
      if (e.kind === "anonymous") assert(!e.ranked, "anonymous public trials are ranked");
      if (/^demo-/i.test(e.name ?? "")) assert(e.kind === "demo", `${e.name} not labeled DEMO`);
      for (const w of e.wins ?? []) if (w.ranked) assert(w.status === "verified", `${e.name}: a ${w.status} win is ranked`);
    }
    for (const t of d.tasks) assert(t.difficulty >= 1 && t.difficulty <= 5 && t.evidence && typeof t.evidence.attempts === "number", `task ${t.slug} difficulty/evidence shape`);
    assert(d.entrants.length > 0 && d.hardest_tasks.length > 0, "leaderboard is empty (backfill from verified runs missing)");
    const o = (await req(`${API}/openapi.json`)).json;
    assert(o?.paths?.["/v1/leaderboard"], "openapi has no /v1/leaderboard");
    return `${ranked.length} ranked, ${d.entrants.length - ranked.length} shown only, ${d.tasks.length} tasks, hardest ${d.hardest_tasks[0].slug} (${d.hardest_tasks[0].difficulty})`;
  });

  await check("API 404 for unknown routes", async () => {
    for (const p of ["/definitely-not-a-route", "/v1/definitely-not-a-route"]) {
      const r = await req(`${API}${p}`);
      assert(r.status === 404, `${p} -> ${r.status}`);
    }
  });
}

// A2A card and well-known files, on both hosts (the web host rewrites them to the API).
const hosts = [...(process.env.SKIP_API === "1" ? [] : [["API", API, ["/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/mcp.json", "/.well-known/mcp/server-card.json", "/.well-known/ai-catalog.json", "/llms.txt"]]]),
  ...(process.env.SKIP_WEB === "1" ? [] : [["web", WEB, ["/.well-known/agent-card.json", "/.well-known/mcp/server-card.json", "/.well-known/ai-catalog.json", "/llms.txt", "/llms-full.txt", "/sitemap.xml"]]])];
for (const [label, base, paths] of hosts) {
  await check(`${label} A2A agent card valid with provider.url`, async () => {
    const c = (await req(`${base}/.well-known/agent-card.json`)).json;
    assert(c, "not JSON");
    for (const k of ["name", "description", "version", "protocolVersion"]) assert(typeof c[k] === "string" && c[k], `${k} missing`);
    assert(isHttps(c.url) && c.url.endsWith("/a2a"), `url ${c.url}`);
    assert(isHttps(c.provider?.url), `provider.url ${c.provider?.url}`);
    assert(typeof c.provider?.organization === "string", "provider.organization");
    assert(Array.isArray(c.skills) && c.skills.length > 0 && c.skills.every((s) => s.id && s.name), "skills");
    assert(c.capabilities && typeof c.capabilities === "object", "capabilities");
    return `${c.name} ${c.version}, ${c.skills.length} skills`;
  });
  await check(`${label} well-known and discovery files`, async () => {
    const out = [];
    for (const p of paths) {
      const r = await req(`${base}${p}`);
      assert(r.status === 200, `${p} -> ${r.status}`);
      const ct = r.headers.get("content-type") || "";
      if (p.endsWith(".json")) assert(r.json && /json/.test(ct), `${p} not JSON (${ct})`);
      if (p.endsWith(".txt")) assert(/text\/plain/.test(ct) && /Agentboard/.test(r.text), `${p} (${ct})`);
      if (p.endsWith(".xml")) assert(/xml/.test(ct) && /<urlset/.test(r.text), `${p} not a sitemap`);
      assert(!/<div id="root">/.test(r.text), `${p} returned the SPA shell`);
      out.push(p.replace("/.well-known/", ""));
    }
    return out.join(" ");
  });
}

if (process.env.SKIP_WEB !== "1") {
  const home = await req(`${WEB}/`).catch(() => undefined);
  const homeTitle = home?.text.match(/<title>([^<]*)<\/title>/)?.[1];

  await check("web pages render the app (/, /board, /skills, /governance, /docs, /benchmark, /leaderboard)", async () => {
    assert(home?.status === 200 && /<div id="root">/.test(home.text), "home is not the app shell");
    for (const p of ["/board", "/skills", "/governance", "/docs", "/skills/metrics", "/benchmark", "/leaderboard"]) {
      const r = await req(`${WEB}${p}`);
      assert(r.status === 200, `${p} -> ${r.status}`);
      assert(/<div id="root">/.test(r.text) && /<script[^>]+src="\/assets\//.test(r.text), `${p} is not the app shell`);
    }
    const js = home.text.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert(js, "no script asset in index.html");
    const asset = await req(`${WEB}${js}`);
    assert(asset.status === 200 && /javascript/.test(asset.headers.get("content-type") || ""), `asset ${js} -> ${asset.status}`);
    return `title "${homeTitle}"`;
  });

  await check("web /leaderboard is readable without JS (server-rendered top entries, labeled, JSON linked)", async () => {
    const r = await req(`${WEB}/leaderboard`);
    assert(r.status === 200, `/leaderboard -> ${r.status}`);
    assert(/data-ssr="leaderboard"/.test(r.text), "no server-rendered board in #root");
    assert(/#1 [^<]+<\/b>/.test(r.text), "no ranked entry in the HTML (API slow? it falls back to a pointer)");
    assert(r.text.includes("/v1/leaderboard"), "no link to /v1/leaderboard");
    return r.text.match(/<b>(#1 [^<]+)<\/b>/)?.[1] ?? "";
  });

  await check("web /skills/<slug> serves the real skill page, not the homepage", async () => {
    const sm = (await req(`${WEB}/sitemap.xml`)).text;
    const slugs = [...sm.matchAll(/\/skills\/([a-z0-9][a-z0-9-]*)<\/loc>/g)].map((m) => m[1]).filter((s) => !["metrics", "reuse"].includes(s));
    assert(slugs.length > 0, "no skill slugs in the sitemap");
    const slug = slugs[0];
    const r = await req(`${WEB}/skills/${slug}`);
    assert(r.status === 200, `/skills/${slug} -> ${r.status}`);
    const title = r.text.match(/<title>([^<]*)<\/title>/)?.[1];
    assert(title && title !== homeTitle, `title is the homepage's ("${title}")`);
    assert(r.text.includes(`/skills/${slug}"`), "canonical does not name the slug");
    const md = await req(`${WEB}/skills/${slug}.md`);
    assert(md.status === 200 && /^# /.test(md.text), `/skills/${slug}.md -> ${md.status}`);
    return `${slug}: "${title}"`;
  });

  await check("web 404 for unknown paths and unknown skills", async () => {
    for (const p of ["/definitely-not-a-page", "/skills/definitely-not-a-skill-xyz"]) {
      const r = await req(`${WEB}${p}`);
      assert(r.status === 404, `${p} -> ${r.status}`);
      const title = r.text.match(/<title>([^<]*)<\/title>/)?.[1];
      assert(title !== homeTitle, `${p} served the homepage ("${title}")`);
    }
  });

  await check("web security headers", async () => {
    const r = await req(`${WEB}/governance`);
    const csp = r.headers.get("content-security-policy") || "";
    assert(/default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp), `CSP: ${csp || "missing"}`);
    assert(r.headers.get("x-frame-options") === "DENY", "X-Frame-Options");
    assert(r.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options");
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed against API ${API} and web ${WEB}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Prod smoke: ${failed.length ? "FAILED" : "passed"}\n\n| check | result |\n|---|---|\n${results.map((r) => `| ${r.name} | ${r.ok ? "ok" : "**FAIL**"}${r.note ? `: ${String(r.note).replace(/\|/g, "\\|")}` : ""} |`).join("\n")}\n`);
}
process.exit(failed.length ? 1 : 0);
