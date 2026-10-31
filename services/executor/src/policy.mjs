// Pure helpers for the executor (no dependencies, unit-tested): approval policy, prompts, action text.

// ---- safety: copy of packages/core/src/skillSafety.ts (a test keeps them identical in behaviour)
export const GATED_FLAGS = ["submits_form", "sends_message", "purchase", "deletes_data"];
export const FLAG_WORDS = {
  submits_form: /\b(submit|create|file|save|post|confirm|register|sign ?up|apply|update)\b/i,
  sends_message: /\b(send|reply|invite|share|tweet|message)\b/i,
  purchase: /\b(buy|order|pay|checkout|check out|purchase|subscribe|book|reserve|place)\b/i,
  deletes_data: /\b(delete|remove|destroy|erase|cancel|archive|clear|discard)\b/i,
};
const commits = (s) => s.action === "click" || s.action === "keypress";
export const SEARCH_WORDS = /\b(search(es|ing)?|query|look ?up|find)\b/i;
export function isSearchSubmit(s) {
  if (!commits(s)) return false;
  const text = `${s.intent} ${s.target}`;
  if (!SEARCH_WORDS.test(text)) return false;
  return GATED_FLAGS.every((f) => f === "submits_form" || !FLAG_WORDS[f].test(text));
}
function explainedBySearch(skill) {
  const c = skill.steps.filter(commits);
  return c.some(isSearchSubmit) && !c.some((s) => !isSearchSubmit(s) && FLAG_WORDS.submits_form.test(`${s.intent} ${s.target}`));
}
function declaredGated(skill) {
  const d = (skill.risk_flags ?? []).filter((f) => GATED_FLAGS.includes(f));
  return explainedBySearch(skill) ? d.filter((f) => f !== "submits_form") : d;
}
export function gatedSteps(skill) {
  const out = [];
  skill.steps.forEach((s, index) => {
    if (!commits(s) || isSearchSubmit(s)) return;
    const text = `${s.intent} ${s.target}`;
    const flags = GATED_FLAGS.filter((f) => FLAG_WORDS[f].test(text));
    if (flags.length) out.push({ index, flags });
  });
  const declared = declaredGated(skill);
  if (declared.length && !out.length) {
    const last = skill.steps.map((s, i) => [s, i]).filter(([s]) => commits(s)).pop();
    if (last) out.push({ index: last[1], flags: declared });
  }
  return out;
}
export function effectiveRiskFlags(skill) {
  const searchOnly = explainedBySearch(skill);
  const set = new Set((skill.risk_flags ?? []).filter((f) => f !== "none" && !(f === "submits_form" && searchOnly)));
  for (const g of gatedSteps(skill)) for (const f of g.flags) set.add(f);
  return set.size ? [...set] : ["none"];
}

/** Words on a control that make activating it a commit (submit, buy, send, delete, ...). */
const COMMIT_WORDS = /\b(submit|create|send|post|buy|order|pay|checkout|purchase|place|confirm|delete|remove|destroy|publish|save|transfer|book|reserve|reply|share|subscribe|cancel|erase|archive|apply|register|update|file)\b/i;
const SEARCH_LABEL = /^(search|search now|find|look ?up|lookup|query)$/i;
const flagsFor = (label, effective) => {
  const hit = GATED_FLAGS.filter((f) => FLAG_WORDS[f].test(label));
  return hit.length ? hit : effective.filter((f) => GATED_FLAGS.includes(f));
};

/**
 * Decide whether an action may run on its own. Committing actions ALWAYS wait for a human, whatever the
 * recorder's risk flags say:
 *   - typing, scrolling, moving, waiting and screenshots: auto-approved
 *   - a click, or Enter/Space, on a committing control (button, link, submit input whose label reads like
 *     submit/buy/send/delete/...), or Enter inside a form: human
 *   - any Meta safety check other than computer_action_requires_confirmation: human
 * `el` is what document.elementFromPoint (or the focused element, for keys) returned; `skill` gives the
 * effective risk flags used in the reason.
 */
export function approvalFor(action, el, skill = { steps: [], risk_flags: [] }, checks = []) {
  const unusual = checks.filter((c) => c !== "computer_action_requires_confirmation");
  if (unusual.length) return { approval: "human", reason: `Meta safety check: ${unusual.join(", ")}`, flags: [] };
  const keys = action.type === "keypress" ? (action.keys ?? []).map((k) => String(k).toLowerCase()) : [];
  const isEnter = keys.some((k) => k === "enter" || k === "return");
  const isSpace = keys.some((k) => k === "space" || k === " ");
  const isClick = action.type === "click" || action.type === "double_click";
  if (!isClick && !isEnter && !isSpace) return { approval: "auto", reason: `${action.type} is auto-approved`, flags: [] };
  if (!el) return { approval: "auto", reason: isClick ? "click on empty space" : "key outside any control", flags: [] };
  const label = `${el.text ?? ""} ${el.value ?? ""} ${el.aria ?? ""}`.trim();
  const control = el.tag === "button" || el.tag === "a" || el.role === "button" || (el.tag === "input" && /^(submit|button|image)$/i.test(el.type ?? ""));
  // A read-only lookup form (role=search, a type=search box, or an explicit method="get" form with one
  // text field and no email/password) only navigates to results, so Enter or its search button is fine.
  if (el.lookupForm && (!control || !COMMIT_WORDS.test(`${el.text ?? ""} ${el.aria ?? ""} ${control && el.tag === "input" ? el.value ?? "" : ""}`))) {
    return { approval: "auto", reason: `${isClick ? "click" : isEnter ? "Enter" : "Space"} in a read-only search/lookup form (GET) does not commit anything`, flags: [] };
  }
  // A button whose whole label is a search verb ("Search", "Find", "Look up") only queries, even when the page's one big
  // form posts (ASP.NET WebForms: OFAC's sanctions search, Florida's license search). Anything with a commit word still waits.
  if (isClick && control && SEARCH_LABEL.test(label) && !COMMIT_WORDS.test(label)) {
    return { approval: "auto", reason: `click on ${el.tag} "${label.slice(0, 40)}" is a search button: it only queries`, flags: [] };
  }
  const committing = control ? COMMIT_WORDS.test(label) || /^submit$/i.test(el.type ?? "") : isEnter && el.inForm;
  const what = `${isClick ? "click" : isEnter ? "Enter" : "Space"} on ${el.tag}${label ? ` "${label.slice(0, 40)}"` : ""}`;
  if (!committing) return { approval: "auto", reason: `${what} does not commit anything`, flags: [] };
  const flags = flagsFor(label, effectiveRiskFlags(skill));
  return { approval: "human", reason: `${what} ${flags.length ? `${flags.map((f) => f.replace("_", " ")).join(" / ")}` : "commits an action"}: a human must approve`, flags: flags.length ? flags : ["submits_form"] };
}

/**
 * Runs inside the page (page.evaluate(inspectInPage, { a })), so it must stay self-contained: what is under the
 * pointer (or focused, for keys), for the approval policy and the select_option helper. lookupForm: a read-only
 * search/lookup form (role=search, a type=search box, an explicit or default GET form whose single text field or
 * action says search/query), where Enter or the search button only navigates to results.
 */
export function inspectInPage({ a }) {
    let el = (a.type === "click" || a.type === "double_click") ? document.elementFromPoint(a.x, a.y) : (a.type === "keypress" || a.type === "type" ? document.activeElement : null);
    if (!el || el === document.body) return null;
    const btn = el.closest("button, a, [role=button], input, select, textarea, label");
    if (btn?.tagName === "LABEL") el = btn.querySelector("input, select, textarea") ?? btn; else if (btn) el = btn;
    if (el.tagName === "SELECT") window.__abLastSelect = el;
    return {
      tag: el.tagName.toLowerCase(), type: el.getAttribute("type") ?? "", role: el.getAttribute("role") ?? "",
      text: (el.innerText ?? "").trim().slice(0, 80), value: (el.tagName === "SELECT" ? el.options[el.selectedIndex]?.text : el.value ?? "")?.toString().slice(0, 80) ?? "",
      label: ((el.labels?.[0] ?? el.closest("label"))?.innerText ?? "").split("\n")[0].trim().slice(0, 80),
      aria: el.getAttribute("aria-label") ?? "", placeholder: el.getAttribute("placeholder") ?? "", inForm: Boolean(el.closest("form")),
      lookupForm: (() => {
        const f = el.closest("form");
        if (!f) return false;
        // exactly one visible free-text field (selects such as "search in: all fields" are fine), never email/password/phone
        const fields = [...f.querySelectorAll("input, textarea")].filter((x) => !/^(hidden|submit|button|image|reset|checkbox|radio)$/i.test(x.getAttribute("type") ?? "") && x.offsetParent !== null);
        if (fields.length !== 1 || fields[0].tagName !== "INPUT" || /^(email|password|tel)$/i.test(fields[0].type) || /mail|pass|phone/i.test(fields[0].name ?? "")) return false;
        // GET is the HTML default when a form names no method; POST (or dialog) forms are never lookups
        const method = (f.getAttribute("method") ?? "get").toLowerCase();
        if (method !== "get") return false;
        if (f.getAttribute("method") || f.closest("[role=search]") || f.getAttribute("role") === "search" || fields[0].type === "search") return true;
        // a method-less form whose one field or action says search/query (name="q", placeholder "Search gems", action="/search")
        const hint = [fields[0].name, fields[0].id, fields[0].placeholder, fields[0].getAttribute("aria-label"), f.getAttribute("action"), f.id, f.className].join(" ");
        return /(^|[^a-z])(search|query|q|find|lookup)([^a-z]|$)/i.test(hint);
      })(),
      options: el.tagName === "SELECT" ? [...el.options].map((o) => o.text).slice(0, 30) : undefined,
    };
}

/** The element's accessible name, as a person would read it (label, aria-label, button text, placeholder). */
export const nameOf = (el) => (el ? (el.label || el.aria || (["button", "a"].includes(el.tag) ? el.text : "") || el.placeholder || el.text || "").split("\n")[0].trim().slice(0, 80) : "");

/** Replace {{param}} placeholders. Unknown placeholders are left as-is. */
export const fill = (s, params) => String(s ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => (k in params ? params[k] : m));

export const LOOP_INSTRUCTIONS = `You are a computer-use agent operating a web browser through screenshots (960x600 pixels).
Coordinates are pixels in the CURRENT screenshot: (0,0) is the top-left. Click the center of the target element.
You only see the latest screenshot; a text log of what you already did is provided. Do not repeat steps that the screenshot shows are done.
Batch actions only when they do not depend on new visual feedback (for example click a field, then type). Do not batch across submits or page changes.
Native dropdowns (<select>) do not render their option list in screenshots: click the dropdown once, then call the select_option function with the visible option text.
To bring a known label or value into view (for example an infobox or table row such as "Population"), call scroll_to_text with that text instead of scrolling repeatedly.
If a recorded step's target looks different on screen (renamed, relabeled, moved or restyled), still do the step on the element that now serves that purpose, and in the same response call report_step_change for that step number describing what you see now.
Finish with a short normal message (no computer call) once the success check is visibly met, or explain briefly why the task cannot be completed.`;

export const FIND_TOOL = { type: "function", name: "scroll_to_text", description: "Scroll the page so the first visible element containing this text (case-insensitive; e.g. a table or infobox row label) is centered in view. Returns whether it was found.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } };

export const STEP_TOOL = { type: "function", name: "report_step_change", description: "Report that recorded step N's target looks different now (renamed, relabeled, moved or restyled). Call it alongside the action that does the step.", parameters: { type: "object", properties: { step: { type: "integer" }, observed: { type: "string", description: "what the element looks like now: its label/text and position" } }, required: ["step", "observed"], additionalProperties: false } };

export function taskText(skill, params) {
  const steps = skill.steps.map((s, i) => `${i + 1}. ${s.intent}: ${s.action} ${s.target}${s.value ? ` -> "${fill(s.value, params)}"` : ""}`).join("\n");
  return `Task: ${skill.name}. ${skill.summary}\nRecorded steps (adapt to what you see):\n${steps}\nParameters: ${JSON.stringify(params)}\nSuccess check: ${fill(skill.success_check, params)}`;
}

export function describeAction(a) {
  switch (a.type) {
    case "click": case "double_click": return `${a.type} (${a.x},${a.y})`;
    case "type": return `type "${String(a.text).slice(0, 80)}"`;
    case "keypress": return `keypress ${(a.keys ?? []).join("+")}`;
    case "scroll": return `scroll (${a.scroll_x ?? 0},${a.scroll_y ?? 0}) at (${a.x},${a.y})`;
    case "select_option": return `select_option "${a.option}"`;
    case "navigate": return `navigate ${a.url}`;
    default: return a.type;
  }
}

const KEYS = { ENTER: "Enter", RETURN: "Enter", TAB: "Tab", ESC: "Escape", ESCAPE: "Escape", CTRL: "Control", CONTROL: "Control", CMD: "Meta", META: "Meta", ALT: "Alt", SHIFT: "Shift", SPACE: " ", BACKSPACE: "Backspace", DELETE: "Delete", DOWN: "ArrowDown", UP: "ArrowUp", LEFT: "ArrowLeft", RIGHT: "ArrowRight", ARROWDOWN: "ArrowDown", ARROWUP: "ArrowUp", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight", PAGEDOWN: "PageDown", PAGEUP: "PageUp", HOME: "Home", END: "End" };
export const playwrightKey = (keys) => (keys ?? []).map((k) => KEYS[String(k).toUpperCase()] ?? (String(k).length === 1 ? String(k) : String(k)[0].toUpperCase() + String(k).slice(1).toLowerCase())).join("+");

export const VERIFY_SCHEMA = { type: "object", additionalProperties: false, required: ["success", "evidence", "value"], properties: { success: { type: "boolean" }, evidence: { type: "string", description: "one or two sentences quoting what is visible" }, value: { type: "string", description: "only the value the task asks for (a version, number, rate, title...) copied exactly as shown, without its label; empty when none is visible" } } };
