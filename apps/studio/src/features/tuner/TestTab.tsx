import { useEffect, useMemo, useState } from 'react';
import { GitCompareArrows, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Kbd, NumberField, Select, Slider, Sparkline, cx } from '../../ui';
import { useTuner } from './controller';
import { targetBlock } from './loop';
import { SIGNAL_KINDS, sampleSignal, signalDuration, type SignalConfig, type SignalKind } from './signals';
import { useTunerUi } from './state';
import { tTuner } from './messages';

/** Labeled compact number input used throughout the side panels. */
export function Field({
  label,
  value,
  onCommit,
  unit,
  min,
  max,
  step,
  digits,
  disabled,
  hint,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  digits?: number;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="tuner-field" title={hint}>
      <span className="tuner-field__label">{label}</span>
      <NumberField value={value} onCommit={onCommit} unit={unit} min={min} max={max} step={step} digits={digits} size="sm" width="100%" disabled={disabled} ariaLabel={label} />
    </label>
  );
}

export function TestTab() {
  const api = useTuner();
  const { ctx, config } = api;
  const s = config.signal;
  const busy = useTunerUi((x) => x.busy) !== null;
  const unit = ctx.unit;
  const d = ctx.digits;
  const stepT = 10 ** -d;
  const set = (patch: Partial<SignalConfig>) => api.setSignal(patch);
  const preview = useMemo(() => sampleSignal(s, 120).v, [s]);
  const T = signalDuration(s);
  const { fmtValue } = useI18n();
  const f = (label: string, k: keyof SignalConfig, u = unit, extra: { min?: number; max?: number; step?: number; digits?: number } = {}) => (
    <Field
      label={label}
      value={s[k] as number}
      unit={u}
      onCommit={(v) => set({ [k]: v } as Partial<SignalConfig>)}
      step={extra.step ?? stepT}
      digits={extra.digits ?? d}
      min={extra.min}
      max={extra.max}
      disabled={busy}
    />
  );
  return (
    <div className="tuner-panel-stack">
      <section className="tuner-section">
        <header className="tuner-section__head">
          <h3>{tTuner('gen.title')}</h3>
          <Select<SignalKind>
            size="sm"
            width={150}
            value={s.kind}
            disabled={busy}
            onChange={(k) => set({ kind: k })}
            ariaLabel={tTuner('gen.kind')}
            options={SIGNAL_KINDS.map((k) => ({ value: k, label: tTuner(`gen.k.${k}`) }))}
          />
        </header>
        <p className="tuner-muted">{tTuner(`gen.d.${s.kind}`)}</p>
        {s.kind === 'manual' ? (
          <ManualControl />
        ) : (
          <>
            <div className="tuner-fields">
              {(s.kind === 'step' || s.kind === 'trapezoid') && (
                <>
                  {f(tTuner('gen.from'), 'from')}
                  {f(tTuner('gen.to'), 'to')}
                </>
              )}
              {(s.kind === 'square' || s.kind === 'sine' || s.kind === 'chirp') && (
                <>
                  {f(tTuner('gen.offset'), 'offset')}
                  {f(tTuner('gen.amplitude'), 'amplitude', unit, { min: 0 })}
                </>
              )}
              {s.kind === 'square' && f(tTuner('gen.period'), 'period', 's', { min: 0.02, step: 0.1, digits: 2 })}
              {s.kind === 'sine' && f(tTuner('gen.freq'), 'freq', 'Hz', { min: 0.01, max: 100, step: 0.1, digits: 2 })}
              {s.kind === 'trapezoid' && f(tTuner('gen.ramp'), 'ramp', 's', { min: 0.01, step: 0.1, digits: 2 })}
              {(s.kind === 'step' || s.kind === 'trapezoid') && f(tTuner('gen.hold'), 'hold', 's', { min: 0.05, step: 0.1, digits: 2 })}
              {s.kind === 'chirp' && (
                <>
                  {f('f0', 'f0', 'Hz', { min: 0.01, step: 0.1, digits: 2 })}
                  {f('f1', 'f1', 'Hz', { min: 0.02, max: 200, step: 1, digits: 1 })}
                  {f(tTuner('gen.sweep'), 'sweep', 's', { min: 1, step: 1, digits: 1 })}
                </>
              )}
              {f(tTuner('gen.pre'), 'pre', 's', { min: 0, step: 0.1, digits: 2 })}
              {f(tTuner('gen.repeats'), 'repeats', '', { min: 1, max: 50, step: 1, digits: 0 })}
            </div>
            <div className="tuner-preview">
              <Sparkline values={preview} height={34} />
              <span className="cy-mono">{fmtValue(T, 's', 1)}</span>
            </div>
            {api.signalBlock && <p className="tuner-hint tuner-hint--danger">{tTuner(`block.${api.signalBlock}`)}</p>}
            <div className="tuner-actions">
              <Button size="sm" icon={GitCompareArrows} disabled={!api.armed || busy || api.signalBlock !== null} onClick={() => void api.runAB()}>
                {tTuner('test.runAB')}
              </Button>
              <span className="tuner-muted">
                <Kbd>Enter</Kbd> {tTuner('test.enter')}
              </span>
            </div>
          </>
        )}
      </section>
      <LimitsSection />
    </div>
  );
}

function ManualControl() {
  const { fmtValue } = useI18n();
  const api = useTuner();
  const { ctx, config } = api;
  const lim = config.limits;
  const lo = ctx.integrating ? lim.rangeMin : -lim.maxAmplitude;
  const hi = ctx.integrating ? lim.rangeMax : lim.maxAmplitude;
  const [v, setV] = useState(() => (ctx.integrating ? (api.driver?.value(ctx.idx.measured) ?? 0) : 0));
  const step = (hi - lo) / 200;
  useEffect(() => {
    if (api.armed) api.setHold(v);
    // Only push when the user moves the control or arms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, api.armed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'slider')) return;
      e.preventDefault();
      setV((x) => {
        const n = Number((x + (e.key === 'ArrowUp' ? step : -step)).toFixed(6));
        return targetBlock(ctx, lim, n) ? x : n;
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, ctx, lim]);
  return (
    <div className="tuner-manual">
      <Slider value={v} min={lo} max={hi} step={step} onChange={setV} bipolar={lo < 0 && hi > 0} disabled={!api.armed} ariaLabel={tTuner('gen.k.manual')} />
      <div className="tuner-manual__row">
        <NumberField
          value={v}
          onCommit={(n) => !targetBlock(ctx, lim, n) && setV(n)}
          unit={ctx.unit}
          min={lo}
          max={hi}
          step={step}
          digits={ctx.digits}
          size="sm"
          width={150}
          disabled={!api.armed}
          ariaLabel={tTuner('sig.target')}
        />
        <span className="tuner-muted">
          <Kbd>↑</Kbd>/<Kbd>↓</Kbd> {fmtValue(step, ctx.unit, ctx.digits + 1)}
        </span>
      </div>
      {!api.armed && <p className="tuner-hint">{tTuner('needArm')}</p>}
    </div>
  );
}

function LimitsSection() {
  const api = useTuner();
  const { ctx, config } = api;
  const lim = config.limits;
  const busy = useTunerUi((x) => x.busy) !== null;
  const d = ctx.digits;
  return (
    <section className={cx('tuner-section', 'tuner-section--limits')}>
      <header className="tuner-section__head">
        <h3>
          <ShieldCheck size={14} aria-hidden /> {tTuner('lim.title')}
        </h3>
      </header>
      <div className="tuner-fields">
        {ctx.integrating ? (
          <>
            <Field label={tTuner('lim.rangeMin')} value={lim.rangeMin} unit={ctx.unit} digits={d} step={10 ** -d} disabled={busy} onCommit={(v) => api.setLimits({ rangeMin: Math.min(v, lim.rangeMax) })} />
            <Field label={tTuner('lim.rangeMax')} value={lim.rangeMax} unit={ctx.unit} digits={d} step={10 ** -d} disabled={busy} onCommit={(v) => api.setLimits({ rangeMax: Math.max(v, lim.rangeMin) })} />
          </>
        ) : (
          <Field
            label={tTuner('lim.amplitude')}
            value={lim.maxAmplitude}
            unit={ctx.unit}
            digits={d}
            min={0}
            max={Math.max(Math.abs(ctx.modeMin), Math.abs(ctx.modeMax))}
            disabled={busy}
            onCommit={(v) => api.setLimits({ maxAmplitude: v })}
          />
        )}
        <Field label={tTuner('lim.duration')} value={lim.maxDuration} unit="s" digits={0} min={1} max={120} step={1} disabled={busy} onCommit={(v) => api.setLimits({ maxDuration: v })} />
        {ctx.openMode && (
          <Field
            label={tTuner('lim.open')}
            value={lim.maxOpen}
            digits={2}
            min={0}
            max={ctx.openMode.max}
            step={0.05}
            disabled={busy}
            hint={tTuner('lim.openHint')}
            onCommit={(v) => api.setLimits({ maxOpen: v })}
          />
        )}
      </div>
      <p className="tuner-muted">{tTuner(ctx.integrating ? 'lim.noteRange' : 'lim.noteAmp')}</p>
    </section>
  );
}
