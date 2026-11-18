import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartSpline, FolderOpen, Plus, Sparkles, X } from 'lucide-react';
import type { SignalDef } from '@cygnus/protocol';
import {
  SignalPicker,
  displayName,
  pickFile,
  primarySignals,
  useBus,
  useConnection,
  useDevice,
  useDevices,
  useSelectedDevice,
  type DeviceView,
  type SignalRef,
} from '../../core';
import { useI18n } from '../../i18n';
import { Badge, Button, EmptyState, Modal, Page, toast } from '../../ui';
import type { FeatureProps } from '../registry';
import {
  MAX_SIGNALS,
  addPane,
  addSignal,
  defaultLayout,
  groupedLayout,
  moveSignal,
  patchSignal,
  removePane,
  removeSignal,
  setAxis,
  signalId,
  type Axis,
  type ScopeLayout,
  type ScopeMode,
  type ScopeSignalCfg,
} from './layout';
import { MeasurePanel } from './MeasurePanel';
import { Panes } from './Panes';
import { RecordPanel } from './RecordPanel';
import { SignalsPanel } from './SignalsPanel';
import { SourceManager, type WantedSignal } from './sources';
import { Toolbar } from './Toolbar';
import { TriggerPanel } from './TriggerPanel';
import { parseRecording, buildStaticSession, type ParsedRecording, type StaticSession } from './recording';
import { scopeLayoutSection } from './project';
import { tScope } from './messages';
import type { PlotSignal } from './types';
import { ScopeView } from './view';
import './scope.css';

function signalDef(d: DeviceView | undefined, key: string): SignalDef | undefined {
  return d?.def?.signals.find((s) => s.key === key);
}

/** Catalog signals worth plotting for a board, grouped into panes by unit. */
function recommendedFor(d: DeviceView, base: ScopeLayout): ScopeLayout | null {
  const specs = primarySignals(d.def, 4)
    .map((k) => signalDef(d, k))
    .filter((s): s is SignalDef => !!s && !s.options && !s.bits)
    .map((s) => ({ key: s.key, unit: s.unit }));
  return specs.length ? groupedLayout(d.uid48, specs, base) : null;
}

export function ScopeScreen({ params }: FeatureProps) {
  const { t, tl, lang } = useI18n();
  const phase = useConnection((s) => s.phase);
  const bus = useBus();
  const devices = useDevices();
  const [selected] = useSelectedDevice();
  const fromUrl = useDevice(params.device);
  const stored = scopeLayoutSection.use();
  const [mode, setMode] = useState<ScopeMode>('normal');
  const [session, setSession] = useState<StaticSession | null>(null);
  const [staticLayout, setStaticLayout] = useState<ScopeLayout | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rev, setRev] = useState(0);

  const view = useMemo(() => new ScopeView(), []);
  const manager = useMemo(() => new SourceManager(() => setRev((n) => n + 1)), []);
  useEffect(() => () => manager.dispose(), [manager]);

  const layout: ScopeLayout = session ? (staticLayout ?? session.layout) : stored;
  const byUid = useMemo(() => new Map(devices.map((d) => [d.uid48, d])), [devices]);

  // --- per-signal metadata -------------------------------------------------------------
  const metaOf = useCallback(
    (cfg: ScopeSignalCfg): Pick<PlotSignal, 'label' | 'device' | 'name' | 'unit' | 'digits' | 'present'> => {
      if (session) {
        const m = session.meta.get(cfg.id);
        return { label: m?.label ?? cfg.id, device: '', name: m?.label ?? cfg.id, unit: m?.unit ?? '', digits: 3, present: true };
      }
      const d = byUid.get(cfg.uid48);
      const sig = signalDef(d, cfg.key);
      const device = d ? displayName(d, lang) : cfg.uid48.slice(-4);
      const name = sig ? tl(sig.label) : cfg.key;
      return { label: `${device} · ${name}`, device, name, unit: sig?.unit ?? '', digits: sig?.digits ?? 2, present: !!d };
    },
    [session, byUid, lang, tl],
  );
  const metaRef = useRef(metaOf);
  metaRef.current = metaOf;
  const unitOf = useCallback((c: ScopeSignalCfg): string => metaRef.current(c).unit, []);

  // --- sources -------------------------------------------------------------------------
  const wantedKey = stored.signals.map((s) => s.id).join(',');
  const onlineKey = devices.filter((d) => d.online).map((d) => d.uid48).join(',');
  useEffect(() => {
    const wanted: WantedSignal[] = session ? [] : stored.signals.map((s) => ({ id: s.id, uid48: s.uid48, key: s.key }));
    manager.sync(wanted, mode, stored.periodUs, bus);
    // `wantedKey`/`onlineKey` stand in for the signal list and device availability.
  }, [manager, wantedKey, onlineKey, mode, stored.periodUs, bus, session]);

  const buffers = session ? session.buffers : manager.buffers;
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  useEffect(() => {
    view.liveNow = () => {
      let latest = Number.NaN;
      for (const b of buffersRef.current.values()) {
        const lt = b.lastTime;
        if (Number.isFinite(lt) && !(lt <= latest)) latest = lt;
      }
      return latest;
    };
  }, [view]);

  // Window of the live view follows the stored setting; a recording fits its extent.
  useEffect(() => {
    if (session) {
      view.clearCursors();
      view.fit(session.extent[0], session.extent[1]);
    } else {
      view.clearCursors();
      view.setSpan(stored.windowS);
      view.resume();
    }
    // Only the session switch re-initialises the view.
  }, [session, view]);
  useEffect(() => {
    if (!session) view.setSpan(stored.windowS);
  }, [stored.windowS, session, view]);

  const plotSignals = useMemo<PlotSignal[]>(
    () => layout.signals.map((cfg) => ({ ...cfg, ...metaOf(cfg), buffer: buffers.get(cfg.id) })),
    // `rev` changes when the source manager (re)creates buffers.
    [layout.signals, metaOf, buffers, rev],
  );

  // --- layout edits --------------------------------------------------------------------
  const edit = useCallback(
    (fn: (l: ScopeLayout) => ScopeLayout): void => {
      if (session) setStaticLayout((cur) => fn(cur ?? session.layout));
      else scopeLayoutSection.set(fn);
    },
    [session],
  );

  const applyPick = (next: SignalRef[]): void => {
    edit((cur) => {
      let l = cur;
      const keep = new Set(next.map((r) => signalId(r.uid48, r.key)));
      for (const s of cur.signals) if (!keep.has(s.id)) l = removeSignal(l, s.id);
      for (const r of next) {
        if (l.signals.some((s) => s.id === signalId(r.uid48, r.key))) continue;
        const unit = signalDef(byUid.get(r.uid48), r.key)?.unit ?? '';
        // Join the pane that already plots this unit so related traces share an axis.
        const sibling = l.signals.find((s) => metaOf(s).unit === unit && unit !== '');
        l = addSignal(l, r.uid48, r.key, unit, unitOf, sibling?.pane);
      }
      return l;
    });
  };

  const recommendDevice = fromUrl ?? selected ?? devices.find((d) => d.online && d.def && primarySignals(d.def).length > 0);
  const recommended = recommendDevice ? recommendedFor(recommendDevice, defaultLayout()) : null;
  const applyRecommended = (): void => {
    if (!recommendDevice) return;
    const next = recommendedFor(recommendDevice, stored);
    if (next) scopeLayoutSection.set(next);
  };

  const openRecording = (name: string, rec: ParsedRecording): void => {
    setStaticLayout(null);
    setSession(buildStaticSession(name, rec));
  };
  const openFile = async (): Promise<void> => {
    const f = await pickFile('.csv,.json,text/csv,application/json');
    if (!f) return;
    const rec = parseRecording(await f.text());
    if (rec) openRecording(f.name, rec);
    else toast.error(tScope('fileUnreadable'));
  };

  // --- stream limits -------------------------------------------------------------------
  const cards = useMemo(() => [...new Set(stored.signals.map((s) => s.uid48))].map((u) => byUid.get(u)).filter((d): d is DeviceView => !!d?.def), [stored.signals, byUid]);
  const minPeriodUs = cards.length ? Math.min(...cards.map((d) => d.def?.stream.minPeriodUs ?? 500)) : 500;
  const clamped = cards.some((d) => (d.def?.stream.minPeriodUs ?? 0) > stored.periodUs);
  const streamPeriods = [...manager.periods.values()];

  // --- render --------------------------------------------------------------------------
  const noConnection = !session && stored.signals.length === 0 && (phase === 'idle' || phase === 'error');
  const empty = layout.signals.length === 0;

  const issueText = (kind: 'noSlots' | 'unsupported' | 'failed', uid: string, detail: string): string => {
    const d = byUid.get(uid);
    const name = d ? displayName(d, lang) : uid.slice(-4);
    if (kind === 'noSlots') return tScope('issueNoSlots', { name, count: detail });
    if (kind === 'unsupported') return tScope('issueUnsupported', { name });
    return tScope('issueFailed', { name, error: detail });
  };

  const pickerValue: SignalRef[] = stored.signals.map((s) => ({ uid48: s.uid48, key: s.key }));

  return (
    <Page
      layout="fill"
      title={t('nav.scope')}
      subtitle={tScope('subtitle')}
      icon={ChartSpline}
      actions={
        session ? undefined : (
          <Button size="sm" variant="secondary" icon={FolderOpen} onClick={() => void openFile()}>
            {tScope('openFile')}
          </Button>
        )
      }
      toolbar={
        session ? (
          <div className="scope-toolbar scope-toolbar--session">
            <Badge tone="accent" icon={FolderOpen}>
              {tScope('viewingRecording')}
            </Badge>
            <strong className="scope-toolbar__file">{session.name}</strong>
            <span className="scope-toolbar__hint">{tScope('recordingInfo', { samples: session.samples, channels: session.layout.signals.length })}</span>
            <span className="scope-toolbar__spacer" />
            <Button size="sm" variant="secondary" onClick={() => view.fit(session.extent[0], session.extent[1])}>
              {tScope('fit')}
            </Button>
            <Button size="sm" variant="primary" icon={X} onClick={() => setSession(null)}>
              {tScope('backToLive')}
            </Button>
          </div>
        ) : (
          <Toolbar
            view={view}
            mode={mode}
            onMode={setMode}
            windowS={stored.windowS}
            onWindow={(s) => scopeLayoutSection.set((l) => ({ ...l, windowS: s }))}
            periodUs={stored.periodUs}
            onPeriod={(us) => scopeLayoutSection.set((l) => ({ ...l, periodUs: us }))}
            minPeriodUs={minPeriodUs}
            clamped={clamped}
            streamPeriods={streamPeriods}
            recommendedLabel={recommended && recommendDevice ? displayName(recommendDevice, lang) : null}
            onRecommended={applyRecommended}
            onClear={() => scopeLayoutSection.set((l) => ({ ...defaultLayout(), windowS: l.windowS, periodUs: l.periodUs }))}
            hasSignals={stored.signals.length > 0}
          />
        )
      }
    >
      <div className="scope">
        <div className="scope__main">
          {!session &&
            manager.issues.map((i) => (
              <div key={`${i.kind}-${i.uid48}`} className="scope-issue" role="alert">
                <Badge tone="warn" size="sm">
                  {tScope('issue')}
                </Badge>
                {issueText(i.kind, i.uid48, i.detail)}
              </div>
            ))}
          {empty ? (
            <EmptyState
              icon={ChartSpline}
              title={noConnection ? tScope('noConnectionTitle') : tScope('emptyTitle')}
              description={noConnection ? tScope('noConnectionBody') : tScope('emptyBody')}
              actions={
                <>
                  <Button variant="primary" icon={Plus} onClick={() => setPickerOpen(true)}>
                    {tScope('addSignals')}
                  </Button>
                  {recommended && recommendDevice && (
                    <Button icon={Sparkles} onClick={applyRecommended}>
                      {tScope('recommendedFor', { name: displayName(recommendDevice, lang) })}
                    </Button>
                  )}
                  <Button variant="ghost" icon={FolderOpen} onClick={() => void openFile()}>
                    {tScope('openFile')}
                  </Button>
                </>
              }
            />
          ) : (
            <>
              <Panes
                panes={layout.panes}
                signals={plotSignals}
                view={view}
                editable={!session}
                onAddPane={() => edit(addPane)}
                onRemovePane={(id) => edit((l) => removePane(l, id, unitOf))}
                onToggle={(id) => edit((l) => patchSignal(l, id, { visible: !(l.signals.find((s) => s.id === id)?.visible ?? true) }))}
              />
              <MeasurePanel view={view} signals={plotSignals} />
            </>
          )}
        </div>
        <aside className="scope__side">
          <SignalsPanel
            signals={plotSignals}
            panes={layout.panes}
            view={view}
            editable={!session}
            onAdd={() => setPickerOpen(true)}
            onRemove={(id) => edit((l) => removeSignal(l, id))}
            onColor={(id, color) => edit((l) => patchSignal(l, id, { color }))}
            onVisible={(id, visible) => edit((l) => patchSignal(l, id, { visible }))}
            onAxis={(id, axis: Axis) => edit((l) => setAxis(l, id, axis, unitOf))}
            onMove={(id, pane) => edit((l) => moveSignal(l, id, pane, unitOf))}
          />
          {!session && <TriggerPanel signals={plotSignals} view={view} />}
          {!session && <RecordPanel signals={plotSignals} onOpen={openRecording} />}
        </aside>
      </div>
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={tScope('addSignals')}
        size="md"
        footer={
          <Button variant="primary" onClick={() => setPickerOpen(false)}>
            {t('common.close')}
          </Button>
        }
      >
        <SignalPicker value={pickerValue} onChange={applyPick} max={MAX_SIGNALS} numericOnly height={380} />
      </Modal>
    </Page>
  );
}
