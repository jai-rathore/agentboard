import { describe, it, expect } from "vitest";
import { approvalFor, fill, playwrightKey, taskText } from "../src/policy.mjs";

const flags = ["submits_form", "personal_data"];
describe("executor approval policy", () => {
  it("auto-approves typing, scrolling and navigation", () => {
    for (const a of [{ type: "type", text: "x" }, { type: "scroll" }, { type: "navigate" }, { type: "wait" }]) expect(approvalFor(a, null, flags).approval).toBe("auto");
  });
  it("auto-approves clicks on inputs and dropdowns", () => {
    expect(approvalFor({ type: "click" }, { tag: "input", type: "text", text: "" }, flags).approval).toBe("auto");
    expect(approvalFor({ type: "click" }, { tag: "select", text: "Normal" }, flags).approval).toBe("auto");
  });
  it("needs a human to submit, buy, send or delete on a risky skill", () => {
    expect(approvalFor({ type: "click" }, { tag: "button", text: "Create ticket" }, flags).approval).toBe("human");
    expect(approvalFor({ type: "click" }, { tag: "button", text: "Place order" }, ["purchase"]).approval).toBe("human");
    expect(approvalFor({ type: "click" }, { tag: "input", type: "submit", value: "Go" }, flags).approval).toBe("human");
    expect(approvalFor({ type: "keypress", keys: ["Enter"] }, { tag: "input", type: "text", inForm: true }, flags).approval).toBe("human");
  });
  it("lets the same click through when the skill has no committing risk", () => {
    expect(approvalFor({ type: "click" }, { tag: "button", text: "Create ticket" }, ["personal_data"]).approval).toBe("auto");
  });
  it("escalates unusual Meta safety checks", () => {
    expect(approvalFor({ type: "type" }, null, [], ["malicious_instructions"]).approval).toBe("human");
    expect(approvalFor({ type: "type" }, null, [], ["computer_action_requires_confirmation"]).approval).toBe("auto");
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
