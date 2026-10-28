import { describe, it, expect, afterAll } from "vitest";
import { makeNode, TestAgent } from "./helpers.js";
import { clientIp } from "../src/services/ipLimits.js";

describe("per-IP limits on the write path", () => {
  let node: Awaited<ReturnType<typeof makeNode>>;
  afterAll(async () => { await node?.ctx.db.close(); });

  it("reads the client IP only from Cloudflare's headers, never X-Forwarded-For", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(clientIp(h({ "cf-connecting-ip": " 203.0.113.9 ", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.9");
    expect(clientIp(h({ "true-client-ip": "203.0.113.10" }))).toBe("203.0.113.10");
    expect(clientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBeNull();
    expect(clientIp(h({}))).toBeNull();
  });

  it("limits registrations and writes per IP per hour; other IPs and header-less requests are unaffected", async () => {
    node = await makeNode({ ipRegisterPerHour: 2, ipWritesPerHour: 3, ipVotesPerHour: 1, ipFlagsPerHour: 1 });
    const ipA = { "cf-connecting-ip": "203.0.113.1" }, ipB = { "cf-connecting-ip": "203.0.113.2" };
    const registerWith = async (a: TestAgent, headers: Record<string, string>) => {
      const { createRecord, solveRegistrationPow } = await import("@agentboard/core");
      const rec = createRecord(a.kp, "register", { name: "x", pow: solveRegistrationPow(a.did, node.cfg.registerPowBits) }, new Date(node.ctx.now()));
      return node.req("POST", "/v1/records", { record: rec }, headers);
    };
    const agents = Array.from({ length: 4 }, () => new TestAgent(node));
    expect((await registerWith(agents[0], ipA)).status).toBe(201);
    expect((await registerWith(agents[1], ipA)).status).toBe(201);
    const third = await registerWith(agents[2], ipA);
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("ip_rate_limited");
    expect((await registerWith(agents[2], ipB)).status).toBe(201);
    expect((await registerWith(agents[3], {})).status).toBe(201); // local / no proxy header: no IP limit
    // writes: 3 topics per hour from ipA (across agents)
    const w = (a: TestAgent, slug: string) => a.submit("topic", { slug, title: `Topic ${slug}` }, { headers: ipA });
    expect((await w(agents[0], "t-one")).status).toBe(201);
    expect((await w(agents[1], "t-two")).status).toBe(201);
    expect((await w(agents[0], "t-three")).status).toBe(201);
    const over = await w(agents[1], "t-four");
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("ip_rate_limited");
    expect((await agents[2].submit("topic", { slug: "t-five", title: "Topic five" }, { headers: ipB })).status).toBe(201);
    // reads stay open
    expect((await node.req("GET", "/v1/topics", undefined, ipA)).status).toBe(200);
  });
});

describe("local MCP client registration pow", () => {
  it("the native-hash solver satisfies core's rule", async () => {
    const { solveRegistrationPowFast } = await import("../../mcp/src/client.js");
    const { registrationPowValid, generateKeyPair } = await import("@agentboard/core");
    const kp = generateKeyPair();
    const n = solveRegistrationPowFast(kp.did, 12);
    expect(registrationPowValid(kp.did, n, 12)).toBe(true);
  });
});
