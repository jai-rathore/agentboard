// pnpm grant-credits against an in-process node (PGlite, no network, no model calls).
import { describe, it, expect, afterEach } from "vitest";
import { parseGrantArgs, readToken, grant } from "./grant-credits.js";
import { makeNode, TestAgent, credits, type TestNode } from "../packages/api/test/helpers.js";

const TOKEN = "test-operator-token-0123456789abcdef";
let node: TestNode | undefined;
afterEach(async () => { await node?.ctx.db.close(); node = undefined; });

describe("pnpm grant-credits", () => {
  it("parses and validates arguments", () => {
    const a = parseGrantArgs(["--did", "did:key:z6Mkabc", "--amount", "60", "--reason", "budget"], {});
    expect(a).toMatchObject({ did: "did:key:z6Mkabc", amount: 60, reason: "budget", api: "https://agentboard-api.onrender.com", repeat: false, dryRun: false });
    expect(parseGrantArgs(["--did", "did:key:z", "--amount", "1", "--reason", "r", "--api", "http://x/"], {}).api).toBe("http://x");
    expect(() => parseGrantArgs(["--did", "did:key:z", "--amount", "201", "--reason", "r"], {})).toThrow(/1 to 200/);
    expect(() => parseGrantArgs(["--did", "did:key:z", "--amount", "1.5", "--reason", "r"], {})).toThrow(/whole number/);
    expect(() => parseGrantArgs(["--did", "nope", "--amount", "5", "--reason", "r"], {})).toThrow(/did:key/);
    expect(() => parseGrantArgs(["--did", "did:key:z", "--amount", "5"], {})).toThrow(/reason/);
    expect(readToken(undefined, { SKILLS_OPERATOR_TOKEN: " t " })).toBe("t");
  });

  it("grants through the operator route, refuses a duplicate, and never prints the token", async () => {
    node = await makeNode({ skillsOperatorToken: TOKEN });
    const a = new TestAgent(node); await a.register("tooling-notes");
    const fetchImpl = (async (url: string, init?: RequestInit) => node!.app.request(String(url).replace("http://node.test", ""), init)) as typeof fetch;
    const lines: string[] = [];
    const args = parseGrantArgs(["--did", a.did, "--amount", "60", "--reason", "House pipeline posting budget", "--api", "http://node.test"], {});
    expect(await grant({ ...args, dryRun: true }, "", fetchImpl, (s) => lines.push(s))).toBeNull();
    expect(await credits(node, a.did)).toBe(20);
    const out = await grant(args, TOKEN, fetchImpl, (s) => lines.push(s));
    expect(out).toMatchObject({ credits: 60, balance: 80 });
    await expect(grant(args, TOKEN, fetchImpl, (s) => lines.push(s))).rejects.toThrow(/409 duplicate_grant/);
    await expect(grant(args, "wrong-token-0123456789abcdef", fetchImpl, () => {})).rejects.toThrow(/401/);
    expect(await credits(node, a.did)).toBe(80);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});
