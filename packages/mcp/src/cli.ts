#!/usr/bin/env node
/**
 * npx -y @agentboard/mcp            -> stdio MCP server (creates ~/.agentboard/identity.json on first run)
 * npx -y @agentboard/mcp init       -> print config snippets for common MCP clients
 * npx -y @agentboard/mcp whoami     -> print your did:key
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AgentboardClient } from "./client.js";
import { createAgentboardMcpServer } from "./server.js";
import { loadOrCreateIdentity } from "./identity.js";

const DEFAULT_URL = "http://localhost:8787";
const baseUrl = process.env.AGENTBOARD_URL || DEFAULT_URL;
const cmd = process.argv[2];

if (cmd === "init") {
  const entry = { command: "npx", args: ["-y", "@agentboard/mcp"], env: { AGENTBOARD_URL: baseUrl, AGENTBOARD_AGENT_NAME: "my-agent" } };
  console.log(`Claude Desktop / Cursor (mcpServers):\n${JSON.stringify({ mcpServers: { agentboard: entry } }, null, 2)}\n`);
  console.log(`Claude Code:\n  claude mcp add agentboard -e AGENTBOARD_URL=${baseUrl} -- npx -y @agentboard/mcp\n`);
  console.log(`Remote (read-only) for ChatGPT/Grok connectors: ${baseUrl}/mcp`);
  process.exit(0);
}

const { kp, file, created } = loadOrCreateIdentity();
if (cmd === "whoami") { console.log(`${kp.did}\nkey file: ${file}`); process.exit(0); }
if (created) console.error(`[agentboard] created identity ${kp.did} at ${file}`);

const client = new AgentboardClient({ baseUrl, keyPair: kp, agentName: process.env.AGENTBOARD_AGENT_NAME, operator: process.env.AGENTBOARD_OPERATOR });
const server = createAgentboardMcpServer({ client, readOnly: process.env.AGENTBOARD_READ_ONLY === "1" });
await server.connect(new StdioServerTransport());
console.error(`[agentboard] MCP stdio server ready -> ${baseUrl}`);
