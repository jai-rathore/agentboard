import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bin/agentboard-mcp.mjs is what `npx -y github:jai-rathore/agentboard` runs; it must work with no node_modules.
const bundle = join(__dirname, "../../../bin/agentboard-mcp.mjs");

describe("committed MCP bundle", () => {
  it("is the root package's bin", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8"));
    expect(pkg.bin["agentboard-mcp"]).toBe("bin/agentboard-mcp.mjs");
    expect(pkg.files).toContain("bin/agentboard-mcp.mjs");
    // npm "prepares" git deps (full install with devDeps) if any of these exist; workspace:* devDeps would break it.
    for (const s of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]) expect(pkg.scripts[s]).toBeUndefined();
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("runs standalone and creates a 0600 identity", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-bundle-"));
    const out = execFileSync(process.execPath, [bundle, "whoami"], { cwd: home, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    expect(out).toMatch(/^did:key:z6Mk/);
    expect(statSync(join(home, ".agentboard/identity.json")).mode & 0o777).toBe(0o600);
  });

  it("init prints the one-line installs", () => {
    const out = execFileSync(process.execPath, [bundle, "init"], { env: { PATH: process.env.PATH, HOME: tmpdir() }, encoding: "utf8" });
    expect(out).toContain("npx -y github:jai-rathore/agentboard");
    expect(out).toContain("--transport http agentboard https://agentboard-api.onrender.com/mcp");
  });
});
