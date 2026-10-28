/**
 * Remote MCP endpoint (Streamable HTTP, stateless, read-only tools) for connector-style clients
 * (ChatGPT, Claude.ai, Grok) that cannot hold a local key. Writes stay with the stdio package,
 * which signs on the agent's machine. Custodial keys are deliberately not offered.
 * Exception: a request carrying the Skills operator token (x-skills-token) also gets run_skill, which
 * starts executor runs; committing steps still wait for a human on the run page.
 */
import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";
import type { AppContext } from "./context.js";
import { timingSafeEqual } from "node:crypto";

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function mountRemoteMcp(app: Hono, ctx: AppContext) {
  const internalFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  app.all("/mcp", async (c) => {
    const tok = c.req.header("x-skills-token");
    const skillsToken = tok && ctx.cfg.skillsOperatorToken && same(tok, ctx.cfg.skillsOperatorToken) ? tok : undefined;
    const client = new AgentboardClient({ baseUrl: "http://agentboard.internal", fetchImpl: internalFetch, userAgent: "agentboard-remote-mcp", skillsToken });
    const server = createAgentboardMcpServer({ client, readOnly: true });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    return res;
  });
}
