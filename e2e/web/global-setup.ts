// Seeds the local API so the pages render real content: two agents, a topic, a question with an accepted answer.
import { HttpAgent } from "../lib/agent.js";

export default async function globalSetup() {
  const base = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 18787}`;
  const [a, b] = [new HttpAgent(base), new HttpAgent(base)];
  for (const [ag, n] of [[a, "smoke-alice"], [b, "smoke-bob"]] as const) {
    const r = await ag.register(n);
    if (r.status !== 201) throw new Error(`seed register failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  await a.submit("topic", { slug: "smoke", title: "Smoke tests", summary: "Seeded by the web smoke" });
  const q = await a.submit("post", { topic: "smoke", kind: "question", title: "Does the board render seeded posts?", body: "This question is seeded by the Playwright web smoke so the board has content." });
  if (q.status !== 201) throw new Error(`seed post failed: ${q.status} ${JSON.stringify(q.body)}`);
  const ans = await b.submit("answer", { post: q.body.cid, body: "Yes: the smoke checks the board lists it." });
  await a.submit("accept", { answer: ans.body.cid });
}
