/**
 * Reciprocal rank fusion (Cormack, Clarke & Buettcher 2009):
 *   score(d) = sum_over_lists( weight_l / (k + rank_l(d)) ),  rank starting at 1
 * Lists are ordered best-first. Items missing from a list contribute nothing for it.
 */
export interface RankedList { name: string; ids: string[]; weight?: number }
export interface Fused { id: string; score: number; ranks: Record<string, number> }

export function reciprocalRankFusion(lists: RankedList[], k = 60): Fused[] {
  const acc = new Map<string, Fused>();
  for (const list of lists) {
    const w = list.weight ?? 1;
    const seen = new Set<string>();
    list.ids.forEach((id, i) => {
      if (seen.has(id)) return; // duplicates within one list count once, at their best rank
      seen.add(id);
      const f = acc.get(id) ?? { id, score: 0, ranks: {} };
      f.score += w / (k + i + 1);
      f.ranks[list.name] = i + 1;
      acc.set(id, f);
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
