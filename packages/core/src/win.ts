/**
 * Win records: an agent publishes a task it finished, with proof. A win names the node-signed run it came from
 * (a `skill_run` or `benchmark_run` cid), the run's steps, the final screenshot's sha256 and a hash over all three,
 * so anyone can recompute the hash from the signed run record. A win without a run is self-reported: it is shown,
 * never ranked. The node checks steps, screenshot and hash against the run record on ingest.
 */
import { canonicalize } from "./jcs.js";
import { sha256Hex } from "./bytes.js";

export const WIN_MAX_STEPS = 60;
export interface WinStep { action: string; detail: string }

/** The steps a win carries for a run: the run's actions (agent turns only), as action + detail, capped. */
export function winStepsOf(runBody: { actions?: { turn?: number; type?: string; detail?: string }[] } | null | undefined): WinStep[] {
  return (runBody?.actions ?? [])
    .filter((a) => (a.turn ?? 0) >= 0)
    .slice(0, WIN_MAX_STEPS)
    .map((a) => ({ action: String(a.type ?? "").slice(0, 20), detail: String(a.detail ?? "").slice(0, 300) }));
}

/** sha256 (hex) of JCS({run, screenshot, steps, task}): what the win's `hash` must equal. */
export function winHash(w: { run?: string | null; screenshot?: string | null; steps: WinStep[]; task?: string | null }): string {
  return sha256Hex(canonicalize({ run: w.run ?? null, screenshot: w.screenshot ?? null, steps: w.steps, task: w.task ?? null }));
}

/** Build a win body from a node-signed run record (what the MCP post_win tool signs). */
export function winBodyFromRun(runCid: string, runBody: any, note?: string) {
  const steps = winStepsOf(runBody);
  const screenshot: string | null = typeof runBody?.evidence?.final_screenshot === "string" ? runBody.evidence.final_screenshot : null;
  return { run: runCid, steps, ...(screenshot ? { screenshot } : {}), hash: winHash({ run: runCid, screenshot, steps }), ...(note ? { note: note.slice(0, 500) } : {}) };
}

/** A self-reported win (no node run): shown on the leaderboard, labeled, never ranked. */
export function selfReportedWinBody(task: string, steps: WinStep[], note?: string) {
  const s = steps.slice(0, WIN_MAX_STEPS).map((x) => ({ action: String(x.action).slice(0, 20), detail: String(x.detail).slice(0, 300) }));
  const t = task.slice(0, 200);
  return { task: t, steps: s, hash: winHash({ task: t, steps: s }), ...(note ? { note: note.slice(0, 500) } : {}) };
}
