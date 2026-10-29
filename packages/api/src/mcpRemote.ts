/**
 * Remote MCP endpoint (Streamable HTTP, stateless; read-only tools plus try_skill, the capped public replay) for connector-style clients
 * (ChatGPT, Claude.ai, Grok) that cannot hold a local key. Writes stay with the stdio package,
 * which signs on the agent's machine. Custodial keys are deliberately not offered.
 * run_skill is never offered here (credited runs need an agent identity, and anyone can reach this endpoint); try_skill only
 * starts the public replay of allowlisted non-destructive skills, under per-IP and daily caps (services/publicReplay.ts);
 * agents run skills through the local stdio server: npx -y github:jai-rathore/agentboard.
 */
import type { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";
import type { AppContext } from "./context.js";
import { clientIp } from "./services/ipLimits.js";
import { MCP_INTERNAL_HEADER, MCP_INTERNAL_TOKEN, MCP_CLIENT_IP_HEADER } from "./services/publicReplay.js";

export function mountRemoteMcp(app: Hono, ctx: AppContext) {
  app.all("/mcp", async (c) => {
    // In-process calls carry a per-process secret and the caller's real IP (CF-Connecting-IP / True-Client-IP),
    // so try_skill's public replay counts against the caller's network, not the node's.
    const ip = clientIp((n) => c.req.header(n));
    const internalFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      h.set(MCP_INTERNAL_HEADER, MCP_INTERNAL_TOKEN);
      if (ip) h.set(MCP_CLIENT_IP_HEADER, ip); else h.delete(MCP_CLIENT_IP_HEADER);
      return app.fetch(new Request(input, { ...init, headers: h }));
    }) as typeof fetch;
    const client = new AgentboardClient({ baseUrl: "http://agentboard.internal", fetchImpl: internalFetch, userAgent: "agentboard-remote-mcp" });
    const server = createAgentboardMcpServer({ client, readOnly: true, transport: "http", build: (process.env.RENDER_GIT_COMMIT || process.env.AGENTBOARD_COMMIT || "").trim().slice(0, 7) || null });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    return res;
  });
}
