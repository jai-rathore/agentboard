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
  it("read-only search/lookup forms (GET) run without approval; everything else in a form still needs a human", () => {
    const enter = { type: "keypress", keys: ["ENTER"] };
    expect(approvalFor(enter, { tag: "input", type: "text", value: "order status 94103", inForm: true, lookupForm: true }, skill).approval).toBe("auto");
    expect(approvalFor({ type: "click" }, { tag: "input", type: "submit", value: "Go", inForm: true, lookupForm: true }, skill).approval).toBe("auto");
    expect(approvalFor({ type: "click" }, { tag: "button", text: "Search", inForm: true, lookupForm: true }, skill).approval).toBe("auto");
    // a committing word on the button itself still gates, even in a GET form
    expect(approvalFor({ type: "click" }, { tag: "button", text: "Subscribe", inForm: true, lookupForm: true }, skill).approval).toBe("human");
    // not a lookup form: Enter in a form is still gated
    expect(approvalFor(enter, { tag: "input", type: "text", value: "x", inForm: true, lookupForm: false }, skill).approval).toBe("human");
    expect(approvalFor({ type: "click" }, { tag: "input", type: "submit", value: "Go", inForm: true }, skill).approval).toBe("human");
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
  it("a search submit (Enter in a search box) is not a risky submit; real form submits stay gated (same as @agentboard/core)", () => {
    const st = (intent: string, target: string, action = "keypress") => ({ intent, target, action, value: "" });
    const rubygems = { risk_flags: ["none"], steps: [st("Click the search input to focus it", "search input", "click"), st("Type the gem name", "search input", "type"), st("Submit the search by pressing Enter", "\"Search Gems…\" search input"), st("Open the matching gem from results", "search result link", "click")] };
    const crates = { risk_flags: ["none"], steps: [st("Type the crate name into the search bar", "search input", "type"), st("Submit the search", "Large white search input")] };
    const hn = { risk_flags: ["none"], steps: [st("Enter search query on Hacker News", "search input", "type"), st("Submit search to view results", "same search input containing {{q}}")] };
    const declared = { risk_flags: ["submits_form"], steps: rubygems.steps }; // the recorder flagged the search itself
    const ticket = { risk_flags: [], steps: [st("Type the subject", "subject field", "type"), st("Submit the support ticket", "Submit button", "click")] };
    const searchThenBuy = { risk_flags: [], steps: [st("Submit the search", "search box"), st("Place the order", "Buy now button", "click")] };
    const orderSearch = { risk_flags: [], steps: [st("Submit the search for the order", "search box")] }; // 'order' reads as a purchase: stays gated
    for (const c of [rubygems, crates, hn, declared, ticket, searchThenBuy, orderSearch]) { expect(gatedSteps(c)).toEqual(core.gatedSteps(c)); expect(effectiveRiskFlags(c)).toEqual(core.effectiveRiskFlags(c)); }
    for (const c of [rubygems, crates, hn, declared]) { expect(gatedSteps(c)).toEqual([]); expect(effectiveRiskFlags(c)).toEqual(["none"]); expect(core.publicReplaySafety(c).ok).toBe(true); }
    expect(gatedSteps(ticket)).toEqual([{ index: 1, flags: ["submits_form"] }]);
    expect(gatedSteps(searchThenBuy)).toEqual([{ index: 1, flags: ["purchase"] }]);
    expect(gatedSteps(orderSearch).length).toBe(1);
    // at run time: Enter in a method-less form whose field says search is a lookup; a POST form never is
    const enter = { type: "keypress", keys: ["ENTER"] };
    expect(approvalFor(enter, { tag: "input", type: "text", value: "rails", inForm: true, lookupForm: true }, rubygems).approval).toBe("auto");
    expect(approvalFor(enter, { tag: "input", type: "text", value: "rails", inForm: false, lookupForm: false }, rubygems).approval).toBe("auto");
    expect(approvalFor(enter, { tag: "input", type: "text", value: "x", inForm: true, lookupForm: false }, ticket).approval).toBe("human");
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

describe("search buttons on a posting form", () => {
  it("auto-approves a click on a button labeled exactly Search, still gates Submit or Search and pay", () => {
    const btn = (value: string) => ({ tag: "input", type: "submit", role: "", text: "", value, label: "", aria: "", placeholder: "", inForm: true, lookupForm: false });
    expect(approvalFor({ type: "click", x: 1, y: 1 }, btn("Search")).approval).toBe("auto");
    expect(approvalFor({ type: "click", x: 1, y: 1 }, btn("Look up")).approval).toBe("auto");
    expect(approvalFor({ type: "click", x: 1, y: 1 }, btn("Submit")).approval).toBe("human");
    expect(approvalFor({ type: "click", x: 1, y: 1 }, btn("Search and pay")).approval).toBe("human");
    expect(approvalFor({ type: "keypress", keys: ["Enter"] }, { ...btn("Search"), tag: "input", type: "text", value: "x" }).approval).toBe("human");
  });
});
