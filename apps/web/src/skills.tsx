// Agentboard Skills: show it once, any MCP agent can reuse it.
// Record (video/screenshots -> Muse Spark -> strict-JSON skill), replay live in the executor (Muse Spark's
// computer tool driving headless Chromium), and read published, node-signed skills with their evidence.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { verifyRecord, entryHash, gatedSteps, effectiveRiskFlags, FLAG_LABELS, GATED_FLAGS, type SignedRecord } from "@agentboard/core";
import { API, EXECUTOR_WS, operatorFetch } from "./api";
import { Link, useData, short, ago } from "./App";
import { modelName, isOpenWeight } from "./models";
import { TryItNow } from "./tryit";

const DEMOS = [
  { name: "Acme Helpdesk (demo site)", url: `${location.origin}/demo/helpdesk/` },
  { name: "Acme Helpdesk: ticket status (demo site)", url: `${location.origin}/demo/helpdesk/status.html` },
  { name: "Bean There Coffee (demo site, mock store)", url: `${location.origin}/demo/shop/` },
  { name: "Bean There Coffee: cart (demo site, mock store)", url: `${location.origin}/demo/shop/cart.html` },
];
const art = (sha?: string | null) => (sha ? `${API}/v1/artifacts/${sha}` : "");
const go = (to: string) => { history.pushState(null, "", to); dispatchEvent(new PopStateEvent("popstate")); scrollTo(0, 0); };
const useToken = () => {
  const [t, set] = useState(() => localStorage.getItem("skills_token") ?? "");
  return [t, (v: string) => { localStorage.setItem("skills_token", v); set(v); }] as const;
};

/** Every model call is labelled with the model and the capability it used. */
export function ModelCall({ model, capability, extra }: { model?: string; capability: string; extra?: ReactNode }) {
  return <span className={`model-call${isOpenWeight(model) ? " open-weight" : ""}`} title={model}><b>{modelName(model)}</b> · {capability}{extra ? <> · {extra}</> : null}</span>;
}
const usd = (x?: number) => (typeof x === "number" ? `$${x.toFixed(4)}` : "");

const GATED = GATED_FLAGS as readonly string[];
function RiskFlags({ flags }: { flags: string[] }) {
  const real = flags.filter((f) => f !== "none");
  return <span className="risk">{real.map((f) => <span key={f} className={`flag ${GATED.includes(f) ? "gated" : ""}`} title={FLAG_LABELS[f]}>{GATED.includes(f) ? "⚠ " : ""}{f.replace("_", " ")}</span>)}{!real.length && <span className="flag">no risk flags</span>}</span>;
}

/** What will pause for a human, stated plainly. Flags come from the recorder AND from the steps' own words. */
export function Safety({ skill }: { skill: any }) {
  const gated = gatedSteps(skill);
  const flags = effectiveRiskFlags(skill);
  const inferred = flags.filter((f) => f !== "none" && !(skill.risk_flags ?? []).includes(f));
  return <div className={`safety ${gated.length ? "gated" : ""}`}>
    <div><b>Safety</b> <RiskFlags flags={flags} />{inferred.length > 0 && <span className="muted small"> ({inferred.map((f) => f.replace("_", " ")).join(", ")} inferred from the steps)</span>}</div>
    {gated.length ? <ul>{gated.map((g) => <li key={g.index}>🔒 Step {g.index + 1}, <b>{skill.steps[g.index].intent}</b>: {g.flags.map((f) => FLAG_LABELS[f]).join(", ")}. <b>Always waits for a human to approve</b>, in the web replay and through MCP <code>run_skill</code>.</li>)}</ul>
      : <p className="small muted">No step submits, buys, sends or deletes. The executor still stops for a human if a click lands on any such button.</p>}
  </div>;
}

export function SkillView({ skill, diff }: { skill: any; diff?: any[] }) {
  const gated = new Set(gatedSteps(skill).map((g) => g.index));
  return <div className="skill-view">
    <p className="summary">{skill.summary}</p>
    <Safety skill={skill} />
    <h2>Parameters</h2>
    <table className="tbl cards"><tbody>{skill.params.map((p: any) => <tr key={p.name}><td className="mono" data-label="param">{`{{${p.name}}}`}</td><td data-label="what">{p.description}</td><td className="muted" data-label="example">e.g. {p.example}</td></tr>)}</tbody></table>
    <h2>Steps</h2>
    <ol className="steps">{skill.steps.map((s: any, i: number) => <li key={i} className={diff?.[i] ? "changed" : ""}>{gated.has(i) && <span className="lock" title="waits for human approval">🔒</span>}<b>{s.intent}</b> <span className="act">{s.action}</span> <span className="muted">{s.target}</span>{s.value && <code>{s.value}</code>}{diff?.[i] && <span className="healed-tag">healed</span>}</li>)}</ol>
    <h2>Success check</h2><p>{skill.success_check}</p>
  </div>;
}

export const fmtDur = (ms?: number | null) => { if (ms == null) return "n/a"; if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`; const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min`; };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** Lead with human input: no clicks except approvals of risky steps. Show human-vs-agent wall clock only when the agent was faster. */
export function HumanInput({ approvals }: { approvals: number }) {
  return <span className="human-input"><b>👆 No human clicks</b> except approving risky steps (submit, buy, send, delete) · {plural(approvals, "approval")}</span>;
}
/** "real site" or "demo (mock site)": Agentboard's own /demo/ pages are never presented as real-world tools. */
export function SiteBadge({ kind }: { kind?: string }) {
  if (!kind) return null;
  return kind === "mock"
    ? <span className="badge site mock" title="Runs on an Agentboard demo page (a mock site we host), not a real-world site">demo (mock site)</span>
    : <span className="badge site real" title="Runs on a real public website">real site</span>;
}
const TRIGGER: Record<string, string> = { public: "public trigger (no token, capped)", agent: "an agent (signed, paid in credits)", operator: "the operator (token)", web: "the operator (web replay panel)", benchmark: "a reuse-benchmark agent (signed request, operator-funded)" };
export const triggerLabel = (t?: string) => TRIGGER[t ?? ""] ?? t ?? "unknown";
export function Faster({ recording, run }: { recording?: number | null; run?: number | null }) {
  if (recording == null || run == null || !(run < recording)) return null;
  return <span className="faster small"> · ⚡ agent {fmtDur(run)} vs {fmtDur(recording)} for the human</span>;
}
function TimeSaved({ t }: { t: any }) {
  if (!t) return null;
  return <span className="time"><HumanInput approvals={t.human_approvals ?? 0} /><Faster recording={t.recording_ms} run={t.run_ms} /></span>;
}

/** Field-by-field diff between two versions' steps, plus Spark's stated reasons. */
function StepDiff({ before, after, changes }: { before: any; after: any; changes: any[] }) {
  const n = Math.max(before.steps.length, after.steps.length);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = before.steps[i], b = after.steps[i];
    const fields = ["intent", "target", "action", "value"].filter((f) => (a?.[f] ?? "") !== (b?.[f] ?? ""));
    if (!fields.length) continue;
    rows.push(<tr key={i}><td data-label="step">step {i + 1}</td><td data-label="change">{fields.map((f) => <div key={f}><span className="muted small">{f}</span> <del>{a?.[f] ?? "(none)"}</del> → <ins>{b?.[f] ?? "(removed)"}</ins></div>)}</td><td className="small muted" data-label="why">{changes.filter((c) => c.step === i + 1).map((c) => c.reason).join("; ")}</td></tr>);
  }
  if (before.success_check !== after.success_check) rows.push(<tr key="sc"><td>success check</td><td><del>{before.success_check}</del> → <ins>{after.success_check}</ins></td><td /></tr>);
  return rows.length ? <table className="tbl diff cards"><tbody>{rows}</tbody></table> : <p className="muted small">No step changes.</p>;
}

// ---------------------------------------------------------------- list + record

/** "✓ 5 verified replays · all versions": the same count on the list, the home page and the skill page header. */
export const ReplaysBadge = ({ verified, big }: { verified: number; big?: boolean }) =>
  <span className={`badge${big ? " big" : ""}${verified ? "" : " none"}`} title="verified replays across every version of this skill, not counting the run that published it">{verified ? `✓ ${plural(verified, "verified replay")} · all versions` : "no replays yet"}</span>;

export function SkillList({ skills }: { skills: any[] }) {
  if (!skills.length) return <p className="muted">No verified skills yet.</p>;
  return <ul className="posts">{skills.map((s: any) => <li key={s.cid}>
    <Link to={`/skills/${s.slug}`}>{s.name}</Link> <SiteBadge kind={s.site_kind} /> <ReplaysBadge verified={s.verified_replays ?? 0} />{s.public_replay && <span className="badge try">try it: public replay</span>}
    <div className="meta">v{s.version} · {s.slug} · {ago(s.created_at)}</div><p className="snippet">{s.summary}</p></li>)}</ul>;
}

/** One-line live metrics (same numbers as /skills/metrics). Replays never count a skill's publishing run. */
export function MetricsStrip() {
  const r = useData<any>("/v1/skills/metrics");
  if (!r.data) return null;
  const m = r.data;
  return <div className="stats metrics strip">
    <div><b>{m.skills}</b><span>skills ({m.skills_by_site?.real ?? 0} real site, {m.skills_by_site?.mock ?? 0} demo)</span></div>
    <div><b>{m.replays?.total ?? 0}</b><span>replays</span></div>
    <div><b>{m.replays?.real_site ?? 0}</b><span>on real sites</span></div>
    <div><b>{m.replays?.mock_site ?? 0}</b><span>on demo (mock) sites</span></div>
    <div><b>{m.heals}</b><span>self-heals</span></div>
    <div><b>${m.muse.usd.toFixed(2)}</b><span>Muse spend, all time</span></div>
  </div>;
}

export function SkillsPage({ q }: { q: string }) {
  const r = useData<any>(`/v1/skills${q ? `?q=${encodeURIComponent(q)}` : ""}`, [q]);
  const [query, setQuery] = useState(q);
  return <div className="grid">
    <section>
      <h1>Skills <span className="muted small">show it once, any MCP agent can reuse it</span></h1>
      <p className="small"><Link to="/skills/metrics">metrics</Link> · <Link to="/skills/reuse">agent reuse</Link></p>
      <p className="muted">Recorded once by a person, written by Muse Spark, verified on replay. Skills marked <SiteBadge kind="mock" /> run on our own demo pages, not real-world sites. <Link to="/docs">How it works →</Link></p>
      <MetricsStrip />
      <div className="search"><input value={query} placeholder="Search skills…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(`/skills${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`); }} /></div>
      {r.loading ? <p className="muted">Loading…</p> : r.error ? <p className="err">{r.error}</p> : <SkillList skills={r.data.skills} />}
      <p className="muted small">Agents find skills with <code>GET {API}/v1/skills?q=…</code> and read one with <code>/v1/skills/&lt;cid&gt;</code>.</p>
    </section>
    <aside><RecordPanel /></aside>
  </div>;
}

async function downscaleImage(file: Blob, maxW = 960): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const w = Math.min(maxW, bmp.width), h = Math.round(bmp.height * (w / bmp.width));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.75));
}

/** Long videos: sample frames in the browser (2 fps, 640 px, at most 24) so Muse gets small JPEGs. */
async function sampleVideo(file: File, fps = 2, width = 640, max = 24): Promise<Blob[]> {
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("cannot read this video")); });
  const n = Math.max(1, Math.min(max, Math.ceil(v.duration * fps)));
  const c = document.createElement("canvas"); c.width = width; c.height = Math.round(v.videoHeight * (width / v.videoWidth));
  const out: Blob[] = [];
  for (let i = 0; i < n; i++) {
    v.currentTime = Math.min(v.duration - 0.05, (i + 0.5) * (v.duration / n));
    await new Promise((res) => { v.onseeked = res; });
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    out.push(await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.7)));
  }
  URL.revokeObjectURL(v.src);
  return out;
}

function RecordPanel() {
  const [token, setToken] = useToken();
  const [files, setFiles] = useState<File[]>([]);
  const [startUrl, setStartUrl] = useState(DEMOS[0].url);
  const [hint, setHint] = useState("");
  const [parent, setParent] = useState("");
  const [status, setStatus] = useState(""), [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const upload = async (b: Blob, type: string) => (await operatorFetch<any>("/v1/artifacts", { method: "POST", token, headers: { "content-type": type }, body: b })).sha256 as string;
  const run = async () => {
    setErr(""); setBusy(true);
    try {
      const video = files.find((f) => f.type === "video/mp4");
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!video && !images.length) throw new Error("choose an .mp4 or screenshots");
      if (video && video.size > 20 * 1048576) throw new Error("videos up to 20 MB (trim or re-encode at 640 px)");
      let videoSha: string | undefined; let frames: string[] = [];
      if (video) {
        setStatus("Uploading video…"); videoSha = await upload(video, "video/mp4");
        if (video.size > 2_800_000) { setStatus("Sampling frames (2 fps, 640 px)…"); const fr = await sampleVideo(video); setStatus(`Uploading ${fr.length} frames…`); for (const f of fr) frames.push(await upload(f, "image/jpeg")); }
      } else {
        for (const [i, f] of images.slice(0, 24).entries()) { setStatus(`Uploading screenshot ${i + 1}/${Math.min(24, images.length)}…`); frames.push(await upload(await downscaleImage(f), "image/jpeg")); }
      }
      setStatus(`Muse Spark is reading the ${frames.length && !video ? "screenshots" : frames.length ? "sampled frames" : "video"}…`);
      const d = await operatorFetch<any>("/v1/skills/record", { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ video: videoSha, frames, start_url: startUrl, hint: hint || undefined, parent_slug: parent || undefined }) });
      go(`/skills/d/${d.id}`);
    } catch (e) { setErr((e as Error).message); setStatus(""); } finally { setBusy(false); }
  };
  return <div className="panel">
    <h2>Record a skill</h2>
    <label>Operator token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="needed to record (Muse calls cost money)" /></label>
    <label>Recording (.mp4, or screenshots in order)<input type="file" accept="video/mp4,image/png,image/jpeg" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).sort((a, b) => a.name.localeCompare(b.name)))} /></label>
    <label>Start URL<input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} /></label>
    <div className="small muted">Demo sites: {DEMOS.map((d) => <a key={d.url} href={d.url} target="_blank" rel="noreferrer" style={{ marginRight: 8 }}>{d.name}</a>)}</div>
    <label>What is the task? (optional)<input value={hint} onChange={(e) => setHint(e.target.value)} placeholder="e.g. file a support ticket" /></label>
    <label>New version of (slug, optional)<input value={parent} onChange={(e) => setParent(e.target.value)} placeholder="create-a-helpdesk-ticket" /></label>
    <button disabled={busy || !token} onClick={run}>{busy ? "Working…" : "Turn it into a skill"}</button>
    {status && <p className="muted small">{status}</p>}{err && <p className="err small">{err}</p>}
    <p className="small muted">Uploads go straight to the Agentboard API (not through Vercel, so no 4.5 MB limit). Videos over 2.8 MB are sampled into frames in your browser.</p>
  </div>;
}

// ---------------------------------------------------------------- draft + live replay

export function DraftPage({ id }: { id: string }) {
  const r = useData<any>(`/v1/skills/drafts/${id}`, [id]);
  if (r.loading) return <p className="muted">Loading…</p>;
  if (r.error) return <p className="err">{r.error}</p>;
  const d = r.data;
  return <article>
    <div className="crumbs"><Link to="/skills">skills</Link> / draft</div>
    <h1>{d.skill.name} <span className="draft-tag">{d.published_cid ? "published" : "draft: not yet verified"}</span></h1>
    {d.published_cid && <p><Link to={`/s/${d.published_cid}`}>→ published skill</Link></p>}
    <div className="calls"><ModelCall model={d.model} capability={`recorded with ${d.capability}`} extra={<>{d.usage.input_tokens} in / {d.usage.output_tokens} out tokens · {usd(d.usage.usd)}</>} /></div>
    {d.reasoning_summary && <div className="reasoning"><b>Muse's reasoning summary</b><p>{d.reasoning_summary}</p></div>}
    <div className="sbs">
      <div><h2>Source</h2><Source source={d.source} /></div>
      <div><h2>Replay</h2><ReplayPanel target={{ draft_id: d.id }} skill={d.skill} startUrl={d.source.start_url ?? d.skill.start_url_hint} /></div>
    </div>
    <SkillView skill={d.skill} />
    {d.runs.length > 0 && <><h2>Unverified attempts</h2><ul className="posts">{d.runs.map((x: any, i: number) => <li key={i}>✗ {x.verdict.evidence} <span className="muted small">{ago(x.at)}</span>{x.evidence?.gif && <> · <a href={art(x.evidence.gif)} target="_blank" rel="noreferrer">GIF</a></>}</li>)}</ul></>}
  </article>;
}

function Source({ source }: { source: any }) {
  if (source.video) return <video className="media" src={art(source.video)} controls muted playsInline />;
  if (source.frames?.length) return <Frames shas={source.frames} />;
  return <p className="muted">No source media.</p>;
}
function Frames({ shas }: { shas: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % shas.length), 900); return () => clearInterval(t); }, [shas.length]);
  return <div><img className="media" src={art(shas[i])} alt={`frame ${i + 1}`} /><div className="muted small">frame {i + 1}/{shas.length}</div></div>;
}

const fmtClock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
type Turn = { turn: number; say: string; actions: any[]; fn: any; ms: number; usage: any; model: string; capability: string };
function ReplayPanel({ target, skill, startUrl }: { target: { draft_id?: string; skill_cid?: string }; skill: any; startUrl: string }) {
  const [token, setToken] = useToken();
  const [params, setParams] = useState<Record<string, string>>(() => Object.fromEntries(skill.params.map((p: any) => [p.name, p.example])));
  const [url, setUrl] = useState(startUrl);
  const [frame, setFrame] = useState(""), [status, setStatus] = useState(""), [err, setErr] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]), [usage, setUsage] = useState<any>(null);
  const [approval, setApproval] = useState<any>(null), [verdict, setVerdict] = useState<any>(null), [result, setResult] = useState<any>(null);
  const ws = useRef<WebSocket | null>(null);
  useEffect(() => () => ws.current?.close(), []);
  // step counter + elapsed clock for the live run (max turns comes from the executor's /healthz)
  const [maxTurns, setMaxTurns] = useState(15), [t0, setT0] = useState(0), [t1, setT1] = useState(0), [running, setRunning] = useState(false);
  useEffect(() => { if (!running) return; const i = setInterval(() => setT1(Date.now()), 250); return () => clearInterval(i); }, [running]);
  const start = async () => {
    setErr(""); setTurns([]); setVerdict(null); setResult(null); setFrame(""); setUsage(null);
    setT0(Date.now()); setT1(Date.now()); setRunning(true);
    setStatus("Waking the executor (a free Render service; up to a minute)…");
    try { const h = await (await fetch(EXECUTOR_WS.replace(/^ws/, "http") + "/healthz", { cache: "no-store" })).json(); if (h?.max_turns) setMaxTurns(Number(h.max_turns)); } catch { /* the socket attempt reports errors */ }
    const s = new WebSocket(`${EXECUTOR_WS}/run`);
    ws.current = s;
    s.onopen = () => { setStatus("Connected. Starting Chromium…"); s.send(JSON.stringify({ type: "start", token, ...target, start_url: url, params })); };
    s.onerror = () => { setErr("Could not reach the executor."); setRunning(false); };
    s.onclose = () => { setRunning(false); setApproval(null); setStatus((x) => (x.startsWith("Done") ? x : x ? `${x} (connection closed)` : "")); };
    s.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "done" || m.type === "error" || m.type === "turn") setApproval(null);
      if (m.type === "frame") setFrame(`data:image/jpeg;base64,${m.jpeg}`);
      else if (m.type === "status") setStatus(m.message);
      else if (m.type === "turn") setTurns((t) => [...t, m]);
      else if (m.type === "usage") setUsage(m.usage);
      else if (m.type === "approval_request") { setApproval(m); setStatus("Waiting for your approval…"); }
      else if (m.type === "verdict") setVerdict(m);
      else if (m.type === "healing") setStatus(m.message);
      else if (m.type === "done") { setRunning(false); setResult(m.result); setStatus(`Done: ${m.result.status.replace(/_/g, " ")}`); }
      else if (m.type === "error") { setRunning(false); setErr(`${m.error}: ${m.message}`); }
    };
  };
  const answer = (ok: boolean) => { ws.current?.send(JSON.stringify({ type: "approval", id: approval.id, approve: ok })); setApproval(null); setStatus(ok ? "Approved, continuing…" : "Declined."); };
  return <div className="replay">
    {!frame && <div className="params">
      {skill.params.map((p: any) => <label key={p.name}>{p.name}<input value={params[p.name] ?? ""} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} /></label>)}
      <label>Start URL<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      {/\/demo\/helpdesk\//.test(url) && <div className="small muted">Demo layout: <a href="#" onClick={(e) => { e.preventDefault(); setUrl(url.replace(/\?.*$/, "")); }}>classic</a> · <a href="#" onClick={(e) => { e.preventDefault(); setUrl(url.replace(/\?.*$/, "") + "?v=2"); }}>redesigned (?v=2, shows self-healing)</a></div>}
      <label>Operator token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <button disabled={!token} onClick={start}>Replay &amp; verify</button>
    </div>}
    {t0 > 0 && <div className="run-clock"><span>Step <b>{turns.length}</b> / {maxTurns}</span><span>⏱ <b>{fmtClock(t1 - t0)}</b>{running ? "" : " total"}</span>{approval && <span className="paused">⏸ waiting for approval</span>}</div>}
    {frame && <img className="media live" src={frame} alt="live browser" />}
    {status && <p className="muted small">{status}{usage && <> · {usage.calls} Muse calls · {usd(usage.usd)}</>}</p>}
    {err && <p className="err small">{err}</p>}
    {approval && <div className="approval">
      <b>Approve this action?</b> <span className="muted">{approval.reason}</span>
      <img className="media" src={`data:image/jpeg;base64,${approval.screenshot}`} alt="before the action" />
      <div><button onClick={() => answer(true)}>Approve</button> <button className="secondary" onClick={() => answer(false)}>Decline</button></div>
    </div>}
    {turns.length > 0 && <ol className="turns">{turns.map((t) => <li key={t.turn}>
      <ModelCall model={t.model} capability={t.capability} extra={<>{t.ms} ms · {usd(t.usage?.usd)}</>} />
      <div>{t.say}</div>
      <div className="mono small">{t.actions.map((a) => JSON.stringify(a)).join(" ")}{t.fn ? ` ${t.fn.name}(${t.fn.arguments})` : ""}</div></li>)}</ol>}
    {verdict && <div className={`verdict-box ${verdict.success ? "good" : "badv"}`}><ModelCall model={verdict.model} capability={`verified with ${verdict.capability}`} /><p>{verdict.success ? "✓ Success" : "✗ Not verified"}: {verdict.evidence}</p></div>}
    <RunResult result={result} />
  </div>;
}

function RunResult({ result }: { result: any }) {
  if (!result?.skill_cid) return null;
  return <div className="run-result">
    <p><Link to={`/s/${result.skill_cid}`}>→ {result.status === "published" ? "Published skill" : "Skill page"}</Link> · run record log #{result.run_seq}</p>
    {result.time && <p><TimeSaved t={result.time} /></p>}
    {result.drift?.stale_steps?.length > 0 && !result.healed && <p className="small muted">Steps {result.drift.stale_steps.join(", ")} no longer matched the site{result.drift.error ? ` (healing failed: ${result.drift.error})` : " (only the latest version heals)"}.</p>}
    {result.healed && <div className="healed-box">🩹 <b>Self-healed.</b> The site changed, so Spark rewrote {result.healed.changes.length} step field{result.healed.changes.length === 1 ? "" : "s"} and the node published <Link to={`/s/${result.healed.cid}`}>v{result.healed.version}</Link> (log #{result.healed.seq}), linked to this run.</div>}
  </div>;
}

// ---------------------------------------------------------------- runs started through MCP (run_skill)

export function JobPage({ id }: { id: string }) {
  const [job, setJob] = useState<any>(null), [err, setErr] = useState("");
  const [token, setToken] = useToken();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try { const r = await fetch(`${API}/v1/skills/jobs/${id}`, { cache: "no-store" }); const j = await r.json(); if (!r.ok) throw new Error(j.message ?? `HTTP ${r.status}`); if (!stop) setJob(j); if (["completed", "failed", "declined", "expired", "cancelled"].includes(j.status)) return; }
      catch (e) { if (!stop) setErr((e as Error).message); }
      if (!stop) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, [id]);
  const decide = async (approve: boolean) => {
    setBusy(true); setErr("");
    try { await operatorFetch(`/v1/skills/jobs/${id}/decision`, { method: "POST", token, headers: { "content-type": "application/json" }, body: JSON.stringify({ approval_id: job.approval.id, approve }) }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!job) return err ? <p className="err">{err}</p> : <p className="muted">Loading…</p>;
  const res = job.result;
  return <article>
    <div className="crumbs"><Link to="/skills">skills</Link> / run</div>
    <h1>Skill run <span className={`draft-tag st-${job.status}`}>{job.status.replace("_", " ")}</span></h1>
    <div className="meta"><span className="badge replay">Replay</span> {job.via === "public" ? <span className="badge try">trigger: public</span> : null} requested by {job.via === "agent" ? <>{job.agent ? <Link to={`/a/${job.agent}`}>an agent</Link> : "an agent"} (signed, paid in credits) through MCP <code>run_skill</code></> : job.via === "public" ? <>the public trigger (no token; capped, allowlisted non-destructive skills only)</> : <>the operator through MCP <code>run_skill</code></>} · <Link to={`/s/${job.skill_cid}`}>skill</Link> · started {ago(job.created_at)}</div>
    {res && <ReturnedValue answer={res.answer} calls={res.usage?.calls} mode={res.replay?.mode} binding={job?.value_binding} />}
    {job.run_record && <p><Link to={`/skills/runs/${job.run_record}`}>→ Signed run record and evidence</Link></p>}
    <p className="small mono">{Object.entries(job.params).map(([k, v]) => `${k}=${v}`).join(" · ")} · {job.start_url}</p>
    {job.status === "pending_approval" && job.approval && <div className="approval big">
      <b>⏸ A human must approve this step.</b> <span>{job.approval.reason}</span>
      <p className="small muted">The agent that asked for this run cannot approve it. Only someone with the operator token can, here.</p>
      <label>Operator token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <div><button disabled={!token || busy} onClick={() => decide(true)}>Approve</button> <button className="secondary" disabled={!token || busy} onClick={() => decide(false)}>Decline</button></div>
    </div>}
    {job.message && <p className="muted small">{job.message}</p>}
    {err && <p className="err small">{err}</p>}
    <div className="sbs">
      <div>{job.frame_url ? <img className="media live" src={job.frame_url} alt="executor browser" /> : <p className="muted">Waiting for the first frame…</p>}</div>
      <div>
        {job.verdict && <div className={`verdict-box ${job.verdict.success ? "good" : "badv"}`}><ModelCall model={job.verdict.model} capability={`verified with ${job.verdict.capability}`} /><p>{job.verdict.success ? "✓ Success" : "✗ Not verified"}: {job.verdict.evidence}</p></div>}
        <RunResult result={res} />
        {job.turns.length > 0 && <ol className="turns">{job.turns.map((t: any) => <li key={t.turn}><ModelCall model={t.model} capability={t.capability ?? "computer use"} extra={<>{t.ms} ms · {usd(t.usd)}</>} /><div>{t.say}</div><div className="mono small">{(t.actions ?? []).map((a: any) => JSON.stringify(a)).join(" ")}{t.fn ? ` ${t.fn.name}(${t.fn.arguments})` : ""}</div></li>)}</ol>}
      </div>
    </div>
  </article>;
}

// ---------------------------------------------------------------- published skill

async function sha256Hex(bytes: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

export function SignatureCheck({ entries }: { entries: { seq: number; log: { prev_hash: string; entry_hash: string }; record: SignedRecord }[] }) {
  const [res, setRes] = useState<string[] | null>(null);
  const check = async () => {
    const out: string[] = [];
    for (const e of entries) {
      const v = verifyRecord(e.record);
      const chain = entryHash(e.log.prev_hash, e.seq, e.record.cid) === e.log.entry_hash;
      out.push(`${v.ok ? "✓" : "✗"} ${e.record.type} #${e.seq}: ${v.ok ? "Ed25519 signature + content id valid" : v.error}; ${chain ? "✓ log entry hash matches" : "✗ log entry hash mismatch"}`);
      const ev = (e.record.body as any).evidence;
      for (const [k, sha] of Object.entries(ev ?? {})) {
        if (!sha) continue;
        const got = await sha256Hex(await (await fetch(art(sha as string))).arrayBuffer());
        out.push(`  ${got === sha ? "✓" : "✗"} ${k.replace("_", " ")} bytes hash to the signed sha256`);
      }
    }
    setRes(out);
  };
  return <div className="sigcheck"><button onClick={check}>Check signatures in my browser</button>{res && <pre className="mono small">{res.join("\n")}</pre>}</div>;
}

const secs = (ms?: number | null) => (ms == null ? "unknown" : `${Math.round(ms / 100) / 10} s`);
const dollars = (x?: number | null) => (x == null ? "unknown" : `$${x.toFixed(4)}`);
/** The trust card (GET /v1/skills/:cid .trust, the same as find_skill's): computed from the signed records only. */
export function TrustCard({ t }: { t: any }) {
  const reuse = typeof t.time_cost?.reuse === "object" ? t.time_cost.reuse : null, cold = typeof t.time_cost?.cold === "object" ? t.time_cost.cold : null;
  const id = t.identities ?? {};
  return <div className="panel trust-card">
    <h2>Trust card</h2>
    <table className="tbl small"><tbody>
      <tr><th>Site / task</th><td>{t.site} ({t.site_kind}) · {t.task}</td></tr>
      <tr><th>Inputs</th><td className="mono">{Object.keys(t.input_schema ?? {}).join(", ") || "none"}</td></tr>
      <tr><th>Example (real run)</th><td>{typeof t.example === "object" ? <><span className="mono">{JSON.stringify(t.example.input)}</span> → <b>{String(t.example.output ?? "(no value)")}</b> <Link to={`/skills/runs/${t.example.run}`}>run</Link></> : t.example}</td></tr>
      <tr><th>Last verified run</th><td>{typeof t.last_verified_run === "object" ? <><Link to={`/skills/runs/${t.last_verified_run.run}`}>{ago(t.last_verified_run.at)}</Link></> : t.last_verified_run}</td></tr>
      <tr><th>Runs, 7 / 30 days</th><td>{t.runs_7d.verified} verified, {t.runs_7d.failed} failed / {t.runs_30d.verified} verified, {t.runs_30d.failed} failed</td></tr>
      <tr><th>Latest failure</th><td>{typeof t.latest_failure === "object" ? <><span className="mono">{JSON.stringify(t.latest_failure.input)}</span>: {t.latest_failure.reason} <Link to={`/skills/runs/${t.latest_failure.run}`}>run</Link></> : t.latest_failure}</td></tr>
      <tr><th>Distinct inputs tested</th><td>{t.distinct_inputs_tested.total} ({t.distinct_inputs_tested.verified} verified)</td></tr>
      <tr><th>Who ran it</th><td>operator (house): {id.operator_house?.runs ?? 0} runs{(id.own_agents ?? []).map((a: any) => <span key={a.did}> · {a.name}: {a.runs} runs <span className="badge house" title={a.label}>own agent, not independent</span></span>)} · seeded benchmark identities: {id.seeded_benchmark?.identities ?? 0} ({id.seeded_benchmark?.runs ?? 0} runs) · anonymous public: {id.anonymous_public?.runs ?? 0} runs · <b>independent agents: {id.independent_agents?.identities ?? 0}</b></td></tr>
      <tr><th>Time and cost</th><td>reuse: {reuse ? `median ${secs(reuse.median_ms)}, ${reuse.median_model_calls} model calls, ${dollars(reuse.median_usd)} (${reuse.verified_runs} verified replays)` : String(t.time_cost?.reuse)} · cold: {cold ? `median ${secs(cold.median_ms)}, ${cold.median_model_calls} model calls, ${dollars(cold.median_usd)} (${cold.benchmarks} benchmark${cold.benchmarks === 1 ? "" : "s"})` : String(t.time_cost?.cold)}</td></tr>
      <tr><th>Who pays</th><td>{t.time_cost?.who_pays}</td></tr>
      <tr><th>Login · actions · approvals</th><td>login: {t.login_required} · {t.actions} · approvals: {Array.isArray(t.approvals) ? t.approvals.join("; ") : t.approvals}</td></tr>
      <tr><th>Runs where · visibility</th><td>{t.runs_where} · {t.visibility}</td></tr>
      <tr><th>If it fails</th><td>{t.on_failure}</td></tr>
      <tr><th>Don't use it for</th><td>{(t.when_not_to_use ?? []).join("; ")}</td></tr>
    </tbody></table>
  </div>;
}

export function SkillPage({ cid }: { cid: string }) {
  const r = useData<any>(`/v1/skills/${cid}`, [cid]);
  if (r.loading) return <p className="muted">Loading…</p>;
  if (r.error) return <p className="err">{r.error}</p>;
  const { skill, versions, runs, badge, version, latest_version, latest_cid, node, prev_skill, heal_run, time } = r.data;
  const b = skill.record.body;
  const hf = b.healed_from;
  const ok = (x: any) => Boolean(x?.verified ?? x?.record?.body?.success); // verified: checks passed AND value tied to inputs
  const last = runs.find(ok) ?? runs[0] ?? heal_run;
  const lb = last?.record.body;
  const diffIdx = prev_skill && hf ? b.skill.steps.map((st: any, i: number) => JSON.stringify(st) !== JSON.stringify(prev_skill.skill.steps[i])) : undefined;
  const faster = (rb: any) => Boolean(rb.success && rb.time?.recording_ms != null && rb.time.run_ms != null && rb.time.run_ms < rb.time.recording_ms);
  const anyFaster = runs.some((x: any) => faster(x.record.body));
  return <article>
    <div className="crumbs"><Link to="/skills">skills</Link> / {b.slug}</div>
    <h1>{b.skill.name} <SiteBadge kind={r.data.site_kind} /> <ReplaysBadge big verified={r.data.reuse?.verified_replays ?? 0} />{hf && <span className="badge big heal">🩹 self-healed</span>}</h1>
    {r.data.site_kind === "mock" && <p className="small demo-note">This skill runs on an Agentboard demo page (a mock site we host to show the mechanism). It is not a real-world tool.</p>}
    <p className="small replay-counts"><b>{plural(r.data.reuse?.replays ?? 0, "replay")}</b> so far ({r.data.reuse?.verified_replays ?? 0} verified, {r.data.reuse?.new_input_replays ?? 0} with new inputs) · <b>{badge.verified_runs_all_versions} of {badge.runs_all_versions ?? badge.verified_runs_all_versions}</b> signed runs verified{badge.versions > 1 ? ` across v1–v${latest_version}` : ""}, including the run that published the skill, which never counts as a replay.{heal_run && !runs.some((x: any) => x.record.cid === heal_run.record.cid) && <> This version was first verified by the v{prev_skill?.version} run that healed it.</>}</p>
    {version !== latest_version && <div className="superseded">This is v{version}. <Link to={`/s/${latest_cid}`}>v{latest_version} is the current version →</Link></div>}
    <div className="meta">v{version} · published {ago(skill.record.created_at)} · log #{skill.seq} · signed by node <span className="mono">{short(node)}</span></div>
    {r.data.trust && <TrustCard t={r.data.trust} />}
    <div className="calls">
      <ModelCall model={b.recorder.model} capability={`recorded with ${b.recorder.capability}`} extra={usd(b.recorder.usage?.usd)} />
      {lb && <ModelCall model={lb.loop.model} capability={`replayed with ${lb.loop.capability}`} extra={`${lb.turns} turns · ${usd(lb.usage.usd)}`} />}
      {lb && <ModelCall model={lb.verdict.model} capability={`verified with ${lb.verdict.capability}`} />}
      {hf && <ModelCall model={hf.model} capability={hf.capability} extra={usd(hf.usage?.usd)} />}
    </div>
    {time && <p className="time-line"><HumanInput approvals={time.approvals_per_run ?? 0} /> per replay: the agent does every click and keystroke; a human only approves 🔒 steps.{time.verified_runs > 0 && <> {plural(time.verified_runs, "verified run")} of this version so far.</>}{time.agent_faster && <> ⚡ Fastest verified run {fmtDur(time.fastest_run_ms)} vs {fmtDur(time.recording_ms)} for the human who recorded it.</>}</p>}
    {hf && prev_skill && <div className="healed-box">
      <b>🩹 Self-healed from <Link to={`/s/${hf.skill}`}>v{prev_skill.version}</Link></b> after {heal_run ? <>run log #{heal_run.seq}</> : "a verified run"} on {heal_run?.record.body.start_url}: steps {hf.stale_steps.join(", ")} no longer matched the site{hf.reported?.length ? `, and the agent reported: ${hf.reported.map((x: any) => `step ${x.step}: ${x.observed}`).join("; ")}` : ""}. {hf.kind === "trace" ? <>The recorded trace failed at that step ({hf.failed_reason}); the model recovered from there and this version stores the recovered run's trace, so the next replay is deterministic again. No extra model call.</> : <>Spark re-read the screen and rewrote them; the run's final screenshot verified the result.</>}
      <StepDiff before={prev_skill.skill} after={b.skill} changes={hf.changes} />
      {hf.reasoning_summary && <div className="reasoning"><b>Muse's reasoning summary (healing)</b><p>{hf.reasoning_summary}</p></div>}
    </div>}
    {b.recorder.reasoning_summary && <div className="reasoning"><b>Muse's reasoning summary (recording)</b><p>{b.recorder.reasoning_summary}</p></div>}
    <div className="sbs">
      <div><h2>Shown once (source)</h2><Source source={b.source} /></div>
      <div><h2>Replayed by an agent</h2>{lb?.evidence.gif ? <img className="media" src={art(lb.evidence.gif)} alt="replay GIF" /> : <p className="muted">No replay yet.</p>}
        {lb && <p className="small">{ok(last) ? "✓" : "✗"} {lb.verdict.evidence} <a href={art(lb.evidence.final_screenshot)} target="_blank" rel="noreferrer">final screenshot</a>{last === heal_run && " (the run that healed this version)"}</p>}</div>
    </div>
    <SkillView skill={b.skill} diff={diffIdx} />
    {r.data.public_replay && <div className="panel try-panel"><TryItNow slug={b.slug} params={b.skill.params} /></div>}
    <h2>Use it from an agent</h2>
    <pre className="mono small code-block">{`claude mcp add agentboard -- npx -y github:jai-rathore/agentboard
# then, in Claude Code or Cursor:
find_skill({ query: "${b.skill.name.toLowerCase()}" })
run_skill({ skill: "${b.slug}", params: ${JSON.stringify(Object.fromEntries(b.skill.params.map((p: any) => [p.name, p.example])))} })`}</pre>
    <p className="small muted">Runs from MCP pause at 🔒 steps with status <code>pending_approval</code> and a link to a page like this one, where a human approves. The agent never approves its own submit, buy, send or delete.</p>
    <h2>Replays</h2>
    <p className="small muted">Every replay of {b.slug}, all versions. The run that published the skill (the verification of the recording) is listed separately and not counted.</p>
    <ReuseTable skill={b.slug} limit={50} compact />
    <h2>Signed runs of this version, v{version} ({runs.length})</h2>
    <table className="tbl cards"><thead><tr><th></th><th>params</th><th>turns</th><th>human input</th>{anyFaster && <th>vs human</th>}<th>cost</th><th>when</th></tr></thead><tbody>
      {runs.map((x: any) => { const rb = x.record.body; return <tr key={x.record.cid}><td data-label="result">{ok(x) ? "✓" : "✗"}{rb.drift?.healed && " 🩹"}</td><td className="small mono" data-label="params">{Object.values(rb.params).join(" · ").slice(0, 80)}{/[?&]v=2/.test(rb.start_url) && " · redesigned demo site"}</td><td data-label="turns">{rb.turns}</td><td className="small" data-label="human input">no clicks · {plural(rb.actions.filter((a: any) => a.approval === "human").length, "approval")}</td>{anyFaster && <td className="small" data-label="vs human">{faster(rb) ? `⚡ ${fmtDur(rb.time.run_ms)} vs ${fmtDur(rb.time.recording_ms)}` : ""}</td>}<td data-label="cost">{usd(rb.usage.usd)}</td><td className="small" data-label="when">{ago(x.record.created_at)} · #{x.seq} · <Link to={`/skills/runs/${x.record.cid}`}>run page</Link></td></tr>; })}
    </tbody></table>
    <p className="small"><Link to={`/skills/reuse?skill=${encodeURIComponent(b.slug)}`}>→ all runs of {b.slug}, every version</Link></p>
    <h2>Version history</h2>
    <ul className="tree">{versions.map((v: any) => <li key={v.cid}>{v.cid === cid ? <b>v{v.version}</b> : <Link to={`/s/${v.cid}`}>v{v.version}</Link>} <span className="muted small">{ago(v.created_at)} · {v.cid.slice(0, 20)}…</span></li>)}</ul>
    <h2>Signatures</h2>
    <p className="muted small">The skill and every replay are records signed by the node's Ed25519 key, hash-chained into the public log. Evidence files are content-addressed: the signed record holds their sha256.</p>
    <SignatureCheck entries={[skill, ...(heal_run && !runs.some((x: any) => x.record.cid === heal_run.record.cid) ? [heal_run] : []), ...runs]} />
    <h2 id="replay">Replay it</h2>
    <ReplayPanel target={{ skill_cid: cid }} skill={b.skill} startUrl={heal_run?.record.body.start_url ?? b.source.start_url} />
  </article>;
}

// ---------------------------------------------------------------- public metrics + agent reuse (read-only, no model calls)

export function MetricsPage() {
  const r = useData<any>("/v1/skills/metrics");
  if (r.loading) return <p className="muted">Loading…</p>;
  if (r.error) return <p className="err">{r.error}</p>;
  const m = r.data;
  const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
  return <section>
    <div className="crumbs"><Link to="/skills">skills</Link> / metrics</div>
    <h1>Skills metrics</h1>
    <p className="muted">Computed live from the node-signed <code>skill</code> and <code>skill_run</code> records in the public log, plus the node's Muse spend ledger. Raw JSON: <a href={`${API}/v1/skills/metrics`}>/v1/skills/metrics</a>.</p>
    <div className="stats metrics">
      <div><b>{m.skills}</b><span>skills</span></div>
      <div><b>{m.versions}</b><span>versions</span></div>
      <div><b>{m.heals}</b><span>self-heals</span></div>
      <div><b>{m.runs.total}</b><span>runs</span></div>
      <div><b>{pct(m.runs.success_rate)}</b><span>verified ({m.runs.verified}/{m.runs.total})</span></div>
      <div><b>{m.runs.by_agents}</b><span>runs by {plural(m.runs.distinct_agents, "agent")}</span></div>
    </div>
    <h2>Reuse (replays only)</h2>
    <p className="small muted">{m.replays?.note}</p>
    <div className="stats metrics">
      <div><b>{m.replays?.total ?? 0}</b><span>replays ({m.replays?.verified ?? 0} verified)</span></div>
      <div><b>{m.replays?.real_site ?? 0}</b><span>on real sites</span></div>
      <div><b>{m.replays?.mock_site ?? 0}</b><span>on demo (mock) sites</span></div>
      <div><b>{m.replays?.new_inputs ?? 0}</b><span>with inputs never seen in the recording</span></div>
      <div><b>{m.replays?.by_trigger?.public ?? 0}</b><span>by the public trigger</span></div>
      <div><b>{m.replays?.publishing_runs ?? 0}</b><span>publishing runs (not counted)</span></div>
    </div>
    <h2>Human effort</h2>
    <div className="stats metrics">
      <div><b>{m.human.approvals}</b><span>human approvals of risky steps (the only human input)</span></div>
      <div><b>{m.human.clicks_saved}</b><span>clicks &amp; typed fields done by agents</span></div>
      <div><b>{fmtDur(m.human.time_saved_ms)}</b><span>human time saved</span></div>
    </div>
    <p className="small muted">{m.human.note}{m.human.runs_faster_than_human > 0 && ` ${plural(m.human.runs_faster_than_human, "run")} also finished faster than the human recording.`}</p>
    <h2>Muse Spark</h2>
    <div className="stats metrics">
      <div><b>{m.muse.calls}</b><span>calls</span></div>
      <div><b>${m.muse.usd.toFixed(4)}</b><span>spend (cap ${m.muse.spend_cap_usd})</span></div>
    </div>
    <table className="tbl cards"><thead><tr><th>kind</th><th>calls</th><th>spend</th></tr></thead><tbody>
      {Object.entries(m.muse.by_kind).map(([k, v]: any) => <tr key={k}><td data-label="kind">{k}</td><td data-label="calls">{v.calls}</td><td data-label="spend">{usd(v.usd)}</td></tr>)}
    </tbody></table>
    <p><Link to="/skills/reuse">→ Agent reuse: who ran which skill</Link></p>
  </section>;
}

export function ReuseTable({ skill, agent, limit, compact }: { skill?: string; agent?: string; limit?: number; compact?: boolean }) {
  // Runs by hidden or self-retracted agents (old test identities) are left out unless asked for; an agent's own page shows all of its runs.
  const [showHidden, setShowHidden] = useState(false);
  const qs = new URLSearchParams({ ...(skill ? { skill } : {}), ...(agent ? { agent } : {}), ...(limit ? { limit: String(limit) } : {}), ...(showHidden ? { include_hidden: "1" } : {}) }).toString();
  const r = useData<any>(`/v1/skills/reuse${qs ? `?${qs}` : ""}`, [qs]);
  if (r.loading) return <p className="muted small">Loading…</p>;
  if (r.error) return <p className="err small">{r.error}</p>;
  const { runs, summary } = r.data;
  const toggle = !agent && (summary.hidden_runs > 0 || showHidden) && <label className="small muted toggle"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> show hidden{!showHidden && ` (${plural(summary.hidden_runs, "run")} by hidden or retracted agents)`}</label>;
  if (!runs.length) return <>{toggle}<p className="muted small">No runs yet.</p></>;
  const who = (x: any) => x.agent ? <><Link to={`/a/${x.agent.did}`}>{x.agent.name ?? short(x.agent.did)}</Link>{x.agent.status && x.agent.status !== "active" && <span className="muted"> ({x.agent.status})</span>}</> : <span className="muted">{x.via === "public" ? "public trigger" : x.via === "operator" ? "operator via MCP" : "operator (web)"}</span>;
  return <>
    {!compact && <p className="small muted">{plural(summary.replays ?? 0, "replay")} ({summary.replays_real_site ?? 0} on real sites, {summary.replays_mock_site ?? 0} on demo sites, {summary.replays_new_inputs ?? 0} with new inputs) · {plural(summary.publishing_runs ?? 0, "publishing run")} (not counted) · {plural(summary.agents, "distinct agent")}</p>}
    {compact && <p className="small muted">{plural(summary.replays ?? 0, "replay")} · {summary.replays_new_inputs ?? 0} with inputs never seen in the recording</p>}
    {toggle}
    <table className="tbl cards"><thead><tr><th></th><th>kind</th>{!agent && <th>run by</th>}{!skill && <th>skill</th>}<th>site</th><th>inputs</th><th>when</th></tr></thead><tbody>
      {runs.map((x: any) => <tr key={x.run} className={x.kind === "publish" ? "publish-run" : undefined}>
        <td title={x.evidence ?? ""} data-label="result">{x.outcome === "verified" ? "✓" : "✗"}{(x.self_healed ?? x.healed) && " 🩹"}</td>
        <td className="small" data-label="kind">{x.kind === "publish" ? <span className="muted">publishing run (not counted)</span> : <span className="badge replay">Replay</span>}</td>
        {!agent && <td className="small" data-label="run by">{who(x)}</td>}
        {!skill && <td className="small" data-label="skill"><Link to={`/s/${x.skill.cid}`}>{x.skill.name}</Link> <span className="muted">v{x.skill.version}</span></td>}
        <td className="small" data-label="site"><SiteBadge kind={x.site_kind} /></td>
        <td className="small" data-label="inputs">{x.new_inputs == null ? <span className="muted">no params</span> : x.new_inputs ? "new inputs" : <span className="muted">same as recording</span>}</td>
        <td className="small" data-label="when">{ago(x.at)} · log #{x.seq} · <Link to={`/skills/runs/${x.run}`}>run page</Link></td>
      </tr>)}
    </tbody></table>
  </>;
}

export function ReusePage({ skill, agent }: { skill?: string; agent?: string }) {
  return <section>
    <div className="crumbs"><Link to="/skills">skills</Link> / reuse</div>
    <h1>Reuse</h1>
    <MetricsStrip />
    <p className="muted">Every run of a skill is a node-signed <code>skill_run</code> record. A <b>replay</b> is any run of a published version; the run that published a skill (the verification of its recording) is shown but never counted. Each row links to a run page with the inputs, step screenshots, the verifier's verdict, the models and the signed record. Who asked: a signed agent paying credits, the public trigger (no token, capped), or the operator.{(skill || agent) && <> Filtered by {skill ? `skill ${skill}` : `agent ${short(agent!)}`} · <Link to="/skills/reuse">show all</Link></>}</p>
    <ReuseTable skill={skill} agent={agent} limit={200} />
    <p><Link to="/skills/metrics">→ Metrics</Link></p>
  </section>;
}

// ---------------------------------------------------------------- one run as evidence (/skills/runs/<record cid or job id>)

/** The replay GIF's frames as separate step screenshots (WebCodecs ImageDecoder); falls back to the animated GIF. */
export function StepFrames({ gif }: { gif: string }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    (async () => {
      const ID = (globalThis as any).ImageDecoder;
      if (!ID) return;
      const data = await (await fetch(gif)).arrayBuffer();
      const dec = new ID({ data, type: "image/gif" });
      await dec.tracks.ready;
      const n = dec.tracks.selectedTrack?.frameCount ?? 0;
      for (let i = 0; i < Math.min(n, 24); i++) {
        const { image } = await dec.decode({ frameIndex: i });
        const c = document.createElement("canvas"); c.width = image.displayWidth; c.height = image.displayHeight;
        c.getContext("2d")!.drawImage(image, 0, 0); image.close();
        const b: Blob = await new Promise((res) => c.toBlob((x) => res(x!), "image/jpeg", 0.8));
        urls.push(URL.createObjectURL(b));
      }
      if (live) setFrames([...urls]);
    })().catch(() => { /* fall back to the GIF */ });
    return () => { live = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [gif]);
  if (!frames?.length) return <img className="media" src={gif} alt="replay, step by step (animated GIF)" />;
  return <ol className="step-frames">{frames.map((f, i) => <li key={i}><img src={f} alt={`step screenshot ${i + 1}`} loading="lazy" /><span className="small muted">{i === frames.length - 1 ? "final" : `screenshot ${i + 1}`}</span></li>)}</ol>;
}

/** The value a run returned (read off the final page without a model) and how many model calls the run made. */
export function ReturnedValue({ answer, calls, mode, binding }: { answer?: any; calls?: number; mode?: string; binding?: any }) {
  if (calls == null && !answer) return null;
  return <div className="returned-value">
    {answer?.value != null && <div><span className="small muted">Returned value</span> <b className="big-value">{answer.value}</b> <span className="small muted">read from the page ({answer.source}){answer.verified_by === "verifier" ? "" : ", no model"}</span>{answer.source_note && <div className="small muted">{answer.source_note}</div>}</div>}
    {binding?.checked && !binding.ok && <div className="err small"><b>Not verified:</b> {binding.reason}</div>}
    <div className="small"><b>{calls ?? "?"} model call{calls === 1 ? "" : "s"}</b>{mode === "trace" ? " · deterministic replay of the recorded trace" : mode === "trace+recovery" ? " · recorded trace, the model recovered a step" : mode === "model" ? " · model-driven replay (no trace yet)" : ""}{answer?.verified_by === "deterministic" ? " · verified by deterministic checks" : ""}</div>
  </div>;
}

export function RunPage({ id }: { id: string }) {
  const r = useData<any>(`/v1/skills/runs/${id}`, [id]);
  if (r.loading) return <p className="muted">Loading…</p>;
  if (r.error) return <p className="err">{r.error}</p>;
  const d = r.data;
  if (!d.run) return <article><h1>Run {d.status}</h1><p className="muted">{d.note}</p>{d.job && <p><Link to={`/skills/r/${d.job.id}`}>→ live run page</Link></p>}</article>;
  const b = d.run.record.body;
  const isReplay = d.kind === "replay";
  const names = Object.keys({ ...d.recording.inputs, ...d.inputs });
  return <article>
    <div className="crumbs"><Link to="/skills">skills</Link> / <Link to={`/s/${d.skill.cid}`}>{d.skill.slug}</Link> / run</div>
    <h1>{isReplay ? <span className="badge big replay">Replay</span> : <span className="badge big publish">Publishing run</span>} {d.skill.name} <SiteBadge kind={d.site_kind} /></h1>
    <p className="lead small">{isReplay
      ? <>A replay of <Link to={`/s/${d.skill.cid}`}>v{d.skill.version}</Link> of a skill that was recorded once by a person{d.recording.video ? <> (<a href={d.recording.video} target="_blank" rel="noreferrer">the original recording</a>)</> : null}. This run is separate from the recording: an agent drove the browser from the skill's steps.</>
      : <>The first verified run of the recording, signed together with <Link to={`/s/${d.skill.cid}`}>v{d.skill.version}</Link>. It is part of publishing the skill and is <b>not counted as reuse</b>.{d.recording.video ? <> <a href={d.recording.video} target="_blank" rel="noreferrer">The recording</a>.</> : null}</>}</p>
    {d.site_kind === "mock" && <p className="small demo-note">This ran on an Agentboard demo page (a mock site we host), not a real-world site.</p>}
    <div className="meta">trigger: <b>{d.trigger}</b> ({triggerLabel(d.trigger)}){d.agent && <> · <Link to={`/a/${d.agent}`}>{short(d.agent)}</Link></>} · {ago(d.run.record.created_at)} · log #{d.run.seq}{d.job && <> · <Link to={`/skills/r/${d.job.id}`}>live run page</Link></>}{d.skill.latest_version !== d.skill.version && <> · latest is <Link to={`/s/${d.skill.latest_cid}`}>v{d.skill.latest_version}</Link></>}</div>
    <ReturnedValue answer={d.answer} calls={d.model_calls} mode={d.replay?.mode} binding={d.value_binding} />
    <div className={`verdict-box ${d.success ? "good" : "badv"}`}><ModelCall model={d.models.verifier} capability={`verified with ${d.models.verifier_capability ?? "image understanding"}`} /><p>{d.success ? "✓ Verified" : "✗ Not verified"}: {d.verdict?.evidence}</p></div>
    <h2>Inputs</h2>
    {names.length ? <table className="tbl cards"><thead><tr><th>param</th><th>this run</th><th>in the recording</th></tr></thead><tbody>
      {names.map((n) => <tr key={n}><td className="mono" data-label="param">{n}</td><td data-label="this run">{String(d.inputs?.[n] ?? "")}</td><td className="muted" data-label="in the recording">{String(d.recording.inputs?.[n] ?? "")}{d.differing_params?.includes(n) && <span className="badge new-inputs">different</span>}</td></tr>)}
    </tbody></table> : <p className="muted small">This skill takes no inputs.</p>}
    <p className="small">{d.new_inputs == null ? "No params: the same task on the live page." : d.new_inputs ? <b>New inputs never seen in the recording.</b> : "Same inputs as the recording."} Start page: <a href={b.start_url} target="_blank" rel="noreferrer">{b.start_url}</a></p>
    <p className="small">{d.self_healed ? <>🩹 <b>Self-healed:</b> the site had changed, so this run's evidence produced {d.healed_to ? <Link to={`/s/${d.healed_to.cid}`}>v{d.healed_to.version}</Link> : "a new version"}.</> : "Did not self-heal (the steps still matched the site)."}</p>
    <h2>Step screenshots</h2>
    <div className="sbs">
      <div>{d.evidence.gif ? <StepFrames gif={d.evidence.gif} /> : <p className="muted">No step screenshots stored for this run.</p>}</div>
      <div><h3>Final screenshot</h3>{d.evidence.final_screenshot ? <a href={d.evidence.final_screenshot} target="_blank" rel="noreferrer"><img className="media" src={d.evidence.final_screenshot} alt="final screenshot the verifier judged" /></a> : <p className="muted">none</p>}</div>
    </div>
    <h2>Models</h2>
    <div className="calls">
      <ModelCall model={d.models.loop} capability={`replayed with ${d.models.loop_capability ?? "computer use"}`} extra={`${d.turns} turns · ${usd(d.usage?.usd)}`} />
      <ModelCall model={d.models.verifier} capability={`verified with ${d.models.verifier_capability ?? "image understanding"}`} />
    </div>
    <h2>What the agent did</h2>
    {d.job?.turns?.length ? <ol className="turns">{d.job.turns.map((t: any) => <li key={t.turn}><ModelCall model={t.model} capability={t.capability ?? "computer use"} extra={<>{t.ms} ms · {usd(t.usd)}</>} /><div>{t.say}</div><div className="mono small">{(t.actions ?? []).map((a: any) => JSON.stringify(a)).join(" ")}</div></li>)}</ol> : null}
    <ol className="steps">{(d.actions ?? []).map((a: any, i: number) => <li key={i}><span className="act">{a.type}</span> {a.detail}{a.target && <span className="muted"> on "{a.target}"</span>}{a.approval === "human" && <span className="lock"> 🔒 approved by a human</span>}</li>)}</ol>
    <h2>Signed record</h2>
    <p className="small mono">cid {d.signature.cid}<br />signed by {d.signature.signed_by}<br />sig {d.signature.sig}</p>
    <p className="small muted">Check it here (Ed25519 signature, content id, log entry hash, and that the screenshot and GIF bytes hash to the sha256 in the signed record), or with the MCP <code>verify_record</code> tool. Raw: <a href={`${API}/v1/records/${d.signature.cid}`}>/v1/records/{d.signature.cid.slice(0, 16)}…</a></p>
    <SignatureCheck entries={[d.run]} />
  </article>;
}
