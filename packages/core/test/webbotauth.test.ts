import { describe, it, expect } from "vitest";
import { base64 } from "@scure/base";
import { keyPairFromSeed, jwkThumbprintEd25519, b64url, verifyWebBotAuth, signWebBotAuth, keysFromDirectory, generateKeyPair, parseSignatureInput, signatureBase, bytesToHex } from "../src/index.js";

// RFC 9421 Appendix B.1.4 test-key-ed25519 (PKCS#8 PEM body); the seed is the last 32 bytes.
const PEM_B64 = "MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF";
const seed = base64.decode(PEM_B64).slice(-32);
const rfcKey = keyPairFromSeed(bytesToHex(seed));

describe("Web Bot Auth / RFC 9421 (ed25519)", () => {
  it("derives the RFC test key and its JWK thumbprint", () => {
    expect(b64url(rfcKey.publicKey)).toBe("JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs");
    expect(jwkThumbprintEd25519(b64url(rfcKey.publicKey))).toBe("poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U");
  });

  // draft-meunier-web-bot-auth-architecture-05 Appendix A.2.1 (no Signature-Agent) and A.2.3
  // (Signature-Agent as sf-string). Both published Ed25519 vectors verify. The A.2.2 vector
  // (sf-dictionary form) reproduces the documented signature base byte-for-byte but its published
  // signature does not verify against that base, so dictionary form is covered by round-trip tests.
  const v21 = {
    "signature-input": 'sig1=("@authority");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="g0iqFa9e1ffijlyOScDkXpfSmTbYpRNSGPJrQ1It20ahwgzB3jOUcdgLgFxUg7RMtW4V8IILaKKtA+YuSyIgJQ==";tag="web-bot-auth"',
    signature: "sig1=:FFASViSdcgsyaqqYiCnkHreeZzbNKcTzDvZC5uVlP/dn9IbWj8j0o4wKFTH3rBnUiSUBduwm1Gp5VlIPCp01Ag==:",
  };
  const v23 = {
    "signature-agent": '"https://signature-agent.test"',
    "signature-input": 'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
    signature: "sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:",
  };
  const vectorHeaders = {
    "signature-agent": 'agent2="https://signature-agent.test"',
    "signature-input": 'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg==";tag="web-bot-auth"',
  };
  const req = { method: "GET", authority: "example.com", path: "/", headers: v23 };

  it("reproduces the draft's A.2.2 signature base (dictionary Signature-Agent)", () => {
    const [input] = parseSignatureInput(vectorHeaders["signature-input"]);
    expect(signatureBase(input, { ...req, headers: vectorHeaders })).toBe([
      '"@authority": example.com',
      '"signature-agent";key="agent2": "https://signature-agent.test"',
      '"@signature-params": ("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="XeP72svPKNiGEg3aDE7WJuTpN69H08oMFqC8NLFy1MptpENAT3WZTYwK+MYdsFMlaqHCJGo9ZAhqer1NWY9Epg==";tag="web-bot-auth"',
    ].join("\n"));
  });

  it("verifies the draft's published A.2.1 vector", async () => {
    const r = await verifyWebBotAuth({ ...req, headers: v21 }, async () => rfcKey.publicKey, 1735689700);
    expect(r).toMatchObject({ ok: true, keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U" });
  });

  it("verifies the draft's published A.2.3 vector with Signature-Agent", async () => {
    let askedAgent: string | undefined;
    const r = await verifyWebBotAuth(req, async (_kid, agent) => { askedAgent = agent; return rfcKey.publicKey; }, 1735689700);
    expect(r).toMatchObject({ ok: true, keyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U", signatureAgent: "https://signature-agent.test" });
    expect(askedAgent).toBe("https://signature-agent.test");
  });

  it("rejects the vector for a different authority", async () => {
    const r = await verifyWebBotAuth({ ...req, authority: "evil.com" }, async () => rfcKey.publicKey, 1735689700);
    expect(r).toEqual({ ok: false, error: "bad signature" });
  });

  it("rejects a key whose thumbprint is not the keyid", async () => {
    const r = await verifyWebBotAuth(req, async () => generateKeyPair().publicKey, 1735689700);
    expect(r.ok).toBe(false);
  });

  it("signs and verifies its own headers, and enforces expiry", async () => {
    const kp = generateKeyPair();
    const now = 1_800_000_000;
    const headers = signWebBotAuth({ secretKey: kp.secretKey, publicKey: kp.publicKey, authority: "agentboard.test", signatureAgent: "https://operator.example", created: now, expires: now + 60, nonce: "n1" });
    const dir = keysFromDirectory({ keys: [{ kty: "OKP", crv: "Ed25519", x: b64url(kp.publicKey) }] });
    const resolve = async (kid: string) => dir.get(kid) ?? null;
    const ok = await verifyWebBotAuth({ method: "POST", authority: "agentboard.test", path: "/v1/agents/verify", headers }, resolve, now + 10);
    expect(ok).toMatchObject({ ok: true, signatureAgent: "https://operator.example" });
    const late = await verifyWebBotAuth({ method: "POST", authority: "agentboard.test", path: "/", headers }, resolve, now + 61);
    expect(late).toEqual({ ok: false, error: "signature expired" });
  });

  it("requires Signature-Agent to be covered when present", async () => {
    const kp = generateKeyPair();
    const headers = signWebBotAuth({ secretKey: kp.secretKey, publicKey: kp.publicKey, authority: "a.test" });
    headers["signature-agent"] = 'agent1="https://spoof.example"';
    const r = await verifyWebBotAuth({ method: "GET", authority: "a.test", path: "/", headers }, async () => kp.publicKey);
    expect(r).toEqual({ ok: false, error: "Signature-Agent present but not covered by the signature" });
  });
});
