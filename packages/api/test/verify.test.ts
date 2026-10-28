import { describe, it, expect, afterAll } from "vitest";
import { generateKeyPair, signWebBotAuth, jwkFromPublicKey, createRecord } from "@agentboard/core";
import { makeNode, TestAgent, credits, type TestNode } from "./helpers.js";

describe("verified identity badge via Web Bot Auth", () => {
  let node: TestNode;
  afterAll(async () => { await node?.ctx.db.close(); });
  const operatorKey = generateKeyPair();
  const fetched: string[] = [];
  const fakeFetch = (async (url: string) => {
    fetched.push(String(url));
    if (String(url) === "https://operator.example/.well-known/http-message-signatures-directory") return new Response(JSON.stringify({ keys: [jwkFromPublicKey(operatorKey.publicKey)] }));
    return new Response("nope", { status: 404 });
  }) as typeof fetch;

  it("verifies RFC 9421 headers, binds the domain to the DID, and grants the badge", async () => {
    node = await makeNode({}, { fetchImpl: fakeFetch });
    const agent = new TestAgent(node);
    await agent.register("verified-bot");
    const nodeDid = (await node.req("GET", "/v1/node")).body.node_did;
    const headers = signWebBotAuth({ secretKey: operatorKey.secretKey, publicKey: operatorKey.publicKey, authority: "localhost", signatureAgent: "https://operator.example", nonce: "abc" });
    const before = await credits(node, agent.did);
    const r = await agent.submit("verify", { signature_agent: "https://operator.example", node: nodeDid }, { headers });
    expect(r.status).toBe(201);
    expect(r.body.verified_domain).toBe("operator.example");
    expect(fetched).toContain("https://operator.example/.well-known/http-message-signatures-directory");
    const prof = (await node.req("GET", `/v1/agents/${agent.did}`)).body.agent;
    expect(prof.verified).toBe(true);
    expect(prof.operator).toBe("web:operator.example");
    expect(await credits(node, agent.did)).toBe(before + 10);
  });

  it("rejects a signature from a key the directory does not publish", async () => {
    const agent = new TestAgent(node); await agent.register("imposter");
    const nodeDid = (await node.req("GET", "/v1/node")).body.node_did;
    const wrong = generateKeyPair();
    const headers = signWebBotAuth({ secretKey: wrong.secretKey, publicKey: wrong.publicKey, authority: "localhost", signatureAgent: "https://operator.example" });
    const r = await agent.submit("verify", { signature_agent: "https://operator.example", node: nodeDid }, { headers });
    expect(r.status).toBe(403);
  });

  it("rejects a mismatch between the signed record and the Signature-Agent header", async () => {
    const agent = new TestAgent(node); await agent.register("mismatch");
    const nodeDid = (await node.req("GET", "/v1/node")).body.node_did;
    const headers = signWebBotAuth({ secretKey: operatorKey.secretKey, publicKey: operatorKey.publicKey, authority: "localhost", signatureAgent: "https://operator.example" });
    const r = await agent.submit("verify", { signature_agent: "https://other.example", node: nodeDid }, { headers });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("agent_mismatch");
  });

  it("rejects verify records meant for another node and requests without headers", async () => {
    const agent = new TestAgent(node); await agent.register("replayer");
    expect((await agent.submit("verify", { signature_agent: "https://operator.example", node: generateKeyPair().did })).body.error).toBe("wrong_node");
    const nodeDid = (await node.req("GET", "/v1/node")).body.node_did;
    expect((await agent.submit("verify", { signature_agent: "https://operator.example", node: nodeDid })).body.error).toBe("web_bot_auth_required");
    void createRecord;
  });
});
