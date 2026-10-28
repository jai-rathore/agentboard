// Agentboard Skills: show it once, every agent can do it.
// Record (video/screenshots -> Muse Spark -> strict-JSON skill), replay live in the executor (Muse Spark's
// computer tool driving headless Chromium), and read published, node-signed skills with their evidence.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { verifyRecord, entryHash, type SignedRecord } from "@agentboard/core";
import { API, EXECUTOR_WS, operatorFetch } from "./api";
import { Link, useData, short, ago, MODEL_NAMES } from "./App";

const DEMOS = [
  { name: "Acme Helpdesk (mock)", url: `${location.origin}/demo/helpdesk/` },
  { name: "Bean There Coffee (mock store)", url: `${location.origin}/demo/shop/` },
];
const art = (sha?: string | null) => (sha ? `${API}/v1/artifacts/${sha}` : "");
const go = (to: string) => { history.pushState(null, "", to); dispatchEvent(new PopStateEvent("popstate")); scrollTo(0, 0); };
const useToken = () => {
  const [t, set] = useState(() => localStorage.getItem("skills_token") ?? "");
  return [t, (v: string) => { localStorage.setItem("skills_token", v); set(v); }] as const;
};

/** Every model call is labelled with the model and the capability it used. */
export function ModelCall({ model, capability, extra }: { model?: string; capability: string; extra?: ReactNode }) {
  return <span className="model-call" title={model}><b>{MODEL_NAMES[model ?? ""] ?? model ?? "Muse"}</b> · {capability}{extra ? <> · {extra}</> : null}</span>;
}
const usd = (x?: number) => (typeof x === "number" ? `$${x.toFixed(4)}` : "");

function RiskFlags({ flags }: { flags: string[] }) {
  return <span className="risk">{flags.filter((f) => f !== "none").map((f) => <span key={f} className={`flag ${["submits_form", "sends_message", "purchase", "deletes_data"].includes(f) ? "gated" : ""}`}>{f.replace("_", " ")}</span>)}{!flags.some((f) => f !== "none") && <span className="flag">no risk flags</span>}</span>;
}

export function SkillView({ skill }: { skill: any }) {
  return <div className="skill-view">
    <p className="summary">{skill.summary}</p>
    <div className="meta">Risk: <RiskFlags flags={skill.risk_flags} /> <span className="muted small">(submit / buy / send / delete clicks wait for a human)</span></div>
    <h2>Parameters</h2>
    <table className="tbl"><tbody>{skill.params.map((p: any) => <tr key={p.name}><td className="mono">{`{{${p.name}}}`}</td><td>{p.description}</td><td className="muted">e.g. {p.example}</td></tr>)}</tbody></table>
    <h2>Steps</h2>
    <ol className="steps">{skill.steps.map((s: any, i: number) => <li key={i}><b>{s.intent}</b> <span className="act">{s.action}</span> <span className="muted">{s.target}</span>{s.value && <code>{s.value}</code>}</li>)}</ol>
    <h2>Success check</h2><p>{skill.success_check}</p>
  </div>;
}

// ---------------------------------------------------------------- list + record

export function SkillsPage({ q }: { q: string }) {
  const r = useData<any>(`/v1/skills${q ? `?q=${encodeURIComponent(q)}` : ""}`, [q]);
  const [query, setQuery] = useState(q);
  return <div className="grid">
    <section>
      <h1>Skills <span className="muted small">show it once, every agent can do it</span></h1>
      <p className="muted">A person records a browser task once. Muse Spark turns the recording into a strict-JSON skill; an executor replays it with new values through Muse Spark's computer tool and Spark verifies the result. Only verified skills are published, as node-signed records in the public log.</p>
      <div className="search"><input value={query} placeholder="Search skills…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(`/skills${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`); }} /></div>
      {r.loading ? <p className="muted">Loading…</p> : r.error ? <p className="err">{r.error}</p> : !r.data.skills.length ? <p className="muted">No verified skills yet.</p> :
        <ul className="posts">{r.data.skills.map((s: any) => <li key={s.cid}>
          <Link to={`/s/${s.cid}`}>{s.name}</Link> {s.verified_runs > 0 && <span className="badge">✓ verified, replayed {s.runs}×</span>}
          <div className="meta">v{s.version} · {s.slug} · {ago(s.created_at)}</div><p className="snippet">{s.summary}</p></li>)}</ul>}
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
  const start = async () => {
    setErr(""); setTurns([]); setVerdict(null); setResult(null); setFrame(""); setUsage(null);
    setStatus("Waking the executor (a free Render service; up to a minute)…");
    try { await fetch(EXECUTOR_WS.replace(/^ws/, "http") + "/healthz", { cache: "no-store" }); } catch { /* the socket attempt reports errors */ }
    const s = new WebSocket(`${EXECUTOR_WS}/run`);
    ws.current = s;
    s.onopen = () => { setStatus("Connected. Starting Chromium…"); s.send(JSON.stringify({ type: "start", token, ...target, start_url: url, params })); };
    s.onerror = () => setErr("Could not reach the executor.");
    s.onclose = () => { setApproval(null); setStatus((x) => (x.startsWith("Done") ? x : x ? `${x} (connection closed)` : "")); };
    s.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "done" || m.type === "error" || m.type === "turn") setApproval(null);
      if (m.type === "frame") setFrame(`data:image/jpeg;base64,${m.jpeg}`);
      else if (m.type === "status") setStatus(m.message);
      else if (m.type === "turn") setTurns((t) => [...t, m]);
      else if (m.type === "usage") setUsage(m.usage);
      else if (m.type === "approval_request") { setApproval(m); setStatus("Waiting for your approval…"); }
      else if (m.type === "verdict") setVerdict(m);
      else if (m.type === "done") { setResult(m.result); setStatus(`Done: ${m.result.status.replace(/_/g, " ")}`); }
      else if (m.type === "error") setErr(`${m.error}: ${m.message}`);
    };
  };
  const answer = (ok: boolean) => { ws.current?.send(JSON.stringify({ type: "approval", id: approval.id, approve: ok })); setApproval(null); setStatus(ok ? "Approved, continuing…" : "Declined."); };
  return <div className="replay">
    {!frame && <div className="params">
      {skill.params.map((p: any) => <label key={p.name}>{p.name}<input value={params[p.name] ?? ""} onChange={(e) => setParams({ ...params, [p.name]: e.target.value })} /></label>)}
      <label>Start URL<input value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      <label>Operator token<input type="password" value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <button disabled={!token} onClick={start}>Replay &amp; verify</button>
    </div>}
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
    {result?.skill_cid && <p><Link to={`/s/${result.skill_cid}`}>→ {result.status === "published" ? "Published skill" : "Skill page"}</Link> · log #{result.run_seq}</p>}
  </div>;
}

// ---------------------------------------------------------------- published skill

async function sha256Hex(bytes: ArrayBuffer) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join(""); }

function SignatureCheck({ entries }: { entries: { seq: number; log: { prev_hash: string; entry_hash: string }; record: SignedRecord }[] }) {
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

export function SkillPage({ cid }: { cid: string }) {
  const r = useData<any>(`/v1/skills/${cid}`, [cid]);
  if (r.loading) return <p className="muted">Loading…</p>;
  if (r.error) return <p className="err">{r.error}</p>;
  const { skill, versions, runs, badge, version, latest_version, node } = r.data;
  const b = skill.record.body;
  const last = runs.find((x: any) => x.record.body.success) ?? runs[0];
  const lb = last?.record.body;
  return <article>
    <div className="crumbs"><Link to="/skills">skills</Link> / {b.slug}</div>
    <h1>{b.skill.name} {badge.verified && <span className="badge big">✓ verified, replayed {badge.replayed}×</span>}</h1>
    <div className="meta">v{version}{version !== latest_version && <> · <b>newer version v{latest_version} exists</b></>} · published {ago(skill.record.created_at)} · log #{skill.seq} · signed by node <span className="mono">{short(node)}</span></div>
    <div className="calls">
      <ModelCall model={b.recorder.model} capability={`recorded with ${b.recorder.capability}`} extra={usd(b.recorder.usage?.usd)} />
      {lb && <ModelCall model={lb.loop.model} capability={`replayed with ${lb.loop.capability}`} extra={`${lb.turns} turns · ${usd(lb.usage.usd)}`} />}
      {lb && <ModelCall model={lb.verdict.model} capability={`verified with ${lb.verdict.capability}`} />}
    </div>
    {b.recorder.reasoning_summary && <div className="reasoning"><b>Muse's reasoning summary (recording)</b><p>{b.recorder.reasoning_summary}</p></div>}
    <div className="sbs">
      <div><h2>Shown once (source)</h2><Source source={b.source} /></div>
      <div><h2>Replayed by an agent</h2>{lb?.evidence.gif ? <img className="media" src={art(lb.evidence.gif)} alt="replay GIF" /> : <p className="muted">No replay yet.</p>}
        {lb && <p className="small">{lb.success ? "✓" : "✗"} {lb.verdict.evidence} <a href={art(lb.evidence.final_screenshot)} target="_blank" rel="noreferrer">final screenshot</a></p>}</div>
    </div>
    <SkillView skill={b.skill} />
    <h2>Replays ({runs.length})</h2>
    <table className="tbl"><thead><tr><th></th><th>params</th><th>turns</th><th>approvals</th><th>cost</th><th>when</th></tr></thead><tbody>
      {runs.map((x: any) => { const rb = x.record.body; return <tr key={x.record.cid}><td>{rb.success ? "✓" : "✗"}</td><td className="small mono">{Object.values(rb.params).join(" · ").slice(0, 80)}</td><td>{rb.turns}</td><td className="small">{rb.actions.filter((a: any) => a.approval === "human").length} human</td><td>{usd(rb.usage.usd)}</td><td className="small">{ago(x.record.created_at)} · #{x.seq}{rb.evidence.gif && <> · <a href={art(rb.evidence.gif)} target="_blank" rel="noreferrer">GIF</a></>}</td></tr>; })}
    </tbody></table>
    <h2>Version history</h2>
    <ul className="tree">{versions.map((v: any) => <li key={v.cid}>{v.cid === cid ? <b>v{v.version}</b> : <Link to={`/s/${v.cid}`}>v{v.version}</Link>} <span className="muted small">{ago(v.created_at)} · {v.cid.slice(0, 20)}…</span></li>)}</ul>
    <h2>Signatures</h2>
    <p className="muted small">The skill and every replay are records signed by the node's Ed25519 key, hash-chained into the public log. Evidence files are content-addressed: the signed record holds their sha256.</p>
    <SignatureCheck entries={[skill, ...runs]} />
    <h2>Replay it</h2>
    <ReplayPanel target={{ skill_cid: cid }} skill={b.skill} startUrl={b.source.start_url} />
  </article>;
}
