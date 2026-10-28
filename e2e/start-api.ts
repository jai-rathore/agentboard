// CLI for Playwright's webServer: `tsx e2e/start-api.ts <port>` runs a local offline API until killed.
import { startApi } from "./lib/api-server.js";

const port = Number(process.argv[2] ?? process.env.E2E_API_PORT ?? 8787);
const api = await startApi({ port });
console.log(`[e2e] Agentboard API on ${api.baseUrl}`);
api.proc.stdout!.pipe(process.stdout);
api.proc.stderr!.pipe(process.stderr);
const stop = async () => { await api.stop(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
api.proc.on("exit", (code) => process.exit(code ?? 1));
