import { useMemo, type ReactNode } from 'react';
import { ScrollText } from 'lucide-react';
import type { CygnusBus, FrameDescription } from '@cygnus/protocol';
import { frameTrace, type TracedFrame } from '../../core';
import { fmtNumber, useI18n } from '../../i18n';
import { Badge, DataTable, EmptyState, type Column, type RowKey } from '../../ui';
import type { IdEntry } from './aggregate';
import { freqOf } from './aggregate';
import type { TraceSnapshot } from './engine';
import { FLAG_ERROR, FLAG_UNANSWERED, cardOf, type CardRef } from './filter';
import { fmtFreq, fmtFrameTime, fmtPeriod, frameTypeLabel, type TimeMode } from './format';
import { tCanMonitor } from './messages';
import { Bytes, Decoded, fmtId } from './parts';
import { RowDecodeCache } from './rowCache';

interface Common {
  snap: TraceSnapshot;
  bus: CygnusBus | null;
  hexIds: boolean;
  names: ReadonlyMap<string, string>;
  onId: (id: number) => void;
  onCard: (card: CardRef) => void;
  empty: ReactNode;
}

const nameOf = (names: ReadonlyMap<string, string>, id: number): string => {
  const c = cardOf(id);
  return c ? (names.get(`${c.devType}:${c.num}`) ?? '') : '';
};

function toneOf(flags: number): 'danger' | 'caution' | undefined {
  if (flags & FLAG_ERROR) return 'danger';
  if (flags & FLAG_UNANSWERED) return 'caution';
  return undefined;
}

function IdButton({ id, hex, onClick }: { id: number; hex: boolean; onClick: (id: number) => void }) {
  return (
    <button
      type="button"
      className="canmon-link canmon-link--id cy-mono"
      title={tCanMonitor('filterId')}
      onClick={(e) => {
        e.stopPropagation();
        onClick(id);
      }}
    >
      {fmtId(id, hex)}
    </button>
  );
}

export interface StreamTableProps extends Common {
  timeMode: TimeMode;
  selected: ReadonlySet<RowKey>;
  onSelect: (seq: number | null) => void;
}

/** Time-ordered frames; only the visible rows are decoded. */
export function StreamTable({ snap, bus, hexIds, names, onId, onCard, empty, timeMode, selected, onSelect }: StreamTableProps) {
  const { lang } = useI18n();
  const dec = (v: number, d: number): string => fmtNumber(v, d, { lang, grouping: false });
  const store = useMemo(
    () => new RowDecodeCache<TracedFrame, FrameDescription | null>((f) => (bus ? bus.describeFrame({ id: f.id, data: f.data, fd: f.fd, brs: f.brs, timestamp: f.t }, lang) : null)),
    [bus, lang],
  );
  // `snap.rev` rebinds the lookup whenever the trace moved; decoded rows survive in `store`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => store.view(frameTrace), [snap.rev, store]);
  const cache = useMemo(() => ({ info: view.info, time: (seq: number): number | null => view.frame(seq)?.t ?? null }), [view]);

  const columns = useMemo<Column<number>[]>(
    () => [
      {
        key: 'time',
        header: tCanMonitor('col.time'),
        width: 118,
        mono: true,
        render: (seq, i) => {
          const f = cache.info(seq)?.f;
          if (!f) return null;
          const ref = timeMode === 'rel' ? snap.firstT : timeMode === 'delta' ? (i > 0 ? cache.time(snap.rows[i - 1] ?? -1) : null) : null;
          return fmtFrameTime(timeMode, f.t, ref, dec);
        },
      },
      {
        key: 'dir',
        header: tCanMonitor('col.dir'),
        width: 54,
        render: (seq) => {
          const f = cache.info(seq)?.f;
          return f ? (
            <Badge size="sm" tone={f.dir === 'tx' ? 'accent' : 'neutral'} variant={f.dir === 'tx' ? 'soft' : 'outline'} mono>
              {f.dir.toUpperCase()}
            </Badge>
          ) : null;
        },
      },
      { key: 'id', header: tCanMonitor('col.id'), width: 112, render: (seq) => { const f = cache.info(seq)?.f; return f ? <IdButton id={f.id} hex={hexIds} onClick={onId} /> : null; } },
      { key: 'type', header: tCanMonitor('col.type'), width: 76, render: (seq) => { const f = cache.info(seq)?.f; return f ? <span className="canmon-type">{frameTypeLabel(f)}</span> : null; } },
      { key: 'len', header: tCanMonitor('col.len'), width: 46, mono: true, align: 'right', render: (seq) => cache.info(seq)?.f.data.length ?? null },
      { key: 'data', header: tCanMonitor('col.data'), width: 230, render: (seq) => { const f = cache.info(seq)?.f; return f ? <Bytes data={f.data} /> : null; } },
      {
        key: 'decoded',
        header: tCanMonitor('col.decoded'),
        width: 600,
        render: (seq) => {
          const r = cache.info(seq);
          if (!r) return null;
          return <Decoded id={r.f.id} desc={r.desc} boardName={nameOf(names, r.f.id)} onCard={onCard} />;
        },
      },
    ],
    [cache, timeMode, hexIds, names, onId, onCard, snap.rows, snap.firstT],
  );

  return (
    <DataTable<number>
      rows={snap.rows}
      columns={columns}
      rowKey={(seq) => seq}
      rowHeight={30}
      selection="single"
      selected={selected}
      onSelectionChange={(s) => onSelect(s.size ? ([...s][0] as number) : null)}
      rowTone={(seq) => toneOf(snap.flagsOf(seq))}
      followTail
      empty={empty}
      ariaLabel={tCanMonitor('view.stream')}
    />
  );
}

export interface IdTableProps extends Common {
  selected: ReadonlySet<RowKey>;
  onSelect: (id: number | null) => void;
}

/** One row per identifier: last frame, count, measured period and the bytes that just changed. */
export function IdTable({ snap, bus, hexIds, names, onId, onCard, empty, selected, onSelect }: IdTableProps) {
  const { lang } = useI18n();
  const dec = (v: number, d: number): string => fmtNumber(v, d, { lang, grouping: false });
  const descs = useMemo(() => {
    const m = new Map<number, FrameDescription>();
    if (bus) for (const e of snap.entries) m.set(e.id, bus.describeFrame({ id: e.id, data: e.data, fd: e.fd, brs: e.brs, timestamp: e.lastT }, lang));
    return m;
  }, [snap.entries, bus, lang]);

  const columns = useMemo<Column<IdEntry>[]>(
    () => [
      { key: 'id', header: tCanMonitor('col.id'), width: 112, render: (e) => <IdButton id={e.id} hex={hexIds} onClick={onId} /> },
      {
        key: 'decoded',
        header: tCanMonitor('col.decoded'),
        width: 460,
        render: (e) => {
          return <Decoded id={e.id} desc={descs.get(e.id) ?? null} boardName={nameOf(names, e.id)} onCard={onCard} />;
        },
      },
      {
        key: 'dir',
        header: tCanMonitor('col.dir'),
        width: 54,
        render: (e) => (
          <Badge size="sm" tone={e.dir === 'tx' ? 'accent' : 'neutral'} variant={e.dir === 'tx' ? 'soft' : 'outline'} mono>
            {e.dir.toUpperCase()}
          </Badge>
        ),
      },
      { key: 'count', header: tCanMonitor('col.count'), width: 84, mono: true, align: 'right', render: (e) => fmtNumber(e.count, 0, { lang }) },
      { key: 'period', header: tCanMonitor('col.period'), width: 92, mono: true, align: 'right', render: (e) => fmtPeriod(e.periodMs, dec) },
      { key: 'freq', header: tCanMonitor('col.freq'), width: 92, mono: true, align: 'right', render: (e) => fmtFreq(freqOf(e.periodMs), dec) },
      { key: 'type', header: tCanMonitor('col.type'), width: 76, render: (e) => <span className="canmon-type">{frameTypeLabel(e)}</span> },
      { key: 'len', header: tCanMonitor('col.len'), width: 46, mono: true, align: 'right', render: (e) => e.data.length },
      {
        key: 'data',
        header: tCanMonitor('col.data'),
        width: 230,
        render: (e) => <Bytes data={e.data} changed={(i) => snap.latestT - (e.changedAt[i] ?? Number.NaN) < 1500} />,
      },
    ],
    [descs, hexIds, names, onId, onCard, snap.latestT, lang],
  );

  return (
    <DataTable<IdEntry>
      rows={snap.entries}
      columns={columns}
      rowKey={(e) => e.id}
      rowHeight={30}
      selection="single"
      selected={selected}
      onSelectionChange={(s) => onSelect(s.size ? ([...s][0] as number) : null)}
      rowTone={(e) => toneOf(snap.flagsOf(e.lastSeq))}
      empty={empty}
      ariaLabel={tCanMonitor('view.byId')}
    />
  );
}

export function TraceEmpty({ title, body }: { title: string; body: string }) {
  return <EmptyState size="sm" icon={ScrollText} title={title} description={body} />;
}

