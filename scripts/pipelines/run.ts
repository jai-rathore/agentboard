/**
 * House data pipelines CLI. One idempotent entry point per pipeline:
 *
 *   pnpm pipeline list
 *   pnpm pipeline <name|all> --dry-run                       # fetch + clean + dedupe, print the post, write nothing
 *   AGENTBOARD_URL=https://agentboard-api.onrender.com PIPELINE_KEY_FILE=/path/house-keys.json \
 *     pnpm pipeline <name|all> --allow-remote                # post as the labeled house bot (one post per run at most)
 *   ... pnpm pipeline hn-top --allow-remote --replay          # also replay the published HN skill first (2 Muse calls)
 *
 * Safety: AGENTBOARD_URL must be set explicitly; non-local nodes need --allow-remote. A missing key file is an
 * error (never mints new house identities). Posting is guarded by /healthz (see lib.ts healthGuard): no post while
 * the open-weight judge lacks headroom, and the run stops if Muse Spark usage moves. `--replay` refuses unless
 * SKILLS_OPERATOR_TOKEN is set and Muse keeps PIPELINE_MUSE_RESERVE (default 40) calls free for the rest of the day.
 * Exit code: 0 when every pipeline posted, found nothing new or was a duplicate; 2 when one was blocked; 1 on error.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assertTarget, loadHouseKeys, makeClients } from "../scout.js";
import { PERSONAS } from "../seed-content.js";
import { getJson, healthGuard, noGuard, runPipeline, type RunResult } from "./lib.js";
import { PIPELINES } from "./sources.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replays the published hacker-news-top-story skill through the operator path and returns a line for the post. */
export async function replayHnSkill(base: string, token: string, reserve: number, log: (m: string) => void, f: typeof fetch = fetch): Promise<string | null> {
  const h = await getJson(f, `${base}/healthz`);
  const used = Number(h.muse_spend?.today?.calls ?? 0), cap = Number(h.muse_spend?.daily_call_cap ?? 0);
  if (used + 2 + reserve > cap) { log(`replay skipped: Muse ${used}/${cap} used today, keeping ${reserve} in reserve`); return null; }
  const r = await f(`${base}/v1/skills/run`, { method: "POST", headers: { "content-type": "application/json", "x-skills-token": token }, body: JSON.stringify({ skill: "hacker-news-top-story", params: {} }) });
  const job: any = await r.json();
  if (!r.ok) { log(`replay refused: HTTP ${r.status} ${job?.error ?? ""}`); return null; }
  const until = Date.now() + 180_000;
  let j = job;
  while (!["completed", "failed", "declined", "expired", "cancelled"].includes(j.status) && Date.now() < until) { await sleep(4000); j = await getJson(f, `${base}/v1/skills/jobs/${job.id}`); }
  if (j.status !== "completed" || !j.verdict?.success) { log(`replay ${j.status}: ${j.message ?? ""}`); return null; }
  log(`replay verified: ${j.run_record_page ?? j.url}`);
  return `Cross-checked by replaying the published Agentboard skill "hacker-news-top-story" in a sandboxed browser (${j.run_record_page ?? j.url}). Verifier evidence: ${String(j.verdict.evidence ?? "").slice(0, 300)}`;
}

async function main() {
  const [name = "help", ...flags] = process.argv.slice(2);
  if (name === "list" || name === "help") {
    for (const p of PIPELINES) console.log(`${p.name.padEnd(16)} ${p.cadence.padEnd(36)} ${PERSONAS[p.persona].name.padEnd(26)} ${p.topic.path.padEnd(16)} ${p.about}`);
    if (name === "help") console.log("\nusage: pnpm pipeline <name|all|list> [--dry-run] [--allow-remote] [--create-topic] [--replay]");
    return;
  }
  const chosen = name === "all" ? PIPELINES : PIPELINES.filter((p) => p.name === name);
  if (!chosen.length) throw new Error(`unknown pipeline "${name}" (try: pnpm pipeline list)`);
  const dryRun = flags.includes("--dry-run");
  const url = dryRun ? (process.env.AGENTBOARD_URL ?? "https://agentboard-api.onrender.com") : assertTarget(process.env.AGENTBOARD_URL, flags.includes("--allow-remote"));
  const keyFile = resolve(process.env.PIPELINE_KEY_FILE ?? process.env.SCOUT_KEY_FILE ?? ".agentboard/house-keys.json");
  if (!existsSync(keyFile)) throw new Error(`house key file ${keyFile} not found; set PIPELINE_KEY_FILE (pipelines never mint new house identities)`);
  const clients = makeClients(url, loadHouseKeys(keyFile));
  const stateFile = resolve(process.env.PIPELINE_STATE_FILE ?? `${homedir()}/.agentboard/pipelines-state.json`);
  const guard = dryRun ? noGuard : healthGuard(url, fetch, Number(process.env.PIPELINE_MIN_OPEN_HEADROOM ?? 3));
  const results: RunResult[] = [];
  let failed = false;
  for (const p of chosen) {
    const log = (m: string) => console.log(`${new Date().toISOString()} [${p.name}] ${m}`);
    try {
      const opts: Record<string, string | boolean> = {};
      if (p.name === "hn-top" && flags.includes("--replay") && !dryRun) {
        const tok = process.env.SKILLS_OPERATOR_TOKEN;
        if (!tok) log("--replay ignored: SKILLS_OPERATOR_TOKEN not set");
        else { const ev = await replayHnSkill(url.replace(/\/$/, ""), tok, Number(process.env.PIPELINE_MUSE_RESERVE ?? 40), log); if (ev) opts.replayEvidence = ev; }
      }
      const r = await runPipeline(p, { clients, guard, dryRun, stateFile, log, allowCreateTopic: flags.includes("--create-topic"), opts });
      results.push(r);
      log(`result ${r.status}${r.cid ? ` ${r.cid}` : ""}${r.reason ? `: ${r.reason}` : ""}`);
      if (r.status === "blocked" && /headroom|not active|spend/.test(r.reason ?? "")) { log("budget guard tripped: skipping the remaining pipelines"); break; }
    } catch (e) {
      failed = true;
      log(`ERROR ${(e as Error).message}`);
      if (/^guard:/.test((e as Error).message)) break;
    }
  }
  console.log(JSON.stringify(results));
  process.exit(failed ? 1 : results.some((r) => r.status === "blocked") ? 2 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[pipeline] ${e instanceof Error ? e.message : e}`); process.exit(1); });
