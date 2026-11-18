import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, CircleAlert, CopyPlus, Download, RefreshCw, Upload, Wrench } from 'lucide-react';
import { getModel } from '@cygnus/protocol';
import { useI18n, type Lang } from '../../i18n';
import { Badge, Button, Checkbox, EmptyState, Modal, Panel, ProgressBar, Select, Toggle, toast } from '../../ui';
import { DeviceBadge, describeError, updateProject, useBus, useConnection, useProject, type DeviceView, type ProjectDevice } from '../../core';
import { copyCardToProject, diffCard, differing, replaceDevice, type CardState, type DiffRow } from './diff';
import { candidatesFor, matchCards, type LiveCard, type Pair, type Suggestion } from './match';
import { installReplacement, type ReplaceOutcome } from './replace';
import { restoreToCard, type RestoreSummary } from './restore';
import { formatParam } from './report';
import { projectDeviceOf, useLiveCards } from './live';
import { tProject } from './messages';

type States = Record<string, Record<string, number>>;

const cardLabel = (d: { name: string; modelKey?: string }, fallback: string): string => d.name.trim() || fallback;

function valueText(r: DiffRow, v: number | string | undefined, lang: Lang): string {
  if (v === undefined) return '—';
  if (r.kind === 'num') return `#${v}`;
  if (r.kind === 'name') return String(v) || '—';
  return r.def && typeof v === 'number' ? formatParam(r.def, v, lang) : String(v);
}

interface CardBlockProps {
  pair: Pair;
  view: DeviceView;
  params: Record<string, number> | undefined;
  onlyDiff: boolean;
  save: boolean;
  onReload: (uid: string) => Promise<void>;
}

function CardBlock({ pair, view, params, onlyDiff, save, onReload }: CardBlockProps) {
  const { t, tl, lang } = useI18n();
  const bus = useBus();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreSummary | null>(null);
  const def = getModel(pair.project.model);
  const state: CardState | null = params ? { num: view.num, name: view.name, params } : null;
  const rows = useMemo(() => (state ? diffCard(pair.project, state, def) : []), [pair.project, view.num, view.name, params, def]); // eslint-disable-line react-hooks/exhaustive-deps
  const diffs = differing(rows);
  const shown = onlyDiff ? diffs : rows;
  const chosen = diffs.filter((r) => picked.has(r.id));
  const writable = chosen.filter((r) => r.writable);
  const copyable = chosen.filter((r) => r.card !== undefined);

  const toggle = (id: string, on: boolean): void =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const write = async (): Promise<void> => {
    if (!bus) return;
    setBusy(true);
    try {
      const r = await restoreToCard(view.handle, writable, { save, assignNum: (n) => bus.assignId(view.uid48, n, { persist: save }) });
      setResult(r);
      setPicked(new Set());
      await onReload(view.uid48);
      if (r.failed === 0) toast.success(tProject('cmp.written', { count: r.written }), r.saved ? { description: tProject('cmp.savedToCard') } : undefined);
      else toast.warn(tProject('cmp.writtenPartial', { ok: r.written, failed: r.failed }));
    } finally {
      setBusy(false);
    }
  };
  const updateFromCard = (): void => {
    updateProject((p) => ({ ...p, bus: { ...p.bus, devices: p.bus.devices.map((d) => (d.uid48 === pair.project.uid48 ? copyCardToProject(d, copyable) : d)) } }));
    setPicked(new Set());
    toast.success(tProject('cmp.projectUpdated', { count: copyable.length }));
  };

  const title = cardLabel(pair.project, tl(def?.name));
  return (
    <details className="pj-cmp" open={diffs.length > 0} data-testid={`pj-cmp-${pair.project.uid48}`}>
      <summary>
        <DeviceBadge device={view} />
        <span className="pj-muted">{title !== view.name.trim() ? title : ''}</span>
        {pair.by === 'manual' && <Badge size="sm" tone="accent">{tProject('cmp.pairedManually')}</Badge>}
        <span className="pj-cmp__spacer" />
        {!state ? <Badge size="sm">{tProject('cmp.notRead')}</Badge> : diffs.length === 0 ? <Badge tone="ok" size="sm">{tProject('cmp.identical')}</Badge> : <span data-testid="pj-cmp-count"><Badge tone="warn" size="sm">{tProject('cmp.diffCount', { count: diffs.length })}</Badge></span>}
      </summary>
      {state && diffs.length > 0 && (
        <>
          <div className="pj-cmp__bar">
            <Checkbox
              checked={chosen.length === diffs.length && diffs.length > 0}
              indeterminate={chosen.length > 0 && chosen.length < diffs.length}
              onChange={(on) => setPicked(on ? new Set(diffs.map((r) => r.id)) : new Set())}
              label={tProject('cmp.selectAll')}
            />
            <span className="pj-cmp__spacer" />
            <Button size="sm" icon={Download} disabled={copyable.length === 0 || busy} onClick={updateFromCard} data-testid="pj-update-project">
              {tProject('cmp.toProject')}
            </Button>
            <Button size="sm" variant="primary" icon={Upload} disabled={writable.length === 0} loading={busy} onClick={() => void write()} data-testid="pj-write">
              {tProject('cmp.toCard', { count: writable.length })}
            </Button>
          </div>
          <div className="pj-diff" role="table">
            <div className="pj-diff__head" role="row">
              <span />
              <span>{tProject('cmp.col.param')}</span>
              <span>{tProject('cmp.col.project')}</span>
              <span>{tProject('cmp.col.card')}</span>
            </div>
            {shown.map((r) => (
              <label key={r.id} className={r.same ? 'pj-diff__row is-same' : 'pj-diff__row'} role="row">
                <Checkbox checked={picked.has(r.id)} onChange={(on) => toggle(r.id, on)} disabled={r.same} ariaLabel={r.id} />
                <span className="pj-diff__label">
                  <span>{r.kind === 'param' ? (r.def ? tl(r.def.label) : r.key) : t(`project.cmp.${r.kind}`)}</span>
                  <span className="pj-diff__key cy-mono">{r.kind === 'param' ? r.key : ''}</span>
                  {!r.same && r.kind === 'param' && !r.writable && <Badge size="sm">{r.def?.readOnly ? t('common.readOnly') : r.project === undefined ? tProject('cmp.onlyCard') : tProject('cmp.onlyProject')}</Badge>}
                </span>
                <span className="pj-diff__val cy-mono">{valueText(r, r.project, lang)}</span>
                <span className="pj-diff__val cy-mono is-card">{valueText(r, r.card, lang)}</span>
              </label>
            ))}
          </div>
        </>
      )}
      {result && result.failed > 0 && (
        <ul className="pj-errors" role="alert">
          {result.results.filter((r) => !r.ok).map((r) => (
            <li key={r.id}>
              <CircleAlert size={13} aria-hidden /> <span className="cy-mono">{r.id}</span> — {describeError(r.error)}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ReplaceDialog({ project, candidates, preset, onClose }: { project: ProjectDevice; candidates: LiveCard[]; preset?: string; onClose: () => void }) {
  const { t } = useI18n();
  const bus = useBus();
  const { views } = useLiveCards();
  const [target, setTarget] = useState<string | null>(preset ?? candidates[0]?.uid48 ?? null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReplaceOutcome | null>(null);
  const [steps, setSteps] = useState<{ done: number; total: number } | null>(null);
  const view = views.find((v) => v.uid48 === target);
  const def = getModel(project.model);
  const writable = def ? Object.keys(project.params).filter((k) => def.params.some((p) => p.key === k && !p.readOnly)).length : 0;

  const run = async (): Promise<void> => {
    if (!bus || !view) return;
    setBusy(true);
    try {
      const o = await installReplacement(bus, view.handle, project, def, (done, total) => setSteps({ done, total }));
      setOutcome(o);
      if (o.numberSet && o.summary && o.summary.failed === 0) {
        updateProject((p) => ({ ...p, bus: { ...p.bus, devices: replaceDevice(p.bus.devices, project.uid48, { uid48: view.uid48, fw: view.fw ? `${view.fw.major}.${view.fw.minor}.${view.fw.patch}` : null }) } }));
        toast.success(tProject('rep.done'));
      }
    } catch (e) {
      toast.error(tProject('rep.failed'), { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  };
  const ok = outcome?.numberSet && outcome.summary?.failed === 0;
  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!busy}
      title={tProject('rep.title', { name: cardLabel(project, project.modelKey) })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {ok ? t('common.close') : t('common.cancel')}
          </Button>
          {!ok && (
            <Button variant="primary" icon={Wrench} loading={busy} disabled={!view || !bus} onClick={() => void run()} data-testid="pj-replace-go">
              {tProject('rep.install')}
            </Button>
          )}
        </>
      }
    >
      <div className="pj-dialog">
        <p className="pj-lead">{tProject('rep.lead')}</p>
        <div className="pj-dialog__row">
          <span>{tProject('rep.spare')}</span>
          <Select
            value={target}
            onChange={setTarget}
            width={280}
            ariaLabel={tProject('rep.spare')}
            placeholder={tProject('rep.noSpare')}
            options={candidates.map((c) => ({ value: c.uid48, label: `${c.name.trim() || project.modelKey} · #${c.num === 63 ? '—' : c.num} · ${c.uid48}` }))}
            disabled={busy || candidates.length === 0}
          />
        </div>
        {candidates.length === 0 && <div className="pj-note pj-note--warn">{tProject('rep.noSpareBody')}</div>}
        {view && (
          <ul className="pj-plan">
            <li>
              {tProject('rep.planNum', { from: view.unassigned ? '—' : view.num, to: project.num })}
            </li>
            <li>{tProject('rep.planName', { name: project.name || '—' })}</li>
            <li>{tProject('rep.planParams', { count: writable })}</li>
            <li>{tProject('rep.planSave')}</li>
          </ul>
        )}
        {busy && steps && <ProgressBar value={steps.total ? steps.done / steps.total : null} showPercent label={tProject('rep.progress', { done: steps.done, total: steps.total })} />}
        {outcome && (
          <div className={ok ? 'pj-note pj-note--ok' : 'pj-note pj-note--warn'} role="status" data-testid="pj-replace-result">
            {!outcome.numberSet
              ? `${tProject('rep.numberFailed')}: ${describeError(outcome.numberError)}`
              : outcome.summary
                ? tProject('rep.result', { written: outcome.summary.written, failed: outcome.summary.failed })
                : ''}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function CompareTab() {
  const { tl } = useI18n();
  const phase = useConnection((s) => s.phase);
  const generation = useConnection((s) => s.generation);
  const project = useProject((s) => s.project);
  const { views, cards } = useLiveCards();
  const [manual, setManual] = useState<Record<string, string>>({});
  const [states, setStates] = useState<States>({});
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [save, setSave] = useState(true);
  const [replacing, setReplacing] = useState<{ project: ProjectDevice; preset?: string } | null>(null);
  const match = useMemo(() => matchCards(project.bus.devices, cards, manual), [project.bus.devices, cards, manual]);
  const viewOf = useMemo(() => new Map(views.map((v) => [v.uid48, v])), [views]);
  const readable = match.pairs.filter((p) => {
    const v = viewOf.get(p.live.uid48);
    return v && v.online && !v.legacy && !v.unassigned && !v.conflict;
  });

  const readOne = useCallback(
    async (uid: string): Promise<void> => {
      const v = viewOf.get(uid);
      if (!v) return;
      const r = await v.handle.readAllParams();
      setStates((s) => ({ ...s, [uid]: r.values }));
    },
    [viewOf],
  );
  const readAll = useCallback(async (): Promise<void> => {
    setReading({ done: 0, total: readable.length });
    for (let i = 0; i < readable.length; i++) {
      const p = readable[i];
      if (!p) continue;
      try {
        await readOne(p.live.uid48);
      } catch (e) {
        toast.error(tProject('cmp.readFailed'), { description: describeError(e) });
      }
      setReading({ done: i + 1, total: readable.length });
    }
    setReading(null);
  }, [readable, readOne]);

  // Read once per bus when the tab opens so the diff is there without a click.
  const readFor = useRef<number | null>(null);
  useEffect(() => {
    if (phase === 'connected' && readable.length > 0 && readFor.current !== generation) {
      readFor.current = generation;
      void readAll();
    }
  }, [phase, generation, readable.length, readAll]);

  const addExtra = async (live: LiveCard): Promise<void> => {
    const v = viewOf.get(live.uid48);
    if (!v) return;
    try {
      const r = !v.legacy ? await v.handle.readAllParams() : { values: {} as Record<string, number> };
      updateProject((p) => ({ ...p, bus: { ...p.bus, devices: [...p.bus.devices, projectDeviceOf(v, r.values)] } }));
      toast.success(tProject('cmp.added'));
    } catch (e) {
      toast.error(tProject('cmp.readFailed'), { description: describeError(e) });
    }
  };

  if (project.bus.devices.length === 0) {
    return (
      <Panel>
        <EmptyState icon={ArrowLeftRight} title={tProject('cmp.noProject')} description={tProject('cmp.noProjectBody')} />
      </Panel>
    );
  }
  if (phase !== 'connected' && phase !== 'lost') {
    return (
      <Panel>
        <EmptyState icon={ArrowLeftRight} title={tProject('cmp.noConn')} description={tProject('cmp.noConnBody')} />
      </Panel>
    );
  }

  const unmatched = match.suggestions.length + match.missing.length + match.extra.length;
  return (
    <div className="pj-stack">
      <Panel
        title={tProject('cmp.title')}
        subtitle={tProject('cmp.pairs', { count: match.pairs.length, total: project.bus.devices.length })}
        actions={
          <>
            <Toggle size="sm" checked={onlyDiff} onChange={setOnlyDiff} label={tProject('cmp.onlyDiff')} />
            <Toggle size="sm" checked={save} onChange={setSave} label={tProject('cmp.alsoSave')} />
            <Button size="sm" icon={RefreshCw} loading={reading !== null} disabled={readable.length === 0 || phase !== 'connected'} onClick={() => void readAll()} data-testid="pj-compare">
              {tProject('cmp.read')}
            </Button>
          </>
        }
      >
        {reading && <ProgressBar value={reading.total ? reading.done / reading.total : null} size="sm" showPercent label={tProject('cmp.reading', { done: reading.done, total: reading.total })} />}
        <div className="pj-cmps">
          {match.pairs.map((p) => {
            const v = viewOf.get(p.live.uid48);
            if (!v) return null;
            if (v.legacy || !v.online || v.unassigned || v.conflict) {
              return (
                <div key={p.project.uid48} className="pj-cmp pj-cmp--flat">
                  <DeviceBadge device={v} />
                  <Badge size="sm">{v.legacy ? tProject('cmp.legacy') : v.online ? tProject('cmp.unresolved') : tProject('cmp.offline')}</Badge>
                </div>
              );
            }
            return <CardBlock key={p.project.uid48} pair={p} view={v} params={states[p.live.uid48]} onlyDiff={onlyDiff} save={save} onReload={readOne} />;
          })}
        </div>
      </Panel>
      {unmatched > 0 && (
        <Panel title={tProject('mm.title')} subtitle={tProject('mm.subtitle')}>
          <div className="pj-mm" data-testid="pj-mismatch">
            {match.suggestions.map((s: Suggestion) => (
              <div key={s.project.uid48} className="pj-mm__row">
                <Badge tone="warn" size="sm">{tProject(`mm.reason.${s.reason}`)}</Badge>
                <span>
                  <strong>{cardLabel(s.project, s.project.modelKey)}</strong> <span className="pj-muted cy-mono">#{s.project.num} {s.project.uid48}</span>
                </span>
                <span className="pj-muted">→</span>
                <span>
                  <strong>{s.live.name.trim() || tl(getModel(s.live.model)?.name)}</strong> <span className="pj-muted cy-mono">#{s.live.unresolved ? '—' : s.live.num} {s.live.uid48}</span>
                </span>
                <span className="pj-cmp__spacer" />
                <Button size="sm" onClick={() => setManual((m) => ({ ...m, [s.project.uid48]: s.live.uid48 }))}>{tProject('mm.accept')}</Button>
                <Button size="sm" variant="primary" icon={Wrench} disabled={phase !== 'connected'} onClick={() => setReplacing({ project: s.project, preset: s.live.uid48 })} data-testid="pj-replace-suggested">
                  {tProject('mm.replace')}
                </Button>
              </div>
            ))}
            {match.missing.map((m) => {
              const cands = candidatesFor(m, match);
              return (
                <div key={m.uid48} className="pj-mm__row">
                  <Badge tone="danger" size="sm">{tProject('mm.missing')}</Badge>
                  <span>
                    <strong>{cardLabel(m, m.modelKey)}</strong> <span className="pj-muted cy-mono">#{m.num} {m.uid48}</span>
                  </span>
                  <span className="pj-cmp__spacer" />
                  <Button size="sm" variant="primary" icon={Wrench} disabled={phase !== 'connected'} onClick={() => setReplacing({ project: m })}>
                    {tProject('mm.replace')}
                  </Button>
                  {cands.length === 0 && <span className="pj-muted">{tProject('mm.noCandidate')}</span>}
                </div>
              );
            })}
            {match.extra.map((x) => (
              <div key={x.uid48} className="pj-mm__row">
                <Badge tone="accent" size="sm">{tProject('mm.extra')}</Badge>
                <span>
                  <strong>{x.name.trim() || tl(getModel(x.model)?.name) || `#${x.model}`}</strong> <span className="pj-muted cy-mono">#{x.unresolved ? '—' : x.num} {x.uid48}</span>
                </span>
                <span className="pj-cmp__spacer" />
                <Button size="sm" icon={CopyPlus} disabled={phase !== 'connected' || !x.online} onClick={() => void addExtra(x)}>
                  {tProject('mm.addToProject')}
                </Button>
              </div>
            ))}
          </div>
        </Panel>
      )}
      {replacing && (
        <ReplaceDialog
          project={replacing.project}
          preset={replacing.preset}
          candidates={candidatesFor(replacing.project, match)}
          onClose={() => setReplacing(null)}
        />
      )}
    </div>
  );
}
