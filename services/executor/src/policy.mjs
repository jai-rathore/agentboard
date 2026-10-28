// Pure helpers for the executor (no dependencies, unit-tested): approval policy, prompts, action text.

/** Risk flags that make a committing action (submit, buy, send, delete) need a human. */
export const HUMAN_GATED_FLAGS = ["submits_form", "sends_message", "purchase", "deletes_data"];
const COMMIT_WORDS = /\b(submit|create|send|post|buy|order|pay|checkout|purchase|place|confirm|delete|remove|destroy|publish|save|transfer|book|reserve)\b/i;

/**
 * Decide whether an action may run on its own.
 *   - typing, scrolling, moving, waiting, screenshots and navigation: auto-approved
 *   - a click (or Enter) that lands on a committing control (button/link/submit whose label reads like
 *     submit/buy/send/delete) on a skill flagged submits_form/sends_message/purchase/deletes_data: human
 *   - any Meta safety check other than computer_action_requires_confirmation: human
 * `el` is what document.elementFromPoint (or the focused element, for Enter) returned.
 */
export function approvalFor(action, el, riskFlags = [], checks = []) {
  const unusual = checks.filter((c) => c !== "computer_action_requires_confirmation");
  if (unusual.length) return { approval: "human", reason: `Meta safety check: ${unusual.join(", ")}` };
  const gated = riskFlags.filter((f) => HUMAN_GATED_FLAGS.includes(f));
  const isEnter = action.type === "keypress" && (action.keys ?? []).some((k) => /^(enter|return)$/i.test(k));
  const isClick = action.type === "click" || action.type === "double_click";
  if (!isClick && !isEnter) return { approval: "auto", reason: `${action.type} is auto-approved` };
  if (!gated.length) return { approval: "auto", reason: "skill has no submit/buy/send/delete risk flags" };
  if (!el) return isClick ? { approval: "auto", reason: "click on empty space" } : { approval: "auto", reason: "Enter outside a form" };
  const label = `${el.text ?? ""} ${el.value ?? ""} ${el.aria ?? ""}`.trim();
  const committing = (el.tag === "button" || el.tag === "a" || el.role === "button" || (el.tag === "input" && /^(submit|button|image)$/i.test(el.type ?? "")))
    ? COMMIT_WORDS.test(label) || /^(submit)$/i.test(el.type ?? "")
    : isEnter && el.inForm;
  if (!committing) return { approval: "auto", reason: `${isClick ? "click" : "Enter"} on ${el.tag}${label ? ` "${label.slice(0, 40)}"` : ""} does not commit anything` };
  return { approval: "human", reason: `${isClick ? "clicking" : "pressing Enter on"} ${el.tag}${label ? ` "${label.slice(0, 40)}"` : ""} may ${gated.map((f) => f.replace("_", " ")).join(" / ")}` };
}

/** Replace {{param}} placeholders. Unknown placeholders are left as-is. */
export const fill = (s, params) => String(s ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (m, k) => (k in params ? params[k] : m));

export const LOOP_INSTRUCTIONS = `You are a computer-use agent operating a web browser through screenshots (960x600 pixels).
Coordinates are pixels in the CURRENT screenshot: (0,0) is the top-left. Click the center of the target element.
You only see the latest screenshot; a text log of what you already did is provided. Do not repeat steps that the screenshot shows are done.
Batch actions only when they do not depend on new visual feedback (for example click a field, then type). Do not batch across submits or page changes.
Native dropdowns (<select>) do not render their option list in screenshots: click the dropdown once, then call the select_option function with the visible option text.
Finish with a short normal message (no computer call) once the success check is visibly met, or explain briefly why the task cannot be completed.`;

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

export const VERIFY_SCHEMA = { type: "object", additionalProperties: false, required: ["success", "evidence"], properties: { success: { type: "boolean" }, evidence: { type: "string", description: "one or two sentences quoting what is visible" } } };
