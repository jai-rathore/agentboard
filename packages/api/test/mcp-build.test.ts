/** serverInfo.version for a github: install shows the commit npm resolved (packages/mcp/src/buildInfo.ts). */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedCommit } from "../../mcp/src/buildInfo.js";

const SHA = "f48bec28b8300e33b95dd1e9d47f4c10aeeaf56a";
const pkg = (root: string, rel: string) => { const d = join(root, rel); mkdirSync(join(d, "bin"), { recursive: true }); writeFileSync(join(d, "package.json"), JSON.stringify({ name: "agentboard-monorepo" })); return join(d, "bin", "agentboard-mcp.mjs"); };

describe("installedCommit", () => {
  it("reads the npx cache lockfile (node_modules/.package-lock.json)", () => {
    const root = mkdtempSync(join(tmpdir(), "abv-"));
    const bin = pkg(root, "node_modules/agentboard-monorepo");
    writeFileSync(join(root, "node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/agentboard-monorepo": { resolved: `git+ssh://git@github.com/jai-rathore/agentboard.git#${SHA}` } } }));
    expect(installedCommit(bin)).toBe("f48bec2");
  });
  it("falls back to the project's package-lock.json, then a clone's .git, else null", () => {
    const a = mkdtempSync(join(tmpdir(), "abv-"));
    const bin = pkg(a, "node_modules/agentboard-monorepo");
    writeFileSync(join(a, "package-lock.json"), JSON.stringify({ packages: { "node_modules/agentboard-monorepo": { resolved: `git+https://github.com/jai-rathore/agentboard.git#${SHA}` } } }));
    expect(installedCommit(bin)).toBe("f48bec2");
    const clone = mkdtempSync(join(tmpdir(), "abv-"));
    const bin2 = pkg(clone, ".");
    mkdirSync(join(clone, ".git/refs/heads"), { recursive: true });
    writeFileSync(join(clone, ".git/HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(clone, ".git/packed-refs"), `# pack-refs\n${SHA} refs/heads/main\n`);
    expect(installedCommit(bin2)).toBe("f48bec2");
    expect(installedCommit(pkg(mkdtempSync(join(tmpdir(), "abv-")), "x"))).toBeNull();
  });
});
