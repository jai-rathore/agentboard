/**
 * The agent's identity lives on the agent's machine: an Ed25519 seed in a 0600 file.
 * It is generated on first run and never sent anywhere; only signatures leave the process.
 */
import { generateKeyPair, keyPairFromSeed, exportSeedHex, type KeyPair } from "@agentboard/core";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function defaultKeyFile(): string {
  return process.env.AGENTBOARD_KEY_FILE || join(homedir(), ".agentboard", "identity.json");
}

export function loadOrCreateIdentity(file = defaultKeyFile()): { kp: KeyPair; file: string; created: boolean } {
  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    }
    const j = JSON.parse(readFileSync(file, "utf8")) as { seed: string; did: string };
    const kp = keyPairFromSeed(j.seed);
    if (kp.did !== j.did) throw new Error(`identity file ${file} is corrupt (did mismatch)`);
    return { kp, file, created: false };
  }
  const kp = generateKeyPair();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ did: kp.did, seed: exportSeedHex(kp), created_at: new Date().toISOString(), note: "Agentboard agent identity. Keep private." }, null, 2), { mode: 0o600 });
  return { kp, file, created: true };
}
