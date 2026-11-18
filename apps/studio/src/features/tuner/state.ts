import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { GainRole } from '@cygnus/protocol';
import { paramCache } from '../../core';
import type { ProgramKind } from './engine';
import type { Aggressiveness } from './analysis/tuning';
import type { RelayRule } from './analysis/relay';
import type { Gains } from './types';

export type RightTab = 'gains' | 'test' | 'metrics' | 'assist' | 'freq';
export type CenterView = 'live' | 'compare' | 'bode';

export interface BusyTest {
  kind: ProgramKind;
  startedAt: number;
  /** Expected length, s (for the progress bar). */
  duration: number;
}

interface TunerUi {
  uid: string | null;
  loopKey: string | null;
  rightTab: RightTab;
  view: CenterView;
  /** Runs overlaid in the comparison view. */
  selected: string[];
  /** Run whose metrics are shown. */
  focus: string | null;
  busy: BusyTest | null;
  aggressiveness: Aggressiveness;
  relayRule: RelayRule;
}

export const useTunerUi = create<TunerUi>(() => ({
  uid: null,
  loopKey: null,
  rightTab: 'test',
  view: 'live',
  selected: [],
  focus: null,
  busy: null,
  aggressiveness: 'balanced',
  relayRule: 'tl-pid',
}));

export function setUi(patch: Partial<TunerUi>): void {
  useTunerUi.setState(patch);
}

export function toggleSelected(id: string): void {
  useTunerUi.setState((s) => ({ selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id] }));
}

// ---- parameter values ------------------------------------------------------------------------

/**
 * Values of several board parameters (cache-backed, read on first use). The returned object is
 * stable until one of the values changes; `keys` should be memoised by the caller.
 */
export function useParamValues(uid48: string | null | undefined, keys: readonly string[]): Readonly<Record<string, number | undefined>> {
  const cache = useRef<Record<string, number | undefined>>({});
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!uid48) return () => undefined;
      const offs = keys.map((k) => paramCache.subscribe(uid48, k, cb));
      return () => {
        for (const off of offs) off();
      };
    },
    [uid48, keys],
  );
  const get = useCallback(() => {
    const prev = cache.current;
    let same = Object.keys(prev).length === keys.length;
    for (const k of keys) if (!(k in prev) || !Object.is(prev[k], uid48 ? paramCache.read(uid48, k).value : undefined)) same = false;
    if (same) return prev;
    const next: Record<string, number | undefined> = {};
    for (const k of keys) next[k] = uid48 ? paramCache.read(uid48, k).value : undefined;
    cache.current = next;
    return next;
  }, [uid48, keys]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Gains of a loop from parameter values, by role. */
export function useLoopGains(uid48: string | null | undefined, gainKeys: Partial<Record<GainRole, string>>): Gains {
  const keys = useMemo(() => Object.values(gainKeys).filter((k): k is string => !!k), [gainKeys]);
  const vals = useParamValues(uid48, keys);
  return useMemo(() => {
    const g: Gains = {};
    for (const [role, key] of Object.entries(gainKeys) as Array<[GainRole, string]>) {
      const v = vals[key];
      if (v !== undefined) g[role] = v;
    }
    return g;
  }, [vals, gainKeys]);
}

// ---- gain history (session only) -------------------------------------------------------------

const history = new Map<string, Gains[]>();
const baselines = new Map<string, Gains>();
const historyListeners = new Set<() => void>();
let historyVersion = 0;

function bump(): void {
  historyVersion++;
  for (const cb of historyListeners) cb();
}

export function pushHistory(id: string, g: Gains): void {
  const h = history.get(id) ?? [];
  const last = h[h.length - 1];
  if (last && sameGains(last, g)) return;
  h.push({ ...g });
  if (h.length > 50) h.shift();
  history.set(id, h);
  bump();
}

export function popHistory(id: string): Gains | undefined {
  const h = history.get(id);
  const g = h?.pop();
  if (g) bump();
  return g;
}

export function historyDepth(id: string): number {
  return history.get(id)?.length ?? 0;
}

/** Gains as stored on the board's flash (known at first sight of a saved board, or after save). */
export function baseline(id: string): Gains | undefined {
  return baselines.get(id);
}

export function setBaseline(id: string, g: Gains): void {
  baselines.set(id, { ...g });
  bump();
}

export function useHistoryVersion(): number {
  return useSyncExternalStore(
    (cb) => {
      historyListeners.add(cb);
      return () => historyListeners.delete(cb);
    },
    () => historyVersion,
  );
}

export function sameGains(a: Gains, b: Gains): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<GainRole>;
  for (const k of keys) if (!Object.is(a[k], b[k])) return false;
  return true;
}
