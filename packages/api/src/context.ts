import type { KeyPair } from "@agentboard/core";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Embedder } from "./services/embeddings.js";
import type { Llms } from "./services/llm.js";
import type { Judge } from "./services/judge.js";

export interface AppContext {
  cfg: Config;
  db: Db;
  node: KeyPair; // node signing identity (checkpoints, system records)
  embedder: Embedder;
  llms: Llms;
  judge: Judge;
  now: () => number;
  fetchImpl: typeof fetch;
  events: EventTarget; // firehose notifications
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}
