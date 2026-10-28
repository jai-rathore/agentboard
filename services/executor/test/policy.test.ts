import { describe, it, expect } from "vitest";
import { approvalFor, fill, playwrightKey, taskText, gatedSteps, effectiveRiskFlags, nameOf } from "../src/policy.mjs";
import * as core from "../../../packages/core/src/skillSafety";

const skill = { risk_flags: ["submits_form", "personal_data"], steps: [{ intent: "enter email", target: "Customer email input", action: "type", value: "{{e}}" }, { intent: "submit", target: "blue Create ticket button", action: "click", value: "" }] };
const unflagged = { risk_flags: ["personal_data"], steps: skill.steps };
describe("executor approval policy", () => {
  it("auto-approves typing, scrolling and navigation", () => {
    for (const a of [{ type: "type", text: "x" }, { type: "scroll" }, { type: "navigate" }, { type: "wait" }]) expect(approvalFor(a, null, skill).approval).toBe("auto");
  });
  it("auto-approves clicks on fields and dropdowns", () => {
    expect(approvalFor({ type: "click" }, { tag: "input", type: "text", text: "" }, skill).approval).toBe("auto");
    expect(approvalFor({ type: "click" }, { tag: "select", text: "Normal" }, skill).approval).toBe("auto");
    expect(approvalFor({ type: "click" }, { tag: "a", text: "Tickets" }, skill).approval).toBe("auto");
  });
  it("submit, buy, send and delete ALWAYS need a human, whatever the recorder's flags say", () => {
    for (const s of [skill, unflagged, { risk_flags: [], steps: [] }, undefined]) {
      expect(approvalFor({ type: "click" }, { tag: "button", text: "Create ticket" }, s).approval).toBe("human");
      expect(approvalFor({ type: "click" }, { tag: "button", text: "Place order" }, s).flags).toContain("purchase");
      expect(approvalFor({ type: "click" }, { tag: "button", text: "Send" }, s).flags).toContain("sends_message");
      expect(approvalFor({ type: "click" }, { tag: "a", role: "button", text: "Delete account" }, s).flags).toContain("deletes_data");
      expect(approvalFor({ type: "click" }, { tag: "input", type: "submit", value: "Go" }, s).approval).toBe("human");
      expect(approvalFor({ type: "keypress", keys: ["Enter"] }, { tag: "input", type: "text", inForm: true }, s).approval).toBe("human");
      expect(approvalFor({ type: "keypress", keys: ["SPACE"] }, { tag: "button", text: "Submit request" }, s).approval).toBe("human");
    }
    expect(approvalFor({ type: "keypress", keys: ["Enter"] }, { tag: "input", type: "text", inForm: false }, skill).approval).toBe("auto");
  });
  it("unusual Meta safety checks need a human", () => {
    expect(approvalFor({ type: "type" }, null, skill, ["malicious_instructions"]).approval).toBe("human");
    expect(approvalFor({ type: "type" }, null, skill, ["computer_action_requires_confirmation"]).approval).toBe("auto");
  });
  it("infers gated steps and flags from the steps' words (same as @agentboard/core)", () => {
    const cases = [skill, unflagged, { risk_flags: ["purchase"], steps: [{ intent: "pick", target: "size M", action: "click", value: "" }, { intent: "go", target: "big yellow button", action: "click", value: "" }] }, { risk_flags: [], steps: [{ intent: "remove item", target: "trash icon", action: "click", value: "" }] }, { risk_flags: ["none"], steps: [{ intent: "search", target: "box", action: "type", value: "x" }] }];
    for (const c of cases) { expect(gatedSteps(c)).toEqual(core.gatedSteps(c)); expect(effectiveRiskFlags(c)).toEqual(core.effectiveRiskFlags(c)); }
    expect(effectiveRiskFlags(unflagged)).toEqual(["personal_data", "submits_form"]);
    expect(gatedSteps(cases[2])).toEqual([{ index: 1, flags: ["purchase"] }]);
    expect(effectiveRiskFlags(cases[4])).toEqual(["none"]);
  });
  it("names elements the way a person reads them", () => {
    expect(nameOf({ tag: "input", label: "Customer email\nfoo", placeholder: "name@example.com" })).toBe("Customer email");
    expect(nameOf({ tag: "button", text: "Submit request" })).toBe("Submit request");
    expect(nameOf(null)).toBe("");
  });
});
describe("executor helpers", () => {
  it("fills params and maps keys", () => {
    expect(fill("hi {{name}} {{other}}", { name: "Bob" })).toBe("hi Bob {{other}}");
    expect(playwrightKey(["CTRL", "a"])).toBe("Control+a");
    expect(playwrightKey(["Down"])).toBe("ArrowDown");
    expect(taskText({ name: "N", summary: "S", steps: [{ intent: "i", action: "type", target: "t", value: "{{e}}" }], success_check: "see {{e}}" }, { e: "x@y.z" })).toMatch(/see x@y.z/);
  });
});
