import type { ProjectDevice } from '../../core';

/** What matching needs to know about a board on the bus. */
export interface LiveCard {
  uid48: string;
  model: number;
  devType: number;
  num: number;
  name: string;
  online: boolean;
  legacy: boolean;
  /** Number 63 or a clash: the board cannot be addressed yet. */
  unresolved: boolean;
}

export type SuggestReason = 'modelNum' | 'modelOnly';

export interface Pair {
  project: ProjectDevice;
  live: LiveCard;
  by: 'uid' | 'manual';
}

export interface Suggestion {
  project: ProjectDevice;
  live: LiveCard;
  reason: SuggestReason;
}

export interface MatchResult {
  pairs: Pair[];
  /** Probable replacements: same model and number (or the only candidates of that model). */
  suggestions: Suggestion[];
  /** In the project but not on the bus (and not suggested). */
  missing: ProjectDevice[];
  /** On the bus but not in the project (and not suggested). */
  extra: LiveCard[];
}

/**
 * Pairs project boards with live boards. Identity is the uid48; a board that was replaced has a
 * new uid, so leftovers are matched by model + number as a *suggestion* the user must accept
 * (`manual` maps a project uid48 to the live uid48 the user chose or accepted).
 */
export function matchCards(project: readonly ProjectDevice[], live: readonly LiveCard[], manual: Readonly<Record<string, string>> = {}): MatchResult {
  const liveByUid = new Map(live.map((l) => [l.uid48.toLowerCase(), l]));
  const used = new Set<string>();
  const pairs: Pair[] = [];
  const rest: ProjectDevice[] = [];

  for (const p of project) {
    const l = liveByUid.get(p.uid48.toLowerCase());
    if (l) {
      pairs.push({ project: p, live: l, by: 'uid' });
      used.add(l.uid48);
    } else rest.push(p);
  }

  const unmatched: ProjectDevice[] = [];
  for (const p of rest) {
    const chosen = manual[p.uid48];
    const l = chosen ? liveByUid.get(chosen.toLowerCase()) : undefined;
    if (l && !used.has(l.uid48) && l.model === p.model) {
      pairs.push({ project: p, live: l, by: 'manual' });
      used.add(l.uid48);
    } else unmatched.push(p);
  }

  const free = live.filter((l) => !used.has(l.uid48));
  const suggestions: Suggestion[] = [];
  const takenLive = new Set<string>();
  const missing: ProjectDevice[] = [];
  for (const p of unmatched) {
    const same = free.filter((l) => l.model === p.model && !takenLive.has(l.uid48));
    const byNum = same.find((l) => l.num === p.num && !l.unresolved) ?? same.find((l) => l.num === p.num);
    const onlyOne = same.length === 1 && unmatched.filter((x) => x.model === p.model).length === 1;
    const pick = byNum ? { l: byNum, reason: 'modelNum' as const } : onlyOne && same[0] ? { l: same[0], reason: 'modelOnly' as const } : null;
    if (pick) {
      takenLive.add(pick.l.uid48);
      suggestions.push({ project: p, live: pick.l, reason: pick.reason });
    } else missing.push(p);
  }

  return { pairs, suggestions, missing, extra: free.filter((l) => !takenLive.has(l.uid48)) };
}

/** Candidates for hand-pairing a missing project board: same model, still unpaired. */
export function candidatesFor(p: ProjectDevice, result: Pick<MatchResult, 'extra' | 'suggestions'>): LiveCard[] {
  return [...result.extra, ...result.suggestions.map((s) => s.live)].filter((l) => l.model === p.model);
}
