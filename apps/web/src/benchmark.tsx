// /benchmark: the two-agent reuse benchmark (GET /v1/benchmarks). Read-only, rendered from the node-signed records.
import type { ReactNode } from "react";
import { API } from "./api";
import { Link, useData, short, ago } from "./App";
import { fmtDur, SiteBadge, SignatureCheck, StepFrames } from "./skills";

const usd = (x?: number | null) => (typeof x === "number" ? `$${x.toFixed(4)}` : "n/a");
const n = (x?: number | null) => (typeof x === "number" ? x.toLocaleString("en-US") : "n/a");

/** Homepage line: the latest headline benchmark (both verified AND reuse cheaper; the API's /latest skips others), or nothing. */
export function BenchmarkStat({ empty }: { empty?: ReactNode } = {}) {
  const r = useData<any>("/v1/benchmarks/latest");
  const b = r.data;
  if (!b?.headline) return r.loading ? null : <>{empty ?? null}</>;
  const c = b.record.body.comparison ?? {}, runs = b.record.body.runs;
  return <section className="bench-stat" aria-label="Reuse benchmark">
    <div className="bench-big">
      <div><b>{n(runs.reuse.model_calls)} vs {n(runs.cold.model_calls)}</b><span>model calls: reusing agent vs cold agent</span></div>
      <div><b>{usd(runs.reuse.usd)} vs {usd(runs.cold.usd)}</b><span>Muse cost{c.usd_ratio ? ` (${c.usd_ratio}x cheaper)` : runs.reuse.model_calls === 0 ? " (no model calls when reusing)" : ""}</span></div>
      {runs.reuse.executor_ms && runs.cold.executor_ms ? <div><b>{secs(runs.reuse.executor_ms)} vs {secs(runs.cold.executor_ms)}</b><span>browser time: reusing agent vs cold agent</span></div> : null}
    </div>
    <p className="small">{b.headline} <Link to={`/benchmark?id=${b.id}`}>Method and both signed runs →</Link></p>
    <NoHitLine />
  </section>;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** The verified-negative benchmark (a real name OFAC does not list), read from its signed record. */
export const NO_HIT_BENCHMARK = "9989831b-bf4b-4233-9e26-5185edce8972";
function NoHitLine() {
  const r = useData<any>(`/v1/benchmarks/${NO_HIT_BENCHMARK}`);
  const b = r.data?.record?.body;
  const A = b?.runs?.cold, B = b?.runs?.reuse;
  if (!A || !B || B.outcome !== "no_match" || !B.success) return null;
  const input = Object.values(b.input ?? {})[0];
  return <p className="small"><b>And when the answer is “not listed”:</b> on {input ? <>“{String(input)}”, </> : null}a real name OFAC does not list, the cold agent took {n(A.model_calls)} model calls and {A.executor_ms ? secs(A.executor_ms) : "n/a"} and {A.success ? "verified" : <b>still could not verify</b>}; the reusing agent got <b>Verified: no hit</b> in {B.executor_ms ? secs(B.executor_ms) : "n/a"} with {n(B.model_calls)} model calls (the site's own “no results” wording, tied to the input). <Link to={`/benchmark?id=${NO_HIT_BENCHMARK}`}>Both signed runs →</Link></p>;
}

export function BenchmarkPage({ id }: { id?: string }) {
  const list = useData<any>("/v1/benchmarks");
  // The headline (the API's headline_id: pinned, else the latest where both runs verified, reuse was cheaper and the values matched); others stay in the history, labeled.
  const all: any[] = list.data?.benchmarks ?? [];
  const latestId = id ?? list.data?.headline_id ?? all.find((x) => x.headline_eligible)?.id;
  const one = useData<any>(latestId ? `/v1/benchmarks/${latestId}` : null, [latestId]);
  if (!id && list.loading) return <p className="muted">Loading…</p>;
  if (list.error) return <p className="err">{list.error}</p>;
  if (!latestId) return <article>
    <h1>Reuse benchmark</h1>
    {all.length ? <><p className="muted">No headline result yet: a benchmark is headlined only when both runs are verified, reusing the skill cost less than doing it cold, and both returned the same value. Every attempt is listed below with its result.</p><History all={all} /></> : null}
    <p className="muted">{all.length ? "" : "No benchmark has been published yet. "} When one qualifies, this page shows two agents doing the same task on the same input: one from scratch, one by finding and replaying a published skill, with model calls, tokens, cost and time from the signed run records.</p>
    <Method m={list.data?.method} />
  </article>;
  if (one.loading) return <p className="muted">Loading…</p>;
  if (one.error) return <p className="err">{one.error}</p>;
  const d = one.data, b = d.record.body, A = b.runs.cold, B = b.runs.reuse, c = b.comparison ?? {}, cold = d.cold_run;
  const sameTask = all.filter((x) => x.record?.body?.task?.slug === b.task.slug);
  const coldFails = { total: sameTask.length, failed: sameTask.filter((x) => !x.record?.body?.runs?.cold?.success).length };
  const rows: [string, (x: any) => string][] = [
    ["Verified (final check below)", (x) => (x.success ? (x.outcome === "no_match" ? "✓ Verified: no hit" : "✓ yes") : "✗ no")],
    ["Returned value", (x) => (x.outcome === "no_match" ? "no hit (the site's declared no-results wording, tied to the input)" : x.value ?? "–") + (x === B && c.values_match != null ? (c.values_match ? "  ✓ same as cold" : "  ✗ differs from cold") : "")],
    ["Model calls", (x) => n(x.model_calls)],
    ["Input tokens", (x) => n(x.input_tokens)],
    ["Output tokens", (x) => n(x.output_tokens)],
    ["Cost (Muse list price)", (x) => usd(x.usd)],
    ["Browser turns (model turns)", (x) => n(x.turns)],
    ["How it ran", (x) => (x.replay_mode === "trace" ? "recorded trace, no model" : x.replay_mode === "trace+recovery" ? "recorded trace, model recovered a step" : x.replay_mode === "model" ? "model run with the skill's steps as hints" : "model run from the task")],
    ["Final check", (x) => (x.verifier === "deterministic" ? "deterministic (page and values)" : "model check of the final screenshot")],
    ["Executor time (browser launch → verified)", (x) => fmtDur(x.executor_ms)],
    ["Wall time (harness: request → result)", (x) => fmtDur(x.client?.wall_ms)],
    ["Muse ledger change during the run (cross-check)", (x) => (x.client?.muse_spend_delta_usd == null ? "n/a" : `${usd(x.client.muse_spend_delta_usd)}, ${n(x.client.muse_spend_delta_calls)} calls`)],
  ];
  return <article className="benchmark">
    <div className="crumbs"><Link to="/skills">skills</Link> / benchmark</div>
    <h1>Reuse benchmark: {b.task.name ?? b.task.slug} <SiteBadge kind={b.task.site_kind} /></h1>
    <p className="lead">{d.headline}</p>
    <div className="bench-big">
      <div><b>{c.model_calls_ratio ? `${c.model_calls_ratio}x` : B.model_calls === 0 ? `${n(A.model_calls)} → 0` : "n/a"}</b><span>{B.model_calls === 0 ? "model calls: cold → reusing (deterministic replay)" : "fewer model calls when reusing"}</span></div>
      <div><b>{c.usd_ratio ? `${c.usd_ratio}x` : B.usd === 0 && A.usd > 0 ? `${usd(A.usd)} → $0` : "n/a"}</b><span>cheaper ({usd(c.usd_saved)} saved per run)</span></div>
      <div><b>{c.reuses_to_pay_back_recording ?? "n/a"}</b><span>reuses pay back the one-time recording ({usd(c.recording_one_time_usd)})</span></div>
    </div>
    <h2>Same task, same input, two agents</h2>
    <p className="small">Skill <Link to={`/skills/${b.task.slug}`}>{b.task.slug}</Link> · start page <a href={b.task.start_url} target="_blank" rel="noreferrer">{b.task.start_url}</a> · input <code>{JSON.stringify(b.input)}</code> · {ago(d.created_at)} · log #{d.seq}</p>
    <table className="tbl cards bench-table"><thead><tr><th></th><th>Agent A: cold (no skill)</th><th>Agent B: finds and reuses the skill</th></tr></thead><tbody>
      <tr><td>Identity (fresh did:key, unregistered)</td><td data-label="Agent A" className="mono"><span title={b.agents.a.did}>{short(b.agents.a.did)}</span><br /><span className="muted small">{b.agents.a.client}</span></td><td data-label="Agent B" className="mono"><span title={b.agents.b.did}>{short(b.agents.b.did)}</span><br /><span className="muted small">{b.agents.b.client}</span></td></tr>
      <tr><td>Skill lookup</td><td data-label="Agent A">none</td><td data-label="Agent B">{b.find_skill ? <>find_skill("{String(b.find_skill.query ?? "").slice(0, 80)}") → rank {b.find_skill.rank} of {b.find_skill.results}, {b.find_skill.model_calls ?? 0} model calls</> : "find_skill"}</td></tr>
      <tr><td>Lookup time</td><td data-label="Agent A">none (no lookup)</td><td data-label="Agent B">{b.find_skill?.ms != null ? `${fmtDur(b.find_skill.ms)}, ${b.find_skill.model_calls ?? 0} model calls, $0` : "not recorded"}</td></tr>
      {rows.map(([label, f]) => <tr key={label}><td>{label}</td><td data-label="Agent A">{f(A)}</td><td data-label="Agent B">{f(B)}</td></tr>)}
      <tr className="total"><td><b>Total (lookup + run)</b></td><td data-label="Agent A"><b>{usd(A.usd)} · {fmtDur(A.executor_ms)}</b></td><td data-label="Agent B"><b>{usd(B.usd)} · {fmtDur((b.find_skill?.ms ?? 0) + (B.executor_ms ?? 0))}</b></td></tr>
      <tr><td>Failures on this task (signed history)</td><td data-label="Agent A">{coldFails.total ? `${coldFails.failed} of ${coldFails.total} cold benchmark runs failed` : "unknown"}</td><td data-label="Agent B">{d.trust ? <>{d.trust.runs_30d.failed} of {d.trust.runs_30d.failed + d.trust.runs_30d.verified} skill runs failed in 30 days{typeof d.trust.latest_failure === "object" ? <> (latest: {d.trust.latest_failure.reason})</> : null}</> : "unknown"}</td></tr>
      <tr><td>Signed run record</td><td data-label="Agent A" className="mono small"><a href="#cold">{String(A.record).slice(0, 18)}…</a> (benchmark_run)</td><td data-label="Agent B" className="mono small"><Link to={`/skills/runs/${B.record}`}>{String(B.record).slice(0, 18)}…</Link> (skill_run{B.self_healed ? ", self-healed" : ""})</td></tr>
    </tbody></table>
    <OtherAgents list={d.other_agents} slug={b.task.slug} />
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
    {!d.headline_eligible && <div className="verdict-box badv"><p>{!d.verified ? (!A.success && B.success ? `✗ The cold agent did not verify (the reusing agent did${B.outcome === "no_match" ? ": Verified: no hit" : ""})` : "✗ Not verified") : !d.reuse_cheaper ? "✗ Reuse was not cheaper than cold" : d.values_match === false ? "✗ The two agents returned different values" : "✗ The values were not compared (an older benchmark)"}: this benchmark is shown for the record only; headlines use the latest benchmark where both runs verified, reuse cost less, and both returned the same value.</p></div>}
    <History all={all} current={d.id} />
    <h2>Signed records</h2>
    <p className="small mono">benchmark {d.cid}<br />cold run {A.record}<br />replay {B.record}<br />signed by the node {d.record.author}</p>
    <p className="small muted">Raw: <a href={`${API}/v1/records/${d.cid}`}>benchmark</a> · <a href={`${API}/v1/records/${A.record}`}>cold run</a> · <a href={`${API}/v1/records/${B.record}`}>replay</a> · <a href={`${API}/v1/benchmarks/${d.id}`}>JSON</a>. Or check them with the MCP <code>verify_record</code> tool.</p>
    <SignatureCheck entries={[{ seq: d.seq, log: d.log, record: d.record }, ...(cold ? [cold.run] : [])]} />
  </article>;
}

/** Verified replays of the same skill by other registered identities (latest per identity), labeled honestly. */
function OtherAgents({ list, slug }: { list?: any[]; slug: string }) {
  if (!list?.length) return null;
  return <section aria-label="Another agent reuses it">
    <h2>Another agent reuses it</h2>
    <table className="tbl cards small"><thead><tr><th>Identity</th><th>Input</th><th>Result</th><th>Model calls · cost · time</th><th>Run</th></tr></thead><tbody>
      {list.map((x) => <tr key={x.did}>
        <td data-label="Identity"><b>{x.name}</b> <span className={`badge ${x.independent ? "" : "house"}`} title={x.label}>{x.independent ? "independent" : "own agent, not independent"}</span><br /><span className="muted mono">{short(x.did)}</span></td>
        <td data-label="Input" className="mono">{JSON.stringify(x.input)}</td>
        <td data-label="Result">✓ verified · {String(x.value ?? "(no value)")}</td>
        <td data-label="Calls · cost · time">{n(x.model_calls)} · {usd(x.usd)} · {fmtDur(x.executor_ms)}</td>
        <td data-label="Run"><Link to={`/skills/runs/${x.run}`}>{ago(x.at)}</Link></td>
      </tr>)}
    </tbody></table>
    <p className="small muted">Verified replays of {slug} by registered identities other than the two benchmark agents, the operator and anonymous public trials (latest per identity), from the signed log. {list.every((x) => !x.independent) ? "None of them is independent of the operator yet." : ""}</p>
  </section>;
}

function Method({ m }: { m?: Record<string, string> }) {
  if (!m) return null;
  const items: [string, string][] = [["Same input", m.same_input], ["Fresh identities", m.identities], ["Agent A (cold)", m.agent_a], ["Agent B (reuse)", m.agent_b], ["What counts as a model call", m.model_call], ["Cost", m.cost], ["Time", m.time], ["Not counted", m.not_counted]];
  return <><h2>Method</h2><dl className="method">{items.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></>;
}

/** Every published benchmark, newest first, labeled (only verified + reuse-cheaper ones make the headline). */
function History({ all, current }: { all: any[]; current?: string }) {
  if (!all?.length) return null;
  return <section aria-label="Benchmark history">
    <h2>All benchmarks</h2>
    <ul className="small">{all.map((x) => <li key={x.id}>
      <span className={x.headline_eligible ? "good" : "badv"}>{!x.verified ? (!x.record?.body?.runs?.cold?.success && x.record?.body?.runs?.reuse?.success ? (x.record.body.runs.reuse.outcome === "no_match" ? "✗ cold did not verify; reuse: Verified: no hit" : "✗ cold did not verify; reuse verified") : "✗ unverified") : !x.reuse_cheaper ? "✗ verified, reuse not cheaper" : x.values_match === true ? "✓ verified, reuse cheaper, same value" : x.values_match === false ? "✗ values differ" : "✗ values not compared"}</span>{" "}
      {x.id === current ? <b>{ago(x.created_at)}</b> : <Link to={`/benchmark?id=${x.id}`}>{ago(x.created_at)}</Link>}
      {" · "}{x.record?.body?.task?.slug} <code>{JSON.stringify(x.record?.body?.input ?? {})}</code>
      {" · "}{x.record?.body?.runs?.reuse?.model_calls} vs {x.record?.body?.runs?.cold?.model_calls} model calls
    </li>)}</ul>
  </section>;
}
