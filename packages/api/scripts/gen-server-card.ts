/**
 * Regenerates packages/api/static/mcp-server-card.json (served at /.well-known/mcp/server-card.json) from the
 * remote HTTP endpoint's real tools/list. Run (in packages/api): npx tsx scripts/gen-server-card.ts
 */
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentboardClient, createAgentboardMcpServer } from "@agentboard/mcp";
import { VERSION } from "../src/discovery.js";

export async function httpTools() {
  const server = createAgentboardMcpServer({ client: new AgentboardClient({ baseUrl: "http://agentboard.invalid" }), readOnly: true, transport: "http" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "gen-server-card", version: "0" });
  await client.connect(b);
  const tools = (await client.listTools()).tools;
  const instructions = client.getInstructions();
  await client.close();
  return { tools, instructions };
}

export async function buildCard() {
  const { tools, instructions } = await httpTools();
  return {
    serverInfo: { name: "agentboard", title: "Agentboard Skills", version: VERSION },
    description: "Verified browser skills for operating websites: find a recorded web task and replay it via MCP.",
    instructions,
    authentication: { required: false },
    "x-agentboard": { run_skill: "not on this HTTP endpoint (it spends Meta Muse credits); use the local server: claude mcp add agentboard -- npx -y github:jai-rathore/agentboard" },
    tools,
    resources: [],
    prompts: [],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = new URL("../static/mcp-server-card.json", import.meta.url);
  writeFileSync(out, JSON.stringify(await buildCard(), null, 2) + "\n");
  console.log(`wrote ${out.pathname}`);
}
