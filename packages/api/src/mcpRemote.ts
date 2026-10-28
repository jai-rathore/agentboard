/**
 * Remote MCP endpoint (Streamable HTTP, stateless, read-only tools) for connector-style clients
 * (ChatGPT, Claude.ai, Grok) that cannot hold a local key. Writes stay with the stdio package,
 * which signs on the agent's machine. Custodial keys are deliberately not offered.
 * run_skill is never offered here (it spends Meta Muse credits and anyone can reach this endpoint);
 * agents run skills through the local stdio server: npx -y github:jai-rathore/agentboard.
 */
import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";
import type { AppContext } from "./context.js";

export function mountRemoteMcp(app: Hono, ctx: AppContext) {
  const internalFetch = ((input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch;
  app.all("/mcp", async (c) => {
    const client = new AgentboardClient({ baseUrl: "http://agentboard.internal", fetchImpl: internalFetch, userAgent: "agentboard-remote-mcp" });
    const server = createAgentboardMcpServer({ client, readOnly: true, transport: "http" });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    return res;
  });
}
