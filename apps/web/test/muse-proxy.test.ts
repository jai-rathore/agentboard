import { describe, it, expect } from "vitest";
// @ts-expect-error plain .mjs Vercel function module
import { sanitizeResponsesBody, RESPONSES_OUTPUT_CAPS } from "../api/_muse.mjs";
import { sanitize as apiSanitize } from "../../../packages/api/src/services/muse";

describe("Muse proxy: Responses API guard", () => {
  const base = { model: "muse-spark-1.3", input: "hi" };
  it("allows only muse-spark-1.3, never -contributor or Wonder", () => {
    expect(sanitizeResponsesBody(base, "loop").body.model).toBe("muse-spark-1.3");
    for (const m of ["muse-spark-1.3-contributor", "muse-wonder-1.0", "muse-spark-1.2"]) expect(sanitizeResponsesBody({ ...base, model: m }, "loop").error).toBe("model_not_allowed");
  });
  it("clamps output tokens by call kind and forces store/stream off", () => {
    expect(sanitizeResponsesBody({ ...base, max_output_tokens: 99999 }, "record").body.max_output_tokens).toBe(RESPONSES_OUTPUT_CAPS.record);
    expect(sanitizeResponsesBody({ ...base, max_output_tokens: 99999 }, "loop").body.max_output_tokens).toBe(800);
    expect(sanitizeResponsesBody({ ...base, max_output_tokens: 99999 }, "anything").body.max_output_tokens).toBe(800);
    expect(sanitizeResponsesBody({ ...base, max_output_tokens: 300 }, "verify").body.max_output_tokens).toBe(300);
    const b = sanitizeResponsesBody(base, "verify").body;
    expect([b.store, b.stream, b.max_output_tokens]).toEqual([false, false, 600]);
  });
  it("rejects billed built-in tools and unknown fields", () => {
    expect(sanitizeResponsesBody({ ...base, tools: [{ type: "web_search" }] }, "loop").error).toBe("tool_not_allowed");
    expect(sanitizeResponsesBody({ ...base, tools: [{ type: "computer" }, { type: "function", name: "x" }] }, "loop").body).toBeTruthy();
    expect(sanitizeResponsesBody({ ...base, background: true }, "loop").error).toMatch(/field_not_allowed/);
    expect(sanitizeResponsesBody({ ...base, previous_response_id: "r" }, "loop").error).toMatch(/field_not_allowed/);
  });

  it("accepts exactly what the Agentboard API sends (store: false), but not store: true", () => {
    for (const kind of ["record", "loop", "verify", "heal"] as const) {
      const sent = apiSanitize({ input: [{ role: "user", content: [{ type: "input_text", text: "x" }] }], tools: [{ type: "computer" }], text: { format: { type: "json_schema", name: "s", schema: {}, strict: true } }, reasoning: { effort: "low", summary: "auto" } }, kind, "muse-spark-1.3");
      const r = sanitizeResponsesBody(sent, kind);
      expect(r.error).toBeUndefined();
      expect(r.body.store).toBe(false);
    }
    expect(sanitizeResponsesBody({ model: "muse-spark-1.3", input: "x", store: true }, "loop").error).toBe("field_not_allowed:store");
  });
});
