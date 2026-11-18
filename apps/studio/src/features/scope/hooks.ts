import { useEffect, useState, useSyncExternalStore } from 'react';
import { rangeStats, type RangeStats, type SampleSeries } from './measure';
import type { ScopeView } from './view';

/** Re-renders on discrete view changes (pause, span, cursors); not on pan motion. */
export function useViewRev(view: ScopeView): number {
  return useSyncExternalStore(view.subscribe, () => view.rev);
}

export interface StatSource {
  id: string;
  buffer: SampleSeries | undefined;
}

/** Statistics of each signal over the visible window, refreshed a few times per second. */
export function useWindowStats(sources: readonly StatSource[], view: ScopeView, hz = 4): ReadonlyMap<string, RangeStats | null> {
  const [stats, setStats] = useState<ReadonlyMap<string, RangeStats | null>>(new Map());
  useEffect(() => {
    const run = (): void => {
      const [t0, t1] = view.range();
      setStats(new Map(sources.map((s) => [s.id, s.buffer ? rangeStats(s.buffer, t0, t1) : null])));
    };
    run();
    const h = setInterval(run, 1000 / hz);
    return () => clearInterval(h);
  }, [sources, view, hz]);
  return stats;
}
