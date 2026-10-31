/**
 * Is a run's returned value tied to its inputs? A replay with parameters must read the answer FOR those inputs:
 * a value read from a fixed, recorded element (the first row of a rates table) can be the right page but the wrong
 * row. Every parameter must be bound by one of:
 *   url  the final page is specific to it: the run's trace has {{param}} in its final URL, or the final URL contains
 *        the value (decoded; spaces as _ / + / %20)
 *   title the final page's title shows its value (a search that landed on that article)
 *   row  the value was read from the table/infobox row whose label names it (answer.source `... row "<label>"`)
 * A run with no returned value (or no parameters) makes no value claim: nothing to bind (the verifier's judgment
 * stands). The executor runs the same check before it calls a value verified (services/executor/src/trace.mjs,
 * kept identical by a test), and the node folds it over old records, so a mirror gets the same answer.
 */
export interface BindingResult { ok: boolean; checked: boolean; by: Record<string, "url" | "title" | "row">; missing: string[]; reason: string }

const norm = (s: unknown) => String(s ?? "").normalize("NFC").toLowerCase().replace(/[\s_+]+/g, " ").replace(/\s+/g, " ").trim();
const words = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
const decode = (u: string) => { try { return decodeURIComponent(u.replace(/\+/g, " ")); } catch { return u; } };

/** The row label an answer was read from: `infobox/table row "Population › City"` -> Population › City. */
export function answerRowLabel(source: unknown): string | null {
  const m = String(source ?? "").match(/row "(.*)"$/);
  return m ? m[1] : null;
}

export function valueBinding(input: { params?: Record<string, unknown>; value?: unknown; finalUrlTemplate?: string | null; finalUrl?: string | null; rowLabel?: string | null; titleParams?: string[] | null }): BindingResult {
  const params = Object.entries(input.params ?? {}).filter(([, v]) => String(v ?? "").trim().length >= 2);
  if (input.value == null || String(input.value).trim() === "" || !params.length) return { ok: true, checked: false, by: {}, missing: [], reason: input.value == null ? "no value returned: nothing to bind" : "no parameters: nothing to bind" };
  const tpl = String(input.finalUrlTemplate ?? ""), url = norm(decode(String(input.finalUrl ?? "")));
  const label = input.rowLabel ? norm(input.rowLabel) : null;
  const labelWords = label ? new Set(words(label)) : null;
  const by: BindingResult["by"] = {}, missing: string[] = [];
  for (const [k, v] of params) {
    const val = norm(v);
    if (new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "i").test(tpl) || (url && url.includes(val))) by[k] = "url";
    else if (input.titleParams?.includes(k)) by[k] = "title";
    else if (label && (label.includes(val) || (words(val).length > 0 && words(val).every((w) => labelWords!.has(w))))) by[k] = "row";
    else missing.push(k);
  }
  return missing.length
    ? { ok: false, checked: true, by, missing, reason: `the returned value is not tied to ${missing.map((k) => `${k} "${String(input.params![k]).slice(0, 60)}"`).join(", ")}: it was read from ${label ? `the "${input.rowLabel}" row` : "a fixed element"} on a page that is not specific to ${missing.length > 1 ? "them" : "it"}` }
    : { ok: true, checked: true, by, missing, reason: `value tied to the inputs (${Object.entries(by).map(([k, how]) => `${k}: ${how === "url" ? "page URL" : how === "title" ? "page title" : "row label"}`).join(", ")})` };
}

/** valueBinding for a signed skill_run / benchmark_run body (what the node folds over the log). */
export function runValueBinding(body: any): BindingResult {
  const a = body?.answer;
  const finalUrl = String(body?.verdict?.evidence ?? "").match(/Final URL (\S+?)\.?(?:\s|$)/)?.[1] ?? null;
  return valueBinding({ params: body?.params, value: a?.value ?? null, finalUrlTemplate: body?.trace?.final?.url ?? null, finalUrl, rowLabel: answerRowLabel(a?.source), titleParams: Array.isArray(body?.trace?.final?.title) ? body.trace.final.title : null });
}

/**
 * A verified negative ("Verified: no hit"): a skill that declares an empty-result signal (skill.empty_result.text, the
 * site's own "no results" wording) may end a run with outcome "no_match" when the final page shows that wording AND the
 * page is tied to every input: the input is in the final URL, echoed in the search field, carried by the search request
 * that loaded the page (a POST form), or shown on the page. Anything else that returns no value is "not verified".
 */
export const NO_MATCH_TIES = ["url", "field", "query", "page"] as const;
export function noMatchTie(body: any): { ok: boolean; by: Record<string, string>; missing: string[]; reason: string } {
  if (body?.outcome !== "no_match") return { ok: false, by: {}, missing: [], reason: "not a no-match run" };
  const nm = body?.no_match ?? {};
  const by: Record<string, string> = typeof nm.by === "object" && nm.by ? nm.by : {};
  if (!String(nm.signal ?? "").trim()) return { ok: false, by, missing: [], reason: "no empty-result signal was matched" };
  const params = Object.entries(body?.params ?? {}).filter(([, v]) => String(v ?? "").trim().length >= 2);
  const missing = params.filter(([k]) => !(NO_MATCH_TIES as readonly string[]).includes(by[k])).map(([k]) => k);
  return missing.length
    ? { ok: false, by, missing, reason: `the empty result is not tied to ${missing.join(", ")}` }
    : { ok: true, by, missing, reason: `the site said "${String(nm.signal).slice(0, 80)}" for exactly these inputs (${Object.entries(by).map(([k, how]) => `${k}: ${how === "field" ? "echoed in the search field" : how === "query" ? "sent in the search request" : how === "url" ? "page URL" : "shown on the page"}`).join(", ")})` };
}
/** A verified no-hit run (see noMatchTie). */
export const isNoMatch = (body: any) => body?.success === true && noMatchTie(body).ok;

/** A run counts as verified only when it succeeded and its value (if any) is tied to its inputs; a no-hit run, when its empty result is tied to its inputs. */
export const runVerified = (body: any) => body?.success === true && (body?.outcome === "no_match" ? noMatchTie(body).ok : runValueBinding(body).ok);
/** "verified" (a value), "no_match" (Verified: no hit) or "not_verified" (something broke, or the result is not tied to the inputs). */
export const runOutcome = (body: any): "verified" | "no_match" | "not_verified" => (isNoMatch(body) ? "no_match" : runVerified(body) ? "verified" : "not_verified");

/** When the executor started labeling a row value with the row it was actually read from (commit 560497b, live 16:18 UTC). */
export const ROW_LABEL_FIX_AT = "2026-10-29T16:18:05Z";
/**
 * The answer of a run record as shown today. Runs signed before ROW_LABEL_FIX_AT labeled a row value with the recipe's
 * sub-row hint appended ("Total length › City" for a bridge): the value was read under the field's row, not a "City"
 * sub-row. The signed record is unchanged; the display drops the stale hint and says so.
 */
export function displayAnswer(rec: { created_at?: string; body?: any } | null | undefined) {
  const a = rec?.body?.answer;
  if (!a || typeof a.source !== "string") return a ?? null;
  const sub = rec?.body?.trace?.extract?.sub;
  const m = a.source.match(/^(infobox\/table row ")(.*) › (.*)"$/);
  if (m && sub && m[3] === sub && String(rec?.created_at ?? "") < ROW_LABEL_FIX_AT) {
    return { ...a, source: `${m[1]}${m[2]}"`, source_signed: a.source, source_note: `Re-rendered: runs before ${ROW_LABEL_FIX_AT} appended the extraction recipe's sub-row hint ("› ${sub}") to the row label; the value was read under the "${m[2]}" row. The signed record keeps the original text.` };
  }
  return a;
}
