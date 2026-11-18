import { useEffect, useMemo, useRef, useState } from 'react';
import { FRAME_TRACE_CAPACITY, frameTrace } from '../../core';
import { IdAggregator, freqOf, type IdEntry } from './aggregate';
import { FrameAnnotator } from './annotate';
import { compileFilter, FLAG_ERROR, FLAG_UNANSWERED, type FrameFilter } from './filter';
import { StreamIndex } from './streamIndex';

export type IdSort = 'id' | 'count' | 'freq';

export interface RateSnapshot {
  classFps: ReadonlyMap<number, number>;
  totalFps: number;
  top: readonly IdEntry[];
}

export interface TraceSnapshot {
  /** Changes whenever rows, entries or annotations changed. */
  rev: number;
  rows: readonly number[];
  entries: readonly IdEntry[];
  latestT: number;
  rates: RateSnapshot;
  flagsOf: (seq: number) => number;
  /** Sequence number of the oldest frame still in the trace. */
  oldest: number;
  /** Time of the first kept frame, ms (reference for relative times). */
  firstT: number;
}

const EMPTY_RATES: RateSnapshot = { classFps: new Map(), totalFps: 0, top: [] };

export function sortEntries(entries: IdEntry[], sort: IdSort): IdEntry[] {
  const by: Record<IdSort, (a: IdEntry, b: IdEntry) => number> = {
    id: (a, b) => a.id - b.id,
    count: (a, b) => b.count - a.count || a.id - b.id,
    freq: (a, b) => (freqOf(b.periodMs) ?? 0) - (freqOf(a.periodMs) ?? 0) || a.id - b.id,
  };
  return entries.sort(by[sort]);
}

/**
 * Feeds the three views from the core frame trace: a filtered row list for the stream, one
 * entry per identifier with measured periods, and per-second rates. Refreshes at 10 Hz while
 * the trace changes (and immediately when the filter does); rates are sampled once a second.
 */
export function useTraceEngine(filter: FrameFilter, view: 'stream' | 'byid', sort: IdSort, active: boolean): [TraceSnapshot, () => void] {
  const engine = useMemo(() => ({ ann: new FrameAnnotator(FRAME_TRACE_CAPACITY), agg: new IdAggregator(), index: new StreamIndex() }), []);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const viewRef = useRef(view);
  viewRef.current = view;
  const sortRef = useRef(sort);
  sortRef.current = sort;
  const lastKey = useRef('');
  const rates = useRef<RateSnapshot>(EMPTY_RATES);
  const [snap, setSnap] = useState<TraceSnapshot>(() => ({
    rev: 0,
    rows: [],
    entries: [],
    latestT: 0,
    rates: EMPTY_RATES,
    flagsOf: () => 0,
    oldest: 0,
    firstT: 0,
  }));

  useEffect(() => {
    if (!active) return;
    let rev = 0;
    let lastRate = 0;
    const refresh = (force: boolean): void => {
      const f = filterRef.current;
      const key = `${frameTrace.version}|${frameTrace.totalSeen}|${JSON.stringify(f)}|${viewRef.current}|${sortRef.current}`;
      const now = Date.now();
      const rateDue = now - lastRate >= 1000;
      // Pending requests can time out without any new frame, but only while frames flow.
      if (!force && key === lastKey.current && !rateDue) return;
      lastKey.current = key;
      engine.ann.update(frameTrace);
      engine.agg.update(frameTrace);
      if (rateDue) {
        lastRate = now;
        engine.agg.sampleRates(now);
        rates.current = { classFps: engine.agg.classFps, totalFps: engine.agg.totalFps, top: engine.agg.topTalkers(5) };
      }
      let rows: readonly number[] = [];
      let entries: IdEntry[] = [];
      if (viewRef.current === 'stream') rows = engine.index.update(frameTrace, f, (s) => engine.ann.flagsOf(s));
      else {
        const m = compileFilter(f);
        entries = sortEntries(
          engine.agg.entries().filter((e) =>
            m.match({ id: e.id, dir: e.dir, flags: engine.ann.flagsOf(e.lastSeq) & (FLAG_ERROR | FLAG_UNANSWERED) }, m.needsData ? e.data : null),
          ),
          sortRef.current,
        );
      }
      const oldest = frameTrace.totalSeen - frameTrace.length;
      setSnap({
        rev: ++rev,
        rows,
        entries,
        latestT: engine.agg.latestT,
        rates: rates.current,
        flagsOf: (s) => engine.ann.flagsOf(s),
        oldest,
        firstT: frameTrace.get(0)?.t ?? 0,
      });
    };
    refresh(true);
    const h = setInterval(() => refresh(false), 100);
    return () => clearInterval(h);
  }, [engine, active, filter, view, sort]);

  const clear = useMemo(
    () => (): void => {
      frameTrace.clear();
      engine.ann.reset();
      engine.agg.reset();
      engine.index.reset();
      lastKey.current = '';
      rates.current = EMPTY_RATES;
      setSnap((s) => ({ ...s, rev: s.rev + 1, rows: [], entries: [], rates: EMPTY_RATES, oldest: 0, firstT: 0 }));
    },
    [engine],
  );

  return [snap, clear];
}
