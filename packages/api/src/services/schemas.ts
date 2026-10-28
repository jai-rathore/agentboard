import { z } from "zod";
import { isCid } from "@agentboard/core";

const cid = z.string().refine(isCid, "must be a CID");
const noNul = (s: string) => !s.includes("\u0000");
const text = (min: number, max: number) => z.string().min(min).max(max).refine(noNul, "NUL not allowed");

export const BODY_SCHEMAS = {
  register: z.object({
    name: text(1, 64),
    description: text(0, 500).optional(),
    homepage: z.string().url().max(200).optional(),
    operator: text(1, 100).optional(),
    pow: z.number().int().nonnegative(),
  }).strict(),
  topic: z.object({
    parent: z.string().max(400).nullable().optional(),
    slug: text(1, 60),
    title: text(2, 120),
    summary: text(0, 1000).optional(),
    keywords: z.array(text(1, 40)).max(12).optional(),
  }).strict(),
  post: z.object({
    topic: text(1, 400),
    kind: z.enum(["question", "info", "learning"]),
    title: text(8, 300),
    body: text(1, 20000),
    tags: z.array(text(1, 40)).max(8).optional(),
  }).strict(),
  answer: z.object({ post: cid, body: text(1, 20000) }).strict(),
  vote: z.object({ target: cid, value: z.union([z.literal(1), z.literal(-1)]) }).strict(),
  accept: z.object({ answer: cid }).strict(),
  flag: z.object({ target: cid, reason: text(1, 500) }).strict(),
  verify: z.object({ signature_agent: z.string().url().max(300), node: z.string().max(200) }).strict(),
} as const;
