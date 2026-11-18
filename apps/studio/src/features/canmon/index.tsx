import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileDown, Pause, Play, ScrollText, Send, Trash2 } from 'lucide-react';
import type { FrameDescription } from '@cygnus/protocol';
import { downloadFile, frameTrace, useBus, useBusStats, useConnection, useDevices, useSettings, type TracedFrame } from '../../core';
import { useI18n } from '../../i18n';
import { Button, EmptyState, Page, SegmentedControl, Select, type RowKey } from '../../ui';
import type { FeatureProps } from '../registry';
import { useTraceEngine, type IdSort } from './engine';
import { Filters } from './Filters';
import { FrameDetail, type DetailFrame } from './FrameDetail';
import { IdTable, StreamTable, TraceEmpty } from './FrameTables';
import { EMPTY_FILTER, compileFilter, isFilterActive, type CardRef, type FrameFilter } from './filter';
import { toCandump, toCsv, type TimeMode } from './format';
import { SendPanel } from './SendPanel';
import { StatsStrip } from './StatsStrip';
import { tCanMonitor } from './messages';
import './canmon.css';

type View = 'stream' | 'byid';

const pad2 = (n: number): string => String(n).padStart(2, '0');
function stamp(d = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

const EXPORT_SLICE = 2000;
const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export function CanMonitorScreen(_props: FeatureProps) {
  const { t, lang } = useI18n();
  const bus = useBus();
  const phase = useConnection((s) => s.phase);
  const devices = useDevices();
  const stats = useBusStats();
  const advanced = useSettings((s) => s.advanced);
  const hexIds = useSettings((s) => s.hexIds);
  const [view, setView] = useState<View>('stream');
  const [timeMode, setTimeMode] = useState<TimeMode>('abs');
  const [sort, setSort] = useState<IdSort>('id');
  const [filter, setFilter] = useState<FrameFilter>(EMPTY_FILTER);
  const [paused, setPaused] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [selSeq, setSelSeq] = useState<number | null>(null);
  const [selId, setSelId] = useState<number | null>(null);

  // The core only taps the bus while someone holds the trace.
  useEffect(() => {
    const off = frameTrace.subscribe();
    return () => {
      off();
      frameTrace.setPaused(false);
    };
  }, []);

  const [snap, clear] = useTraceEngine(filter, view, sort, true);
  const connected = phase === 'connected';

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of devices) if (d.name.trim()) m.set(`${d.devType}:${d.num}`, d.name.trim());
    return m;
  }, [devices]);

  const onId = useCallback((id: number) => setFilter((f) => ({ ...f, idEq: id })), []);
  const onCard = useCallback((card: CardRef) => setFilter((f) => ({ ...f, card })), []);

  const togglePause = (): void => {
    frameTrace.setPaused(!paused);
    setPaused(!paused);
  };
  const doClear = (): void => {
    clear();
    setSelSeq(null);
    setSelId(null);
  };

  // --- detail -------------------------------------------------------------------------
  const detail = useMemo<DetailFrame | null>(() => {
    if (view === 'stream' && selSeq !== null) {
      const f = frameTrace.get(selSeq - (frameTrace.totalSeen - frameTrace.length));
      return f && f.seq === selSeq ? f : null;
    }
    if (view === 'byid' && selId !== null) {
      const e = snap.entries.find((x) => x.id === selId);
      return e ? { id: e.id, t: e.lastT, dir: e.dir, fd: e.fd, brs: e.brs, data: e.data } : null;
    }
    return null;
    // The selected stream frame never changes content; entries refresh with every snapshot.
  }, [view, selSeq, selId, snap.entries]);
  const detailDesc = useMemo<FrameDescription | null>(
    () => (detail && bus ? bus.describeFrame({ id: detail.id, data: detail.data, fd: detail.fd, brs: detail.brs, timestamp: detail.t }, lang) : null),
    [detail, bus, lang],
  );

  // --- export -------------------------------------------------------------------------
  // Up to 50 k frames are filtered and decoded; work in slices and yield between them so the
  // E-STOP shortcut and the drive loop stay responsive during an export.
  const [exporting, setExporting] = useState(false);
  const filteredFrames = async (): Promise<TracedFrame[]> => {
    const m = compileFilter(filter);
    const out: TracedFrame[] = [];
    const snapAt = frameTrace.length;
    for (let i = 0; i < snapAt; i++) {
      const f = frameTrace.get(i);
      if (f && m.match({ id: f.id, dir: f.dir, flags: snap.flagsOf(f.seq) }, f.data)) out.push(f);
      if (i % EXPORT_SLICE === EXPORT_SLICE - 1) await yieldToLoop();
    }
    return out;
  };
  const runExport = async (kind: 'csv' | 'candump'): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    try {
      const frames = await filteredFrames();
      if (kind === 'candump') {
        downloadFile(`cygnus-can-${stamp()}.log`, toCandump(frames), 'text/plain');
        return;
      }
      const rows: Array<{ frame: TracedFrame; summary: string }> = [];
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]!;
        rows.push({ frame, summary: bus ? bus.describeFrame({ id: frame.id, data: frame.data, fd: frame.fd, brs: frame.brs, timestamp: frame.t }, lang).summary : '' });
        if (i % EXPORT_SLICE === EXPORT_SLICE - 1) await yieldToLoop();
      }
      downloadFile(`cygnus-can-${stamp()}.csv`, toCsv(rows), 'text/csv');
    } finally {
      setExporting(false);
    }
  };

  // --- render -------------------------------------------------------------------------
  const filterOn = isFilterActive(filter);
  const total = frameTrace.length;
  const shown = view === 'stream' ? snap.rows.length : snap.entries.length;
  const hasFrames = total > 0;
  const empty = !connected && !hasFrames ? (
    <TraceEmpty title={tCanMonitor('empty.noLinkTitle')} body={tCanMonitor('empty.noLinkBody')} />
  ) : filterOn && hasFrames ? (
    <EmptyState size="sm" icon={ScrollText} title={tCanMonitor('empty.noMatchTitle')} description={tCanMonitor('empty.noMatchBody')} actions={<Button size="sm" onClick={() => setFilter(EMPTY_FILTER)}>{tCanMonitor('filter.reset')}</Button>} />
  ) : (
    <TraceEmpty title={tCanMonitor('empty.noFramesTitle')} body={tCanMonitor('empty.noFramesBody')} />
  );

  const common = { snap, bus, hexIds, names, onId, onCard, empty };
  const streamSel: ReadonlySet<RowKey> = useMemo(() => (selSeq === null ? new Set<RowKey>() : new Set<RowKey>([selSeq])), [selSeq]);
  const idSel: ReadonlySet<RowKey> = useMemo(() => (selId === null ? new Set<RowKey>() : new Set<RowKey>([selId])), [selId]);

  return (
    <Page
      layout="fill"
      title={t('nav.canmon')}
      subtitle={tCanMonitor('subtitle')}
      icon={ScrollText}
      actions={
        <>
          {advanced && (
            <Button size="sm" variant={sendOpen ? 'primary' : 'secondary'} icon={Send} onClick={() => setSendOpen((o) => !o)} aria-pressed={sendOpen}>
              {tCanMonitor('send.toggle')}
            </Button>
          )}
          <Button size="sm" variant={paused ? 'primary' : 'secondary'} icon={paused ? Play : Pause} onClick={togglePause}>
            {paused ? t('ui.chart.resume') : t('ui.chart.pause')}
          </Button>
          <Button size="sm" variant="secondary" icon={Trash2} onClick={doClear} disabled={!hasFrames}>
            {tCanMonitor('clear')}
          </Button>
          <Button size="sm" variant="secondary" icon={FileDown} onClick={() => void runExport('csv')} disabled={!hasFrames || exporting} loading={exporting} title={tCanMonitor('exportHint')}>
            CSV
          </Button>
          <Button size="sm" variant="secondary" icon={FileDown} onClick={() => void runExport('candump')} disabled={!hasFrames || exporting} title={tCanMonitor('exportHint')}>
            candump
          </Button>
        </>
      }
      toolbar={
        <div className="canmon-toolbar">
          <div className="canmon-toolbar__row">
            <SegmentedControl<View>
              size="sm"
              value={view}
              onChange={setView}
              ariaLabel={tCanMonitor('view.label')}
              options={[
                { value: 'stream', label: tCanMonitor('view.stream') },
                { value: 'byid', label: tCanMonitor('view.byId') },
              ]}
            />
            {view === 'stream' ? (
              <Select<TimeMode>
                size="sm"
                value={timeMode}
                onChange={setTimeMode}
                ariaLabel={tCanMonitor('col.time')}
                options={[
                  { value: 'abs', label: `${tCanMonitor('col.time')}: ${tCanMonitor('time.abs')}` },
                  { value: 'rel', label: `${tCanMonitor('col.time')}: ${tCanMonitor('time.rel')}` },
                  { value: 'delta', label: `${tCanMonitor('col.time')}: ${tCanMonitor('time.delta')}` },
                ]}
              />
            ) : (
              <Select<IdSort>
                size="sm"
                value={sort}
                onChange={setSort}
                ariaLabel={tCanMonitor('sort.label')}
                options={[
                  { value: 'id', label: `${tCanMonitor('sort.label')}: ID` },
                  { value: 'count', label: `${tCanMonitor('sort.label')}: ${tCanMonitor('col.count')}` },
                  { value: 'freq', label: `${tCanMonitor('sort.label')}: ${tCanMonitor('col.freq')}` },
                ]}
              />
            )}
            <span className="canmon-toolbar__sep" />
            <Filters filter={filter} onChange={setFilter} devices={devices} shown={shown} total={view === 'stream' ? total : snap.entries.length} />
          </div>
        </div>
      }
    >
      <div className="canmon">
        <StatsStrip rates={snap.rates} stats={stats} online={connected} />
        <div className={detail ? 'canmon__main has-detail' : 'canmon__main'}>
          <div className="canmon__table">
            {view === 'stream' ? (
              <StreamTable {...common} timeMode={timeMode} selected={streamSel} onSelect={setSelSeq} />
            ) : (
              <IdTable {...common} selected={idSel} onSelect={setSelId} />
            )}
          </div>
          {detail && (
            <FrameDetail
              frame={detail}
              desc={detailDesc}
              onClose={() => {
                setSelSeq(null);
                setSelId(null);
              }}
              onFilterId={onId}
              onFilterCard={onCard}
            />
          )}
        </div>
        {advanced && sendOpen && <SendPanel bus={bus} connected={connected} />}
      </div>
    </Page>
  );
}
