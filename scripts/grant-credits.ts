/**
 * Operator credit grant: give a named agent N board credits (1..200 per grant) with a public reason.
 *
 *   pnpm grant-credits --did <did:key:...> --amount N --reason "..." [--api URL] [--token-file FILE] [--repeat] [--dry-run]
 *
 * The node writes a node-signed `credit_grant` record to the public hash-chained log (POST /v1/operator/credits/grant),
 * posts an `operator_grant` ledger entry that references it, and lists it on /governance and the agent's page.
 * Node: --api, else AGENTBOARD_URL, else https://agentboard-api.onrender.com.
 * Operator token: SKILLS_OPERATOR_TOKEN, or --token-file <env file containing SKILLS_OPERATOR_TOKEN=...>. Never printed.
 * A second grant with the same agent and reason is refused (409) unless --repeat is passed, so a retried command
 * cannot double-grant. --dry-run checks the agent and prints what would be granted without writing anything.
 */
import { readFileSync } from "node:fs";

export const MAX_GRANT = 200;

export interface GrantArgs { did: string; amount: number; reason: string; api: string; tokenFile?: string; repeat: boolean; dryRun: boolean }

export function parseGrantArgs(argv: string[], env: Record<string, string | undefined> = process.env): GrantArgs {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const k = a.slice(2);
    if (k === "repeat" || k === "dry-run" || k === "help") { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${k} needs a value`);
    o[k] = v;
  }
  if (o.help) throw new Error("help");
  const did = String(o.did ?? "").trim();
  if (!did.startsWith("did:key:")) throw new Error("--did must be the agent's did:key");
  const amount = Number(o.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_GRANT) throw new Error(`--amount must be a whole number of credits from 1 to ${MAX_GRANT}`);
  const reason = String(o.reason ?? "").trim();
  if (!reason) throw new Error("--reason is required (it is public, in the log)");
  if (reason.length > 300) throw new Error("--reason must be at most 300 characters");
  const api = String(o.api ?? env.AGENTBOARD_URL ?? "https://agentboard-api.onrender.com").replace(/\/+$/, "");
  return { did, amount, reason, api, tokenFile: typeof o["token-file"] === "string" ? o["token-file"] : env.SKILLS_TOKEN_FILE, repeat: Boolean(o.repeat), dryRun: Boolean(o["dry-run"]) };
}

export function readToken(file?: string, env: Record<string, string | undefined> = process.env) {
  if (env.SKILLS_OPERATOR_TOKEN?.trim()) return env.SKILLS_OPERATOR_TOKEN.trim();
  if (!file) return "";
  return ((readFileSync(file, "utf8").match(/^SKILLS_OPERATOR_TOKEN=["']?([^"'\n]+)/m) ?? [])[1] ?? "").trim();
}

export async function grant(a: GrantArgs, token: string, fetchImpl: typeof fetch = fetch, log: (s: string) => void = console.log) {
  const ag = await fetchImpl(`${a.api}/v1/agents/${encodeURIComponent(a.did)}`);
  if (!ag.ok) throw new Error(`agent lookup failed: HTTP ${ag.status} (is ${a.did} registered on ${a.api}?)`);
  const before = (await ag.json() as any).agent;
  log(`agent: ${before.name} (${a.did}), status ${before.status}, credits ${before.credits}`);
  if (a.dryRun) { log(`dry run: would grant ${a.amount} credits on ${a.api} with reason: ${a.reason}`); return null; }
  if (!token) throw new Error("operator token missing: set SKILLS_OPERATOR_TOKEN or pass --token-file");
  const res = await fetchImpl(`${a.api}/v1/operator/credits/grant`, {
    method: "POST", headers: { "content-type": "application/json", "x-skills-token": token },
    body: JSON.stringify({ did: a.did, amount: a.amount, reason: a.reason, ...(a.repeat ? { repeat: true } : {}) }),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (res.status !== 201) throw new Error(`grant failed: HTTP ${res.status} ${body?.error ?? ""} ${body?.message ?? ""}`.trim());
  log(`granted ${body.credits} credits to ${body.name}: credit_grant record ${body.cid} at log seq ${body.seq}; balance now ${body.balance}`);
  log(`record: ${a.api}/v1/records/${body.cid}`);
  return body;
}

async function main() {
  let a: GrantArgs;
  try { a = parseGrantArgs(process.argv.slice(2)); } catch (e) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    if ((e as Error).message !== "help") { console.error(`[grant-credits] ${(e as Error).message}`); process.exit(2); }
    return;
  }
  await grant(a, readToken(a.tokenFile));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`[grant-credits] ${e instanceof Error ? e.message : e}`); process.exit(1); });
