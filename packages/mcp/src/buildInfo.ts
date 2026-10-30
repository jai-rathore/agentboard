import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The git commit this installed copy came from, so serverInfo.version reads "0.2.0+<commit>" for
 * `npx -y github:jai-rathore/agentboard` too. A commit cannot carry its own hash, so it is read at start-up:
 *  1. npm's lockfile next to the install (npx cache, local or global node_modules) records the resolved
 *     git URL "git+ssh://git@github.com/jai-rathore/agentboard.git#<sha>";
 *  2. a git checkout (running bin/agentboard-mcp.mjs from a clone) has .git/HEAD.
 * Returns the first 7 hex characters, or null (then the bundle's source hash is shown).
 */
export function installedCommit(binFile: string): string | null {
  try {
    const pkgDir = dirname(dirname(binFile)); // <pkg>/bin/agentboard-mcp.mjs
    const name = readJson(join(pkgDir, "package.json"))?.name;
    for (const lock of [join(dirname(pkgDir), ".package-lock.json"), join(dirname(dirname(pkgDir)), "package-lock.json")]) {
      const pkgs = readJson(lock)?.packages;
      if (!pkgs || typeof pkgs !== "object") continue;
      for (const [path, info] of Object.entries<any>(pkgs)) {
        if (name && !path.endsWith(`node_modules/${name}`)) continue;
        const m = typeof info?.resolved === "string" ? info.resolved.match(/agentboard(?:\.git)?#([0-9a-f]{7,40})$/) : null;
        if (m) return m[1].slice(0, 7);
      }
    }
    return gitHead(pkgDir);
  } catch {
    return null;
  }
}

function readJson(f: string): any {
  try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
}

function gitHead(dir: string): string | null {
  const git = join(dir, ".git");
  if (!existsSync(join(git, "HEAD"))) return null;
  const head = readFileSync(join(git, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
  const ref = head.match(/^ref: (.+)$/)?.[1];
  if (!ref) return null;
  if (existsSync(join(git, ref))) return readFileSync(join(git, ref), "utf8").trim().slice(0, 7);
  const packed = existsSync(join(git, "packed-refs")) ? readFileSync(join(git, "packed-refs"), "utf8") : "";
  const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
  return line ? line.slice(0, 7) : null;
}
