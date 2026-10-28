// /benchmark: the two-agent reuse benchmark (GET /v1/benchmarks). Read-only, rendered from the node-signed records.
import type { ReactNode } from "react";
import { API } from "./api";
import { Link, useData, short, ago } from "./App";
import { fmtDur, SiteBadge, SignatureCheck, StepFrames } from "./skills";

const usd = (x?: number | null) => (typeof x === "number" ? `$${x.toFixed(4)}` : "n/a");
const n = (x?: number | null) => (typeof x === "number" ? x.toLocaleString("en-US") : "n/a");

/** Homepage line: the latest benchmark's headline, or nothing at all when none exists. */
export function BenchmarkStat({ empty }: { empty?: ReactNode } = {}) {
  const r = useData<any>("/v1/benchmarks/latest");
  const b = r.data;
  if (!b?.headline) return r.loading ? null : <>{empty ?? null}</>;
  const c = b.record.body.comparison ?? {}, runs = b.record.body.runs;
  return <section className="bench-stat" aria-label="Reuse benchmark">
    <div className="bench-big">
      <div><b>{n(runs.reuse.model_calls)} vs {n(runs.cold.model_calls)}</b><span>model calls: reusing agent vs cold agent</span></div>
      <div><b>{usd(runs.reuse.usd)} vs {usd(runs.cold.usd)}</b><span>Muse cost{c.usd_ratio ? ` (${c.usd_ratio}x cheaper)` : ""}</span></div>
    </div>
    <p className="small">{b.headline} <Link to={`/benchmark?id=${b.id}`}>Method and both signed runs →</Link></p>
  </section>;
}

export function BenchmarkPage({ id }: { id?: string }) {
  const list = useData<any>(id ? null : "/v1/benchmarks");
  const latestId = id ?? list.data?.benchmarks?.[0]?.id;
  const one = useData<any>(latestId ? `/v1/benchmarks/${latestId}` : null, [latestId]);
  if (!id && list.loading) return <p className="muted">Loading…</p>;
  if (list.error) return <p className="err">{list.error}</p>;
  if (!latestId) return <article>
    <h1>Reuse benchmark</h1>
    <p className="muted">No benchmark has been published yet. When one is, this page shows two agents doing the same task on the same input: one from scratch, one by finding and replaying a published skill, with model calls, tokens, cost and time from the signed run records.</p>
    <Method m={list.data?.method} />
  </article>;
  if (one.loading) return <p className="muted">Loading…</p>;
  if (one.error) return <p className="err">{one.error}</p>;
  const d = one.data, b = d.record.body, A = b.runs.cold, B = b.runs.reuse, c = b.comparison ?? {}, cold = d.cold_run;
  const rows: [string, (x: any) => string][] = [
    ["Verified by the model's check of the final screenshot", (x) => (x.success ? "✓ yes" : "✗ no")],
    ["Model calls", (x) => n(x.model_calls)],
    ["Input tokens", (x) => n(x.input_tokens)],
    ["Output tokens", (x) => n(x.output_tokens)],
    ["Cost (Muse list price)", (x) => usd(x.usd)],
    ["Browser turns", (x) => n(x.turns)],
    ["Executor time (browser launch → verified)", (x) => fmtDur(x.executor_ms)],
    ["Wall time (harness: request → result)", (x) => fmtDur(x.client?.wall_ms)],
    ["Muse ledger change during the run (cross-check)", (x) => (x.client?.muse_spend_delta_usd == null ? "n/a" : `${usd(x.client.muse_spend_delta_usd)}, ${n(x.client.muse_spend_delta_calls)} calls`)],
  ];
  return <article className="benchmark">
    <div className="crumbs"><Link to="/skills">skills</Link> / benchmark</div>
    <h1>Reuse benchmark: {b.task.name ?? b.task.slug} <SiteBadge kind={b.task.site_kind} /></h1>
    <p className="lead">{d.headline}</p>
    <div className="bench-big">
      <div><b>{c.model_calls_ratio ? `${c.model_calls_ratio}x` : "n/a"}</b><span>fewer model calls when reusing</span></div>
      <div><b>{c.usd_ratio ? `${c.usd_ratio}x` : "n/a"}</b><span>cheaper ({usd(c.usd_saved)} saved per run)</span></div>
      <div><b>{c.reuses_to_pay_back_recording ?? "n/a"}</b><span>reuses pay back the one-time recording ({usd(c.recording_one_time_usd)})</span></div>
    </div>
    <h2>Same task, same input, two agents</h2>
    <p className="small">Skill <Link to={`/skills/${b.task.slug}`}>{b.task.slug}</Link> · start page <a href={b.task.start_url} target="_blank" rel="noreferrer">{b.task.start_url}</a> · input <code>{JSON.stringify(b.input)}</code> · {ago(d.created_at)} · log #{d.seq}</p>
    <table className="tbl cards bench-table"><thead><tr><th></th><th>Agent A: cold (no skill)</th><th>Agent B: finds and reuses the skill</th></tr></thead><tbody>
      <tr><td>Identity (fresh did:key, unregistered)</td><td data-label="Agent A" className="mono"><span title={b.agents.a.did}>{short(b.agents.a.did)}</span><br /><span className="muted small">{b.agents.a.client}</span></td><td data-label="Agent B" className="mono"><span title={b.agents.b.did}>{short(b.agents.b.did)}</span><br /><span className="muted small">{b.agents.b.client}</span></td></tr>
      <tr><td>Skill lookup</td><td data-label="Agent A">none</td><td data-label="Agent B">{b.find_skill ? <>find_skill("{String(b.find_skill.query ?? "").slice(0, 80)}") → rank {b.find_skill.rank} of {b.find_skill.results}, {b.find_skill.model_calls ?? 0} model calls</> : "find_skill"}</td></tr>
      {rows.map(([label, f]) => <tr key={label}><td>{label}</td><td data-label="Agent A">{f(A)}</td><td data-label="Agent B">{f(B)}</td></tr>)}
      <tr><td>Signed run record</td><td data-label="Agent A" className="mono small"><a href="#cold">{String(A.record).slice(0, 18)}…</a> (benchmark_run)</td><td data-label="Agent B" className="mono small"><Link to={`/skills/runs/${B.record}`}>{String(B.record).slice(0, 18)}…</Link> (skill_run{B.self_healed ? ", self-healed" : ""})</td></tr>
    </tbody></table>
    <Method m={b.method} />
    <h2 id="cold">Agent A's cold run</h2>
    {cold ? <>
      <div className={`verdict-box ${cold.success ? "good" : "badv"}`}><p>{cold.success ? "✓ Verified" : "✗ Not verified"}: {cold.verdict?.evidence}</p></div>
      <p className="small">The executor got only the task statement below, with no recorded steps, and Muse drove the browser with the computer tool.</p>
      <p className="small mono">{b.task.name}: {cold.run.record.body.task?.summary}<br />Success check: {cold.run.record.body.task?.success_check}</p>
      <div className="sbs">
        <div>{cold.evidence.gif ? <StepFrames gif={cold.evidence.gif} /> : <p className="muted">No step screenshots stored.</p>}</div>
        <div><h3>Final screenshot</h3>{cold.evidence.final_screenshot ? <a href={cold.evidence.final_screenshot} target="_blank" rel="noreferrer"><img className="media" src={cold.evidence.final_screenshot} alt="final screenshot of the cold run" /></a> : <p className="muted">none</p>}</div>
      </div>
      <ol className="steps">{(cold.actions ?? []).map((a: any, i: number) => <li key={i}><span className="act">{a.type}</span> {a.detail}{a.target && <span className="muted"> on "{a.target}"</span>}</li>)}</ol>
    </> : <p className="muted">Cold run record not found.</p>}
    <h2>Signed records</h2>
    <p className="small mono">benchmark {d.cid}<br />cold run {A.record}<br />replay {B.record}<br />signed by the node {d.record.author}</p>
    <p className="small muted">Raw: <a href={`${API}/v1/records/${d.cid}`}>benchmark</a> · <a href={`${API}/v1/records/${A.record}`}>cold run</a> · <a href={`${API}/v1/records/${B.record}`}>replay</a> · <a href={`${API}/v1/benchmarks/${d.id}`}>JSON</a>. Or check them with the MCP <code>verify_record</code> tool.</p>
    <SignatureCheck entries={[{ seq: d.seq, log: d.log, record: d.record }, ...(cold ? [cold.run] : [])]} />
  </article>;
}

function Method({ m }: { m?: Record<string, string> }) {
  if (!m) return null;
  const items: [string, string][] = [["Same input", m.same_input], ["Fresh identities", m.identities], ["Agent A (cold)", m.agent_a], ["Agent B (reuse)", m.agent_b], ["What counts as a model call", m.model_call], ["Cost", m.cost], ["Time", m.time], ["Not counted", m.not_counted]];
  return <><h2>Method</h2><dl className="method">{items.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>;
}
