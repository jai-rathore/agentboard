// "Try it now": a real public replay (POST /v1/skills/{slug}/public-replay, the HTTP form of the remote MCP try_skill)
// started from the browser, with live progress from GET /v1/skills/jobs/{id}. No token, no account. Capped per network
// and per day on the node. When a cap is hit (or the node answers with a cached verified run) it shows the latest
// verified signed run of the skill instead, clearly marked as not a new replay.
import { useEffect, useRef, useState } from "react";
import { sha256, leadingZeroBits } from "@agentboard/core";
import { API, get } from "./api";
import { Link } from "./App";
import { fmtDur } from "./skills";
import { modelName } from "./models";

type Status = { enabled: boolean; daily_cap: number; per_ip_per_day: number; remaining_today: number; skills: { slug: string; name?: string; eligible: boolean; params?: any[]; start_url?: string | null }[] };
type Cached = { reason: string; run?: string; page?: string; gif?: string | null; shot?: string | null; evidence?: string | null; model?: string | null; at?: string | null; kind?: string | null };
type Phase = { k: "idle" } | { k: "work"; msg: string } | { k: "live"; id: string } | { k: "cached"; c: Cached } | { k: "error"; msg: string };

/** Errors that mean "live replay is paused right now", answered with the latest verified run. */
const PAUSED = new Set(["public_replay_disabled", "public_replay_ip_limit", "public_replay_daily_cap", "node_run_quota", "muse_daily_cap", "muse_spend_cap", "muse_disabled", "executor_disabled"]);
const DONE = ["completed", "failed", "declined", "expired", "cancelled"];
const host = (u?: string | null) => { try { return u ? new URL(u).host : ""; } catch { return ""; } };
/** Next 00:00 UTC in the visitor's own time zone (the caps reset then). */
const resetAt = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZoneName: "short" }); };

/** Proof of work in small slices so the page stays responsive (16 bits is about 65k hashes). */
async function solvePow(ch: { nonce: string; bits: number; params_hash: string }, slug: string) {
  for (let n = 0; n < 50_000_000;) {
    const end = n + 4000;
    for (; n < end; n++) if (leadingZeroBits(sha256(`${ch.nonce}:${slug}:${ch.params_hash}:${n}`)) >= ch.bits) return n;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("no proof-of-work solution found");
}

/** The latest verified run of a skill (a replay, or the publishing run if no replay is verified yet). */
async function latestVerified(slug: string): Promise<Omit<Cached, "reason"> | null> {
  const r = await get<any>(`/v1/skills/reuse?skill=${encodeURIComponent(slug)}&limit=20`);
  const x = (r?.runs ?? []).find((y: any) => y.outcome === "verified");
  if (!x) return null;
  const d = await get<any>(`/v1/skills/runs/${x.run}`).catch(() => null);
  return { run: x.run, page: `/skills/runs/${x.run}`, gif: d?.evidence?.gif ?? null, shot: d?.evidence?.final_screenshot ?? null, evidence: x.evidence ?? d?.verdict?.evidence ?? null, model: d?.models?.verifier ?? d?.verdict?.model ?? null, at: x.at, kind: x.kind };
}

export function TryItNow({ slug: want, params: wantParams, title = true }: { slug?: string; params?: any[]; title?: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => { get<Status>("/v1/skills/public-replay").then(setSt, () => setSt(null)); }, []);
  const sk = st?.skills.find((s) => (want ? s.slug === want : s.eligible)) ?? (want ? { slug: want, eligible: true, params: wantParams } : undefined);
  const params = sk?.params ?? wantParams ?? [];
  if (!sk) return null;

  const fallback = async (reason: string, fromApi?: any) => {
    let c: Cached = { reason };
    if (fromApi?.run_record) c = { reason, run: fromApi.run_record, page: `/skills/runs/${fromApi.run_record}`, gif: fromApi.gif_url ?? null, shot: fromApi.final_screenshot_url ?? null, evidence: fromApi.verdict?.evidence ?? null, model: fromApi.verdict?.model ?? null, at: fromApi.verified_at ?? null, kind: fromApi.trigger ?? null };
    else { const l = await latestVerified(sk.slug).catch(() => null); if (l) c = { reason, ...l }; }
    setPhase({ k: "cached", c });
  };
  const call = async (body: unknown) => {
    const res = await fetch(`${API}/v1/skills/${sk.slug}/public-replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const start = async () => {
    try {
      const p = Object.fromEntries(params.map((x: any) => [x.name, (vals[x.name] ?? "").trim()]));
      setPhase({ k: "work", msg: "Checking today's budget…" });
      const first = await call({ params: p });
      if (first.body?.status === "cached") return fallback(first.body.reason?.message ?? first.body.message ?? "a daily cap was reached", first.body.cached_run);
      if (first.status !== 428) {
        if (PAUSED.has(first.body?.error)) return fallback(first.body.message ?? first.body.error);
        throw new Error(first.body?.message ?? `HTTP ${first.status}`);
      }
      setPhase({ k: "work", msg: `Solving a small proof of work in your browser (${first.body.challenge.bits} bits)…` });
      const counter = await solvePow(first.body.challenge, sk.slug);
      setPhase({ k: "work", msg: "Starting the replay…" });
      const r = await call({ params: p, challenge: { id: first.body.challenge.id, counter } });
      if (r.body?.status === "cached") return fallback(r.body.reason?.message ?? r.body.message ?? "a daily cap was reached", r.body.cached_run);
      if (r.status !== 202) {
        if (PAUSED.has(r.body?.error)) return fallback(r.body.message ?? r.body.error);
        throw new Error(r.body?.message ?? `HTTP ${r.status}`);
      }
      setPhase({ k: "live", id: r.body.id });
    } catch (e) { setPhase({ k: "error", msg: (e as Error).message }); }
  };
  const busy = phase.k === "work" || phase.k === "live";
  return <section className="try-now" aria-live="polite">
    {title && <h2>Try it now <span className="small muted">real replay, no sign-up</span></h2>}
    <p className="small try-what">Replays <Link to={`/skills/${sk.slug}`}><b>{sk.name ?? sk.slug}</b></Link>{sk.start_url ? <> live on <b>{host(sk.start_url)}</b> (a real site)</> : null}: an executor drives a headless browser with Muse Spark's computer tool, a Meta model checks the final screenshot, and the node signs the run.</p>
    {params.map((x: any) => <label key={x.name} className="small">{x.name} <span className="muted">e.g. {x.example}</span><input value={vals[x.name] ?? ""} disabled={busy} onChange={(e) => setVals({ ...vals, [x.name]: e.target.value })} /></label>)}
    {(phase.k === "idle" || phase.k === "error" || phase.k === "work") && <button className="btn primary try-btn" disabled={busy || params.some((x: any) => !(vals[x.name] ?? "").trim())} onClick={start}>{phase.k === "work" ? "Working…" : "▶ Try it now"}</button>}
    {phase.k === "work" && <p className="small muted">{phase.msg}</p>}
    {phase.k === "error" && <p className="err small">{phase.msg}</p>}
    {phase.k === "live" && <LiveJob id={phase.id} onStalled={(why) => fallback(why)} />}
    {phase.k === "cached" && <CachedRun c={phase.c} />}
    <p className="small muted try-caps">Capped: {st ? <>{st.per_ip_per_day} per network per day, {st.remaining_today} of {st.daily_cap} left on the node today (resets {resetAt()})</> : "a few per network per day"}. Only allowlisted skills that never submit, buy, send or delete. The same thing over MCP is <code>try_skill</code>.</p>
  </section>;
}

function LiveJob({ id, onStalled }: { id: string; onStalled: (why: string) => void }) {
  const [job, setJob] = useState<any>(null), [err, setErr] = useState("");
  const t0 = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let stop = false;
    const loop = async () => {
      try {
        const r = await fetch(`${API}/v1/skills/jobs/${id}`, { cache: "no-store" });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`);
        if (stop) return;
        setJob(j); setErr("");
        if (DONE.includes(j.status)) {
          // never reached the executor (busy or down): show the latest verified run instead of a bare failure
          if (j.status === "failed" && !(j.turns?.length) && !j.verdict) onStalled(j.message ?? "the executor could not start this run");
          return;
        }
      } catch (e) { if (!stop) setErr((e as Error).message); }
      if (!stop) setTimeout(loop, 1500);
    };
    loop();
    return () => { stop = true; };
  }, [id]);
  const done = job && DONE.includes(job.status);
  const turns = job?.turns?.length ?? 0;
  return <div className="try-live">
    <div className="try-progress small">
      <span className={`dot${done ? " still" : ""}`} aria-hidden="true" />
      <b>{job ? job.status.replace("_", " ") : "queued"}</b>
      <span className="muted">· {fmtDur(Date.now() - t0.current)}{turns ? ` · ${turns} browser turn${turns === 1 ? "" : "s"}` : ""}</span>
      <Link to={`/skills/r/${id}`} className="muted">live run page ↗</Link>
    </div>
    {!done && <p className="small muted">{job?.message ?? "Waking the executor"}{!turns && " (on a cold start the free-tier executor can take 30–60 s to wake up)"}</p>}
    {job?.frame_url ? <img className="media live try-frame" src={job.frame_url} alt="the executor's browser, live" /> : !done && <div className="try-frame placeholder small muted">waiting for the first browser frame…</div>}
    {job?.verdict && <div className={`verdict-box ${job.verdict.success ? "good" : "badv"}`}><p><b>{job.verdict.success ? "✓ Verified" : "✗ Not verified"}</b>{job.verdict.model ? <> by {modelName(job.verdict.model)}</> : null}: {job.verdict.evidence}</p></div>}
    {job?.run_record && <p className="small"><Link to={`/skills/runs/${job.run_record}`}><b>→ Signed run record</b></Link>: inputs, step screenshots, the verdict, the models and an in-browser Ed25519 signature check.</p>}
    {done && !job.run_record && job.status !== "completed" && <p className="small muted">{job.message}</p>}
    {err && <p className="err small">{err}</p>}
  </div>;
}

function CachedRun({ c }: { c: Cached }) {
  return <div className="try-cached">
    <p className="small"><b>Live replay is paused right now</b> <span className="muted">({c.reason})</span>. Caps reset at {resetAt()}.</p>
    {c.run ? <>
      <p className="small">Here is the <b>latest verified run</b> of this skill instead, {c.kind === "publish" ? "the run that verified the recording when the skill was published" : "a signed replay"}{c.at ? <>, from {new Date(c.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</> : null}. It is a cached run, not a new replay.</p>
      {(c.gif || c.shot) && <img className="media try-frame" src={c.gif ?? c.shot!} alt="steps of the latest verified run" />}
      {c.evidence && <div className="verdict-box good"><p><b>✓ Verified</b>{c.model ? <> by {modelName(c.model)}</> : null}: {c.evidence}</p></div>}
      <p className="small"><Link to={c.page!}><b>→ Signed run record</b></Link> (check its signature in your browser)</p>
    </> : <p className="small muted">No verified run of this skill is stored yet.</p>}
  </div>;
}
