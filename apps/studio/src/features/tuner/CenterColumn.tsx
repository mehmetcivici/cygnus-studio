import { useEffect, useMemo, useState } from 'react';
import { Activity, ChartLine, GitCompareArrows, OctagonAlert, Square, Star, Unplug, Waves } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, EmptyState, LiveChart, ProgressBar, SegmentedControl, StaticChart, chartColor, cx, resolveColor, useTheme, type ChartGuide, type ChartMarker, type LiveSeries, type StaticSeries } from '../../ui';
import { FaultList, useDrive } from '../../core';
import { useTuner } from './controller';
import { setUi, useTunerUi, type CenterView } from './state';
import { headline } from './runs';
import { TIME_METRICS, reachedTarget, stepScore, type MetricKey, type StepMetrics } from './analysis/step';
import type { TunerRun } from './types';
import { tTuner } from './messages';

export function CenterColumn() {
  const api = useTuner();
  const view = useTunerUi((s) => s.view);
  const hasBode = api.runs.some((r) => r.analysis.bode);
  return (
    <div className="tuner__center">
      <ProblemBanner />
      <div className="tuner-center__bar">
        <SegmentedControl<CenterView>
          size="sm"
          value={view}
          onChange={(v) => setUi({ view: v })}
          ariaLabel={tTuner('center.view')}
          options={[
            { value: 'live', label: tTuner('center.live'), icon: Activity },
            { value: 'compare', label: tTuner('center.compare'), icon: GitCompareArrows },
            { value: 'bode', label: tTuner('center.bode'), icon: Waves, disabled: !hasBode },
          ]}
        />
        <TestProgress />
        <StreamInfo />
      </div>
      {view === 'live' && <LiveView />}
      {view === 'compare' && <CompareView />}
      {view === 'bode' && <BodeView />}
    </div>
  );
}

function StreamInfo() {
  const { fmtNumber } = useI18n();
  const api = useTuner();
  const [, tick] = useState(0);
  useEffect(() => {
    const h = window.setInterval(() => tick((x) => x + 1), 1000);
    return () => window.clearInterval(h);
  }, []);
  const d = api.driver;
  if (api.streamError) return <span className="tuner-stream is-error">{api.streamError}</span>;
  if (!d || !d.streaming) return <span className="tuner-stream">{tTuner('center.noStream')}</span>;
  return (
    <span className="tuner-stream cy-mono" title={tTuner('center.streamHint')}>
      {fmtNumber(1e6 / d.periodUs, 0)} Hz · {tTuner('center.lost', { n: d.lost })}
    </span>
  );
}

function TestProgress() {
  const { fmtNumber } = useI18n();
  const api = useTuner();
  const busy = useTunerUi((s) => s.busy);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!busy) return;
    let raf = 0;
    const f = (): void => {
      setNow(performance.now());
      raf = window.setTimeout(f, 100) as unknown as number;
    };
    f();
    return () => window.clearTimeout(raf);
  }, [busy]);
  if (!busy) return <span className="tuner-center__spacer" />;
  const el = (now - busy.startedAt) / 1000;
  return (
    <div className="tuner-progress">
      <span className="tuner-progress__label">{tTuner(`kind.${busy.kind}`)}</span>
      <ProgressBar value={Math.min(1, el / Math.max(0.1, busy.duration))} size="sm" />
      <span className="cy-mono tuner-progress__time">
        {fmtNumber(el, 1)} / {fmtNumber(busy.duration, 1)} s
      </span>
      <Button size="sm" variant="danger" icon={Square} onClick={api.stopTest}>
        {tTuner('test.stop')}
      </Button>
    </div>
  );
}

function ProblemBanner() {
  const api = useTuner();
  const latched = useDrive((s) => s.estopLatched);
  if (api.problem === null && !latched && !api.busyOwner) return null;
  if (api.problem === 'offline')
    return (
      <div className="tuner-problem is-danger" role="alert">
        <Unplug size={16} aria-hidden />
        <div>
          <strong>{tTuner('problem.offline')}</strong>
          <span>{tTuner('problem.offlineBody')}</span>
        </div>
      </div>
    );
  if (api.problem === 'estop' || latched)
    return (
      <div className="tuner-problem is-danger" role="alert">
        <OctagonAlert size={16} aria-hidden />
        <div>
          <strong>{tTuner('problem.estop')}</strong>
          <span>{tTuner('problem.estopBody')}</span>
        </div>
      </div>
    );
  if (api.problem === 'fault')
    return (
      <div className="tuner-problem is-warn" role="alert">
        <OctagonAlert size={16} aria-hidden />
        <div>
          <strong>{tTuner('problem.fault')}</strong>
          <FaultList device={api.view} clearable compact />
        </div>
      </div>
    );
  return (
    <div className="tuner-problem is-info" role="status">
      <OctagonAlert size={16} aria-hidden />
      <div>
        <strong>{tTuner('problem.busy')}</strong>
        <span>{tTuner('problem.busyBody', { owner: api.busyOwner ?? '' })}</span>
      </div>
    </div>
  );
}

function LiveView() {
  const { tl } = useI18n();
  const api = useTuner();
  const { driver, ctx } = api;
  const [paused, setPaused] = useState(false);
  const def = ctx.def;
  const label = (key: string | undefined): string => tl(def.signals.find((s) => s.key === key)?.label) || (key ?? '');
  const top = useMemo<LiveSeries[]>(() => {
    if (!driver) return [];
    const I = ctx.idx;
    return [
      { key: 'target', label: tTuner('sig.target'), unit: ctx.unit, buffer: driver.live[I.target]!, color: 'var(--cy-text-3)', dash: [6, 4], digits: ctx.digits },
      { key: 'measured', label: label(ctx.loop.signals.measured), unit: ctx.unit, buffer: driver.live[I.measured]!, color: 'chart-1', width: 1.8, digits: ctx.digits },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, ctx]);
  const bottom = useMemo<LiveSeries[]>(() => {
    if (!driver) return [];
    const I = ctx.idx;
    const s: LiveSeries[] = [{ key: 'output', label: tTuner('sig.output'), unit: ctx.outputUnit, buffer: driver.live[I.output]!, color: 'chart-3' }];
    if (I.current >= 0 && I.current !== I.measured && I.current !== I.output)
      s.push({ key: 'current', label: label(ctx.currentKey), unit: ctx.currentUnit, buffer: driver.live[I.current]!, color: 'chart-4', axis: 'right' });
    if (I.error >= 0) s.push({ key: 'error', label: tTuner('sig.error'), unit: ctx.unit, buffer: driver.live[I.error]!, color: 'chart-5', axis: 'right', visible: false, digits: ctx.digits });
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver, ctx]);
  if (!driver) return <EmptyState icon={ChartLine} title={tTuner('center.noStream')} description={api.streamError ?? tTuner('center.noStreamBody')} size="sm" />;
  return (
    <div className="tuner-charts">
      <div className="tuner-chart tuner-chart--main">
        <LiveChart series={top} window={10} legend="bottom" paused={paused} onPausedChange={setPaused} title={tTuner('center.topTitle')} />
      </div>
      <div className="tuner-chart">
        <LiveChart series={bottom} window={10} legend="bottom" paused={paused} onPausedChange={setPaused} title={tTuner('center.bottomTitle')} />
      </div>
    </div>
  );
}

/** Short number for dense tables: 4 significant digits, no grouping. */
function compact(v: number | undefined, fmt: (v: number, d: number, o?: { grouping?: boolean }) => string): string {
  if (v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  const d = Math.max(0, Math.min(8, 3 - Math.floor(Math.log10(Math.abs(v)))));
  return fmt(v, d, { grouping: false });
}

type SortKey = 'n' | 'riseTime' | 'overshoot' | 'settlingTime' | 'steadyErrorPct' | 'iae' | 'damping' | 'saturation' | 'score';

/** Lowest score among runs with step metrics. */
export function bestRun(runs: readonly TunerRun[]): string | null {
  let best: string | null = null;
  let bs = Infinity;
  for (const r of runs) {
    const m = headline(r);
    if (!m) continue;
    const s = stepScore(m);
    if (s < bs) {
      bs = s;
      best = r.id;
    }
  }
  return best;
}

function CompareView() {
  const { fmtNumber, fmtValue } = useI18n();
  const api = useTuner();
  const selectedIds = useTunerUi((s) => s.selected);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'n', dir: 1 });
  const theme = useTheme((s) => s.theme);
  void theme;
  const selected = useMemo(() => api.runs.filter((r) => selectedIds.includes(r.id)), [api.runs, selectedIds]);
  const closed = selected.filter((r) => r.data.t.length > 0);
  const series = useMemo<StaticSeries[]>(() => {
    const out: StaticSeries[] = [];
    closed.forEach((r, i) => {
      const c = chartColor(i);
      out.push({ key: `y${r.id}`, label: `#${r.n}${r.gainSet ? ` (${r.gainSet})` : ''}`, unit: r.unit, x: r.data.t, y: r.data.measured, color: c, width: 1.8, digits: api.ctx.digits });
      out.push({ key: `r${r.id}`, label: `#${r.n} ${tTuner('sig.targetShort')}`, unit: r.unit, x: r.data.t, y: r.data.target, color: c, dash: [5, 4], width: 1, digits: api.ctx.digits });
    });
    return out;
  }, [closed, api.ctx.digits]);
  const outSeries = useMemo<StaticSeries[]>(
    () => closed.map((r, i) => ({ key: `u${r.id}`, label: `#${r.n}`, unit: r.outputUnit, x: r.data.t, y: r.data.output, color: chartColor(i) })),
    [closed],
  );
  const stepRuns = selected.filter((r) => headline(r));
  const best = bestRun(stepRuns);
  const rows = useMemo(() => {
    const val = (r: TunerRun, k: SortKey): number => {
      if (k === 'n') return r.n;
      const m = headline(r);
      if (!m) return NaN;
      if (k === 'score') return stepScore(m);
      return m[k];
    };
    return [...stepRuns].sort((a, b) => {
      const va = val(a, sort.key);
      const vb = val(b, sort.key);
      const na = Number.isNaN(va);
      const nb = Number.isNaN(vb);
      if (na !== nb) return na ? 1 : -1;
      return (va - vb) * sort.dir;
    });
  }, [stepRuns, sort]);
  if (!selected.length)
    return <EmptyState icon={GitCompareArrows} title={tTuner('compare.emptyTitle')} description={tTuner('compare.emptyBody')} size="sm" />;
  const head = (k: SortKey, label: string, title?: string) => (
    <th title={title}>
      <button type="button" className={cx('tuner-sort', sort.key === k && 'is-active')} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}
        {sort.key === k ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
  const cell = (m: StepMetrics | null, k: keyof StepMetrics, unit: string, d: number) => (
    <td className="cy-mono">{m && (reachedTarget(m) || !TIME_METRICS.includes(k as MetricKey)) ? fmtValue(m[k] as number, unit, d) : '—'}</td>
  );
  const pidRoles = api.ctx.roles.filter((role) => role === 'kp' || role === 'ki' || role === 'kd');
  const g = (r: TunerRun) => pidRoles.map((role) => compact(r.gains[role], fmtNumber)).join(' / ');
  return (
    <div className="tuner-charts">
      <div className="tuner-chart tuner-chart--main">
        <StaticChart series={series} legend="bottom" title={tTuner('compare.title', { n: closed.length })} />
      </div>
      <div className="tuner-compare-bottom">
        <div className="tuner-chart tuner-chart--small">
          <StaticChart series={outSeries} legend="none" title={tTuner('sig.output')} />
        </div>
        <div className="tuner-table-wrap">
          {rows.length ? (
            <table className="tuner-table">
              <thead>
                <tr>
                  <th aria-label={tTuner('compare.best')} />
                  {head('n', '#')}
                  <th className="tuner-table__gains">{pidRoles.map((r) => r.replace('k', 'K')).join(' / ')}</th>
                  {head('riseTime', 'tr', tTuner('m.riseTime'))}
                  {head('overshoot', tTuner('m.overshootShort'), tTuner('m.overshoot'))}
                  {head('settlingTime', 'ts', tTuner('m.settlingTime'))}
                  {head('steadyErrorPct', 'ess', tTuner('m.steadyError'))}
                  {head('iae', 'IAE', tTuner('m.iae'))}
                  {head('damping', 'ζ', tTuner('m.damping'))}
                  {head('saturation', tTuner('m.saturationShort'), tTuner('m.saturation'))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = headline(r);
                  const i = closed.indexOf(r);
                  return (
                    <tr key={r.id} className={cx(r.id === best && 'is-best')} onClick={() => setUi({ focus: r.id, rightTab: 'metrics' })}>
                      <td>{r.id === best ? <Star size={13} className="tuner-star" aria-label={tTuner('compare.best')} /> : null}</td>
                      <td>
                        <span className="tuner-swatch" style={{ background: resolveColor(chartColor(i)) }} />#{r.n}
                        {r.gainSet ? <span className="tuner-set">{r.gainSet}</span> : null}
                      </td>
                      <td className="cy-mono tuner-table__gains">{g(r)}</td>
                      {cell(m, 'riseTime', 's', 3)}
                      {cell(m, 'overshoot', '%', 1)}
                      {cell(m, 'settlingTime', 's', 3)}
                      {cell(m, 'steadyErrorPct', '%', 2)}
                      {cell(m, 'iae', '', 3)}
                      {cell(m, 'damping', '', 2)}
                      {cell(m, 'saturation', '%', 0)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="tuner-muted">{tTuner('compare.noSteps')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BodeView() {
  const { fmtNumber } = useI18n();
  const api = useTuner();
  const focus = useTunerUi((s) => s.focus);
  const run = api.runs.find((r) => r.id === focus && r.analysis.bode) ?? [...api.runs].reverse().find((r) => r.analysis.bode);
  const b = run?.analysis.bode;
  const charts = useMemo(() => {
    if (!b) return null;
    const mg = b.margins;
    const markers: ChartMarker[] = [
      ...(Number.isFinite(mg.gainCrossHz) ? [{ x: mg.gainCrossHz, color: 'var(--cy-warn)', label: 'ωc', dashed: true }] : []),
      ...(Number.isFinite(mg.phaseCrossHz) ? [{ x: mg.phaseCrossHz, color: 'chart-3', label: 'ω180', dashed: true }] : []),
    ];
    const mag: StaticSeries[] = [
      { key: 'loop', label: tTuner('bode.loop'), x: b.f, y: b.loopDb, color: 'chart-1', unit: 'dB', width: 2, digits: 1 },
      { key: 'closed', label: tTuner('bode.closed'), x: b.f, y: b.closedDb, color: 'chart-2', unit: 'dB', dash: [5, 3], digits: 1 },
      { key: 'plant', label: tTuner('bode.plant'), x: b.f, y: b.plantDb, color: 'chart-3', unit: 'dB', points: true, width: 1, digits: 1 },
    ];
    const ph: StaticSeries[] = [
      { key: 'loop', label: tTuner('bode.loop'), x: b.f, y: b.loopDeg, color: 'chart-1', unit: '°', width: 2, digits: 0 },
      { key: 'closed', label: tTuner('bode.closed'), x: b.f, y: b.closedDeg, color: 'chart-2', unit: '°', dash: [5, 3], digits: 0 },
    ];
    return {
      mag,
      ph,
      markers,
      magGuides: [{ y: 0, color: 'var(--cy-warn)', label: '0 dB' }] as ChartGuide[],
      phGuides: [{ y: -180, color: 'var(--cy-warn)', label: '−180°' }] as ChartGuide[],
    };
  }, [b]);
  if (!run || !b || !charts) return <EmptyState icon={Waves} title={tTuner('bode.emptyTitle')} description={tTuner('bode.emptyBody')} size="sm" />;
  const mg = b.margins;
  const pm = Number.isFinite(mg.phaseMarginDeg) ? `${fmtNumber(mg.phaseMarginDeg, 0)}°` : '—';
  const gm = Number.isFinite(mg.gainMarginDb) ? `${fmtNumber(mg.gainMarginDb, 1)} dB` : '∞';
  return (
    <div className="tuner-bode">
      <div className="tuner-chart tuner-bode__chart">
        <StaticChart
          series={charts.mag}
          xScale="log"
          xUnit="Hz"
          legend="bottom"
          title={`${tTuner('bode.title', { n: run.n })} · PM ${pm} · GM ${gm}`}
          markers={charts.markers}
          guides={charts.magGuides}
        />
      </div>
      <div className="tuner-chart tuner-bode__chart">
        <StaticChart series={charts.ph} xScale="log" xUnit="Hz" legend="bottom" title={tTuner('bode.phase')} markers={charts.markers} guides={charts.phGuides} />
      </div>
    </div>
  );
}
