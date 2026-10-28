import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OpenAICompatProvider, dailyBudget, usageRecorder, type JsonSchema } from "../src/services/llm.js";
import { loadConfig } from "../src/config.js";
import { makeNode, type TestNode } from "./helpers.js";

const schema: JsonSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

function fakeFetch(reply: { content: string | null; finish: string }, seen: any[]) {
  return (async (_u: any, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply.content }, finish_reason: reply.finish }], usage: { prompt_tokens: 100, completion_tokens: 40 } }), { status: 200 });
  }) as typeof fetch;
}

describe("LLM guard rails (no network)", () => {
  let node: TestNode;
  beforeAll(async () => { node = await makeNode(); });
  afterAll(async () => { await node.ctx.db.close(); });

  it("clamps max_tokens to the per-call ceiling and records token usage", async () => {
    const seen: any[] = [];
    const p = new OpenAICompatProvider("t", "http://x", "k", "muse-spark-1.3", dailyBudget(node.ctx.db, 5), fakeFetch({ content: '{"ok":true}', finish: "stop" }, seen), { reasoning_effort: "minimal" }, 300, usageRecorder(node.ctx.db));
    expect(await p.json({ system: "s", user: "u", schemaName: "x", schema, maxTokens: 5000 })).toEqual({ ok: true });
    expect(seen[0].max_tokens).toBe(300);
    expect(seen[0].reasoning_effort).toBe("minimal");
    const h = (await node.req("GET", "/healthz")).body.llm_today;
    expect(h).toMatchObject({ calls: 1, input_tokens: 100, output_tokens: 40 });
  });

  it("treats a truncated (finish_reason=length) answer as no answer", async () => {
    const p = new OpenAICompatProvider("t", "http://x", "k", "m", dailyBudget(node.ctx.db, 5), fakeFetch({ content: null, finish: "length" }, []));
    expect(await p.json({ system: "s", user: "u", schemaName: "x", schema })).toBeNull();
  });

  it("enforces the daily call cap before any request is sent", async () => {
    const seen: any[] = [];
    const p = new OpenAICompatProvider("t", "http://x", "k", "m", dailyBudget(node.ctx.db, 3), fakeFetch({ content: '{"ok":true}', finish: "stop" }, seen));
    // 2 calls already reserved today by the tests above; cap 3 leaves exactly one.
    expect(await p.json({ system: "s", user: "u", schemaName: "x", schema })).toEqual({ ok: true });
    expect(await p.json({ system: "s", user: "u", schemaName: "x", schema })).toBeNull();
    expect(seen).toHaveLength(1);
    const cap0 = new OpenAICompatProvider("t", "http://x", "k", "m", dailyBudget(node.ctx.db, 0), fakeFetch({ content: "{}", finish: "stop" }, seen));
    expect(await cap0.json({ system: "s", user: "u", schemaName: "x", schema })).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("refuses -contributor model variants", () => {
    expect(() => loadConfig({ META_MODEL: "muse-spark-1.3-contributor" })).toThrow(/contributor/);
    expect(loadConfig({}).metaModel).toBe("muse-spark-1.3");
  });
});
