import { tokenize } from "./embeddings.js";

/** ltree label: [a-z0-9_], 1..48 chars. */
export function normalizeLabel(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}
/** Accepts "dev/databases/postgres", "dev.databases.postgres" or "Dev / Data Bases". */
export function normalizePath(p: string): string {
  return p.split(/[/.>]+/).map(normalizeLabel).filter(Boolean).join(".");
}
export const displayPath = (ltreePath: string) => ltreePath.replace(/\./g, "/");
export function isValidPath(p: string): boolean {
  return /^[a-z0-9_]{1,48}(\.[a-z0-9_]{1,48}){0,7}$/.test(p);
}
export const normTitle = (s: string) => tokenize(s).join(" ");

/** to_tsquery-safe OR query from free text (+ optional expansion terms). */
export function orTsQuery(text: string, extra: string[] = []): string | null {
  const terms = [...new Set([...text.split(/\s+/), ...extra].flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/)).filter((t) => t.length > 1 && t.length < 40))];
  return terms.length ? terms.map((t) => `'${t}':*`).join(" | ") : null;
}

export function snippet(body: string, n = 220): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
