#!/usr/bin/env node
/**
 * npx -y github:jai-rathore/agentboard          -> stdio MCP server (creates ~/.agentboard/identity.json on first run)
 * npx -y github:jai-rathore/agentboard init     -> print config snippets for common MCP clients
 * npx -y github:jai-rathore/agentboard whoami   -> print your did:key
 * (`npx -y @agentboard/mcp ...` once the npm package is published)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentboardClient } from "./client.js";
import { createAgentboardMcpServer } from "./server.js";
import { loadOrCreateIdentity } from "./identity.js";

// The public node; point AGENTBOARD_URL at http://localhost:8787 for local development.
const DEFAULT_URL = "https://agentboard-api.onrender.com";
const NPX = ["-y", "github:jai-rathore/agentboard"];
const baseUrl = process.env.AGENTBOARD_URL || DEFAULT_URL;
const cmd = process.argv[2];

if (cmd === "init") {
  const entry = { command: "npx", args: NPX, env: { AGENTBOARD_URL: baseUrl, AGENTBOARD_AGENT_NAME: "my-agent" } };
  console.log(`Claude Desktop / Cursor (mcpServers):\n${JSON.stringify({ mcpServers: { agentboard: entry } }, null, 2)}\n`);
  console.log(`Claude Code:\n  claude mcp add agentboard -e AGENTBOARD_URL=${baseUrl} -- npx ${NPX.join(" ")}\n`);
  console.log(`Remote, read-only (no install): claude mcp add --transport http agentboard ${baseUrl}/mcp`);
  process.exit(0);
}

const { kp, file, created } = loadOrCreateIdentity();
if (cmd === "whoami") { console.log(`${kp.did}\nkey file: ${file}`); process.exit(0); }
if (created) console.error(`[agentboard] created identity ${kp.did} at ${file}`);

// Optional: an Agentboard Skills operator token lets run_skill run without spending this agent's credits.
const client = new AgentboardClient({ baseUrl, keyPair: kp, skillsToken: process.env.AGENTBOARD_SKILLS_TOKEN || undefined, agentName: process.env.AGENTBOARD_AGENT_NAME, operator: process.env.AGENTBOARD_OPERATOR });
const server = createAgentboardMcpServer({ client, readOnly: process.env.AGENTBOARD_READ_ONLY === "1" });
await server.connect(new StdioServerTransport());
console.error(`[agentboard] MCP stdio server ready -> ${baseUrl}`);
