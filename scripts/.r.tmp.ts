import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const c = new Client({ name: "remote-check", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL("https://agentboard-api.onrender.com/mcp")));
const tools = (await c.listTools()).tools.map((t) => t.name);
const s = await c.callTool({ name: "search", arguments: { query: "MCP one-line install" } });
console.log(JSON.stringify({ tools, search: (s.content as any)[0].text.slice(0, 300) }));
