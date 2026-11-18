import { decodeId, idDevType, idNum } from '@cygnus/protocol';
import { bytesHex, classBucket, classLabel, frameKind, idHex } from './ids';

export interface CardRef {
  devType: number;
  num: number;
}

export interface FrameFilter {
  card: CardRef | null;
  /** Empty = every class. Buckets from `classBucket`. */
  classes: readonly number[];
  dir: 'all' | 'rx' | 'tx';
  /** Exact identifier (quick filter from a row). */
  idEq: number | null;
  text: string;
  /** Only unanswered requests and error responses. */
  problemsOnly: boolean;
}

export const EMPTY_FILTER: FrameFilter = { card: null, classes: [], dir: 'all', idEq: null, text: '', problemsOnly: false };

export const isFilterActive = (f: FrameFilter): boolean =>
  f.card !== null || f.classes.length > 0 || f.dir !== 'all' || f.idEq !== null || f.text.trim() !== '' || f.problemsOnly;

/** Bits of the per-frame annotation. */
export const FLAG_ERROR = 1;
export const FLAG_UNANSWERED = 2;

export interface FilterTarget {
  id: number;
  dir: 'rx' | 'tx';
  flags: number;
}

type TextToken = { kind: 'id' | 'data' | 'any'; needle: string };

function tokenize(text: string): TextToken[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((raw): TextToken => {
      const m = /^(id|d|data):(.*)$/.exec(raw);
      if (m) return { kind: m[1] === 'id' ? 'id' : 'data', needle: (m[2] ?? '').replace(/^0x/, '') };
      return { kind: 'any', needle: raw.replace(/^0x/, '') };
    })
    .filter((t) => t.needle !== '');
}

export interface CompiledFilter {
  /** True when matching needs the payload bytes (so the caller must fetch them). */
  needsData: boolean;
  match(t: FilterTarget, data: Uint8Array | null): boolean;
}

/**
 * Turns the filter into a predicate. Text is split on spaces and every word must match:
 * `id:18` (identifier), `d:ff01` (payload hex), or a bare word matching identifier hex,
 * payload hex or the class name (`status`, `param`).
 */
export function compileFilter(f: FrameFilter): CompiledFilter {
  const tokens = tokenize(f.text);
  const classes = new Set(f.classes);
  const needsData = tokens.some((t) => t.kind !== 'id');
  return {
    needsData,
    match(t, data) {
      if (f.dir !== 'all' && t.dir !== f.dir) return false;
      if (f.idEq !== null && t.id !== f.idEq) return false;
      if (f.card && !(idDevType(t.id) === f.card.devType && idNum(t.id) === f.card.num && frameKind(t.id) !== 'foreign')) return false;
      if (classes.size > 0 && !classes.has(classBucket(t.id))) return false;
      if (f.problemsOnly && (t.flags & (FLAG_ERROR | FLAG_UNANSWERED)) === 0) return false;
      if (tokens.length === 0) return true;
      const hexId = idHex(t.id).toLowerCase();
      const hexData = data ? bytesHex(data, '').toLowerCase() : '';
      const cls = classLabel(t.id).toLowerCase();
      for (const tok of tokens) {
        if (tok.kind === 'id') {
          if (!hexId.includes(tok.needle)) return false;
        } else if (tok.kind === 'data') {
          if (!hexData.includes(tok.needle)) return false;
        } else if (!hexId.includes(tok.needle) && !hexData.includes(tok.needle) && !cls.includes(tok.needle)) return false;
      }
      return true;
    },
  };
}

/** Address of a CyCAN frame's card, or null for foreign/legacy frames and broadcasts. */
export function cardOf(id: number): CardRef | null {
  if (frameKind(id) === 'foreign') return null;
  const f = decodeId(id);
  return { devType: f.devType, num: f.num };
}

export const sameCard = (a: CardRef | null, b: CardRef | null): boolean => !!a && !!b && a.devType === b.devType && a.num === b.num;
