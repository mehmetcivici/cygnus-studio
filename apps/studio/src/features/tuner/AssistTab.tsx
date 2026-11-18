import { useMemo, useState, type ReactNode } from 'react';
import { CheckCheck, Copy, Play, Sparkles, TriangleAlert } from 'lucide-react';
import type { GainRole } from '@cygnus/protocol';
import { useI18n } from '../../i18n';
import { Button, SegmentedControl, Select, StaticChart, Tooltip, cx, type StaticSeries } from '../../ui';
import { useTuner } from './controller';
import { setUi, useTunerUi } from './state';
import { Field } from './TestTab';
import {
  availableOutput,
  ffSuggestion,
  latestSlew,
  predictCurve,
  referenceProfile,
  relaySuggestion,
  simcSuggestion,
  type Clamped,
  type PredictedCurve,
} from './suggest';
import { identify, type FitResult, type ProcessModel } from './analysis/model';
import { RELAY_RULES, type RelayRule } from './analysis/relay';
import type { Aggressiveness } from './analysis/tuning';
import type { Gains, TunerRun } from './types';
import { tTuner } from './messages';

const ROLE_SYMBOL: Record<GainRole, string> = { kp: 'Kp', ki: 'Ki', kd: 'Kd', kS: 'kS', kV: 'kV', kA: 'kA', iMax: 'Imax', outMax: 'Omax' };

export function AssistTab() {
  const api = useTuner();
  const hasFf = api.ctx.roles.includes('kV') && api.ctx.openMode !== null;
  return (
    <div className="tuner-panel-stack">
      <p className="tuner-hint">
        <Sparkles size={13} aria-hidden />
        <span>{tTuner('assist.never')}</span>
      </p>
      {hasFf && <FeedforwardSection />}
      <IdentSection index={hasFf ? 2 : 1} />
      {api.ctx.openMode && <RelaySection index={hasFf ? 3 : 2} />}
    </div>
  );
}

function Section({ index, title, children, action }: { index: number; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="tuner-section tuner-assist">
      <header className="tuner-section__head">
        <h3>
          <span className="tuner-step-no">{index}</span>
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function RunButton({ onRun, label }: { onRun: () => void; label: string }) {
  const api = useTuner();
  const busy = useTunerUi((s) => s.busy) !== null;
  return (
    <Tooltip content={api.armed ? label : tTuner('needArm')}>
      <span>
        <Button size="sm" icon={Play} disabled={!api.armed || busy} onClick={onRun}>
          {tTuner('assist.run')}
        </Button>
      </span>
    </Tooltip>
  );
}

function latestOf(runs: readonly TunerRun[], pred: (r: TunerRun) => boolean): TunerRun | undefined {
  for (let i = runs.length - 1; i >= 0; i--) if (pred(runs[i]!)) return runs[i];
  return undefined;
}

function Kv({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="tuner-dl">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className="cy-mono">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function FeedforwardSection() {
  const { fmtNumber } = useI18n();
  const api = useTuner();
  const run = latestOf(api.runs, (r) => r.kind === 'ff' && !!r.analysis.ff);
  const ff = run?.analysis.ff;
  const sug = useMemo(() => (ff ? ffSuggestion(api.ctx, ff) : null), [ff, api.ctx]);
  return (
    <Section index={1} title={tTuner('ff.title')} action={<RunButton onRun={() => void api.runFeedforward()} label={tTuner('ff.runHint')} />}>
      <p className="tuner-muted">{tTuner('ff.body')}</p>
      {ff && (
        <Kv
          items={[
            ['kS', fmtNumber(ff.kS, 4)],
            ['kV', fmtNumber(ff.kV, 6)],
            ['kA', fmtNumber(ff.kA, 6)],
            ['R²', fmtNumber(ff.r2, 4)],
          ]}
        />
      )}
      {ff && ff.r2 < 0.9 && <p className="tuner-hint tuner-hint--warn">{tTuner('ff.lowFit')}</p>}
      {sug && run?.analysis.model && <SuggestionCard sug={sug} model={run.analysis.model.model} source={tTuner('ff.title')} />}
    </Section>
  );
}

function IdentSection({ index }: { index: number }) {
  const { fmtNumber, fmtValue } = useI18n();
  const api = useTuner();
  const aggr = useTunerUi((s) => s.aggressiveness);
  const [fromRun, setFromRun] = useState<{ run: TunerRun; fit: FitResult } | null>(null);
  const kind = api.integrating ? 'integrating' : 'fopdt';
  const run = latestOf(api.runs, (r) => (r.kind === 'ident' || r.kind === 'relay' || r.kind === 'ff') && !!r.analysis.model && r.analysis.model.model.kind === kind);
  const pick = fromRun && fromRun.fit.model.kind === kind && (!run || fromRun.run.createdAt >= run.createdAt) ? fromRun : run ? { run, fit: run.analysis.model! } : null;
  const ref = useMemo(() => referenceProfile(api.runs, api.config.signal, api.driver?.value(api.ctx.idx.measured) ?? 0), [api.runs, api.config.signal, api.driver, api.ctx]);
  const outLim = availableOutput(api.ctx, api.gains, api.runs);
  const sug = useMemo(() => (pick ? simcSuggestion(api.ctx, pick.fit.model, aggr, api.gains, ref, outLim) : null), [pick, aggr, api.ctx, api.gains, ref, outLim]);
  const identifyLast = (): void => {
    const src = latestOf(api.runs, (r) => r.kind === 'closed' || r.kind === 'relay' || r.kind === 'ident');
    if (!src) return;
    const fit = identify(src.data.t, src.data.output, src.data.measured, { kind });
    if (fit) setFromRun({ run: src, fit });
  };
  const m = pick?.fit.model;
  const u = api.ctx.unit;
  const ou = api.ctx.outputUnit;
  return (
    <Section index={index} title={tTuner('id.title')} action={<RunButton onRun={() => void api.runIdent()} label={tTuner(kind === 'fopdt' && api.ctx.openMode ? 'id.runOpen' : 'id.runClosed')} />}>
      <div className="tuner-row">
        <Select<'fopdt' | 'integrating'>
          size="sm"
          width="100%"
          value={kind}
          onChange={(k) => api.setConfig({ integrating: k === 'integrating' })}
          ariaLabel={tTuner('id.type')}
          options={[
            { value: 'fopdt', label: tTuner('id.fopdt') },
            { value: 'integrating', label: tTuner('id.integrating') },
          ]}
        />
        <Button size="sm" variant="ghost" onClick={identifyLast} disabled={!api.runs.some((r) => r.kind === 'closed' || r.kind === 'relay' || r.kind === 'ident')}>
          {tTuner('id.fromLast')}
        </Button>
      </div>
      <p className="tuner-muted">{tTuner(kind === 'fopdt' ? (api.ctx.openMode ? 'id.bodyOpen' : 'id.bodyClosed') : 'id.bodyInt')}</p>
      {m && pick && (
        <>
          <Kv
            items={[
              ['K', `${fmtNumber(m.K, 4)} ${u}${kind === 'integrating' ? '/s' : ''}/${ou || '1'}`],
              ['τ', fmtValue(m.tau, 's', 4)],
              ['θ', fmtValue(m.theta, 's', 4)],
              ['R²', fmtNumber(pick.fit.r2, 4)],
            ]}
          />
          <p className="tuner-muted">{tTuner('id.source', { n: pick.run.n, kind: tTuner(`kind.${pick.run.kind}`) })}</p>
          {pick.fit.r2 < 0.9 && <p className="tuner-hint tuner-hint--warn">{tTuner('id.lowFit')}</p>}
          <SegmentedControl<Aggressiveness>
            size="sm"
            block
            value={aggr}
            onChange={(a) => setUi({ aggressiveness: a })}
            ariaLabel={tTuner('id.aggr')}
            options={[
              { value: 'soft', label: tTuner('id.soft') },
              { value: 'balanced', label: tTuner('id.balanced') },
              { value: 'aggressive', label: tTuner('id.aggressive') },
            ]}
          />
          {sug && <SuggestionCard sug={sug} model={m} source={`SIMC · ${tTuner(`id.${aggr}`)}`} />}
        </>
      )}
    </Section>
  );
}

function RelaySection({ index }: { index: number }) {
  const { fmtNumber, fmtValue } = useI18n();
  const api = useTuner();
  const rule = useTunerUi((s) => s.relayRule);
  const { ctx, config } = api;
  // Hysteresis a few noise σ wide keeps the relay from chattering: take the noise of the last
  // step run (measured at speed), else the spread of the live measurement.
  const noise = useMemo(() => {
    for (let i = api.runs.length - 1; i >= 0; i--) {
      const n = api.runs[i]!.analysis.steps[0]?.noiseRms;
      if (n !== undefined && Number.isFinite(n) && n > 0) return 3 * n;
    }
    const b = api.driver?.live[ctx.idx.measured];
    if (!b || b.length < 50) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, b.length - 200); i < b.length; i++) {
      const v = b.valueAt(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
    // Recomputed when the run list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.driver, api.runs.length]);
  // Oscillate where the step test works: the middle of its A → B span.
  const defaultCentre = ctx.integrating ? (config.signal.from + config.signal.to) / 2 : config.limits.maxAmplitude * 0.4;
  const [o, setO] = useState(() => ({
    amplitude: Math.min(config.limits.maxOpen, 0.15),
    hysteresis: Number(Math.max(noise, 10 ** -(ctx.digits + 1)).toPrecision(2)),
    cycles: 6,
    centre: Number(defaultCentre.toFixed(ctx.digits)),
  }));
  const run = latestOf(api.runs, (r) => r.kind === 'relay' && !!r.analysis.relay);
  const rr = run?.analysis.relay;
  const sug = useMemo(() => (rr ? relaySuggestion(ctx, rr.ku, rr.tu, rule) : null), [rr, ctx, rule]);
  const model = run?.analysis.model?.model ?? null;
  const centreBlock =
    ctx.integrating ? o.centre < config.limits.rangeMin || o.centre > config.limits.rangeMax : Math.abs(o.centre) > config.limits.maxAmplitude;
  return (
    <Section
      index={index}
      title={tTuner('relay.title')}
      action={<RunButton onRun={() => !centreBlock && void api.runRelay(o)} label={tTuner('relay.runHint')} />}
    >
      <p className="tuner-muted">{tTuner('relay.body')}</p>
      <div className="tuner-fields">
        <Field label={tTuner('relay.centre')} value={o.centre} unit={ctx.unit} digits={ctx.digits} step={10 ** -ctx.digits} onCommit={(v) => setO({ ...o, centre: v })} />
        <Field label={tTuner('relay.amplitude')} value={o.amplitude} digits={3} min={0.01} max={config.limits.maxOpen} step={0.01} onCommit={(v) => setO({ ...o, amplitude: v })} hint={tTuner('relay.amplitudeHint')} />
        <Field label={tTuner('relay.hysteresis')} value={o.hysteresis} unit={ctx.unit} digits={ctx.digits + 2} min={0} step={10 ** -(ctx.digits + 1)} onCommit={(v) => setO({ ...o, hysteresis: v })} />
        <Field label={tTuner('relay.cycles')} value={o.cycles} digits={0} min={3} max={20} step={1} onCommit={(v) => setO({ ...o, cycles: Math.round(v) })} />
      </div>
      {centreBlock && <p className="tuner-hint tuner-hint--danger">{tTuner('block.range')}</p>}
      {rr && (
        <>
          <Kv
            items={[
              ['Ku', fmtNumber(rr.ku, 4)],
              ['Tu', fmtValue(rr.tu, 's', 3)],
              ['a', fmtValue(rr.a, ctx.unit, ctx.digits + 2)],
              [tTuner('relay.spread'), fmtValue(rr.spread * 100, '%', 1)],
            ]}
          />
          <table className="tuner-table tuner-table--rules">
            <thead>
              <tr>
                <th>{tTuner('relay.rule')}</th>
                <th>Kp</th>
                <th>Ki</th>
                {ctx.roles.includes('kd') && <th>Kd</th>}
              </tr>
            </thead>
            <tbody>
              {RELAY_RULES.map((r) => {
                const g = relaySuggestion(ctx, rr.ku, rr.tu, r).gains;
                return (
                  <tr key={r} className={cx(r === rule && 'is-selected')} onClick={() => setUi({ relayRule: r })} aria-selected={r === rule}>
                    <td>{tTuner(`relay.r.${r}`)}</td>
                    <td className="cy-mono">{fmtNumber(g.kp ?? 0, 4, { grouping: false })}</td>
                    <td className="cy-mono">{fmtNumber(g.ki ?? 0, 4, { grouping: false })}</td>
                    {ctx.roles.includes('kd') && <td className="cy-mono">{fmtNumber(g.kd ?? 0, 4, { grouping: false })}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rr.spread > 0.15 && <p className="tuner-hint tuner-hint--warn">{tTuner('relay.irregular')}</p>}
          {sug && model && <SuggestionCard sug={sug} model={model} source={tTuner(`relay.r.${rule as RelayRule}`)} />}
          {sug && !model && <SuggestionCard sug={sug} model={null} source={tTuner(`relay.r.${rule as RelayRule}`)} />}
        </>
      )}
    </Section>
  );
}

/** Suggested gains next to the current ones, the predicted response, and apply buttons. */
function SuggestionCard({ sug, model, source }: { sug: Clamped; model: ProcessModel | null; source: string }) {
  const { fmtNumber, fmtValue } = useI18n();
  const api = useTuner();
  const busy = useTunerUi((s) => s.busy) !== null;
  const ref = useMemo(() => referenceProfile(api.runs, api.config.signal, api.driver?.value(api.ctx.idx.measured) ?? 0), [api.runs, api.config.signal, api.driver, api.ctx]);
  const outLim = availableOutput(api.ctx, api.gains, api.runs);
  const slew = latestSlew(api.runs);
  const next: Gains = { ...api.gains, ...sug.gains };
  const curves = useMemo(() => {
    if (!model) return null;
    return {
      cur: predictCurve(model, api.gains, ref, { outputLimit: outLim, slew }),
      next: predictCurve(model, next, ref, { outputLimit: outLim, slew }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, api.gains, sug, ref, outLim, slew]);
  const series = useMemo<StaticSeries[]>(() => {
    if (!curves) return [];
    const s: StaticSeries[] = [];
    const tt = Array.from(curves.next.prediction.t);
    s.push({ key: 'r', label: tTuner('sig.target'), x: tt, y: Array.from(curves.next.prediction.target), color: 'var(--cy-text-3)', dash: [5, 4], width: 1, unit: api.ctx.unit });
    if (ref.measured) s.push({ key: 'm', label: tTuner('assist.measured', { n: ref.run?.n ?? 0 }), x: ref.t, y: ref.measured, color: 'var(--cy-text-2)', width: 1.2, unit: api.ctx.unit });
    s.push({ key: 'c', label: tTuner('assist.predCurrent'), x: tt, y: Array.from(curves.cur.prediction.y), color: 'chart-5', dash: [3, 3], unit: api.ctx.unit });
    s.push({ key: 's', label: tTuner('assist.predSuggested'), x: tt, y: Array.from(curves.next.prediction.y), color: 'chart-2', width: 2, unit: api.ctx.unit });
    return s;
  }, [curves, ref, api.ctx.unit]);
  const roles = Object.keys(sug.gains) as GainRole[];
  // Boards store f32: compare with a relative tolerance.
  const same = roles.every((r) => {
    const a = api.gains[r];
    const b = sug.gains[r];
    return a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-5 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
  });
  const os = (c: PredictedCurve): string =>
    c.metrics ? `${fmtValue(c.metrics.overshoot, '%', 1)} · ${Number.isNaN(c.metrics.settlingTime) ? tTuner('metrics.notSettled') : fmtValue(c.metrics.settlingTime, 's', 2)}` : '—';
  return (
    <div className="tuner-sug">
      <div className="tuner-sug__head">
        <span className="tuner-sug__title">{tTuner('assist.suggestion')}</span>
        <span className="tuner-muted">{source}</span>
      </div>
      <table className="tuner-table tuner-table--sug">
        <thead>
          <tr>
            <th />
            <th>{tTuner('assist.now')}</th>
            <th>{tTuner('assist.new')}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r}>
              <td>{ROLE_SYMBOL[r]}</td>
              <td className="cy-mono">{fmtNumber(api.gains[r] ?? NaN, 6, { grouping: false })}</td>
              <td className={cx('cy-mono', sug.clamped.includes(r) && 'is-clamped')}>
                {fmtNumber(sug.gains[r] ?? NaN, 6, { grouping: false })}
                {sug.clamped.includes(r) && <TriangleAlert size={11} aria-label={tTuner('assist.clamped')} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sug.clamped.length > 0 && <p className="tuner-hint tuner-hint--warn">{tTuner('assist.clamped')}</p>}
      {curves ? (
        <>
          <div className="tuner-sug__chart">
            <StaticChart series={series} legend="bottom" toolbar={false} height={190} />
          </div>
          <div className="tuner-sug__pred">
            <span>
              {tTuner('assist.predCurrent')}: <b className="cy-mono">{os(curves.cur)}</b>
            </span>
            <span>
              {tTuner('assist.predSuggested')}: <b className="cy-mono">{os(curves.next)}</b>
            </span>
          </div>
          <p className="tuner-muted">{tTuner('assist.predNote')}</p>
        </>
      ) : (
        <p className="tuner-muted">{tTuner('assist.noModel')}</p>
      )}
      <div className="tuner-actions">
        <Button size="sm" variant="primary" icon={CheckCheck} disabled={busy || same || !api.view.online} onClick={() => void api.writeGains(sug.gains)}>
          {same ? tTuner('assist.applied') : tTuner('assist.apply')}
        </Button>
        <Tooltip content={tTuner('assist.toBHint')}>
          <span>
            <Button size="sm" icon={Copy} disabled={busy} onClick={() => api.storeInSet(api.sets.active === 'A' ? 'B' : 'A', sug.gains)}>
              {tTuner('assist.toB', { set: api.sets.active === 'A' ? 'B' : 'A' })}
            </Button>
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
