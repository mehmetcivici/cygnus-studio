import { useState } from 'react';
import { Play, Waves } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, Tooltip, cx } from '../../ui';
import { useTuner } from './controller';
import { setUi, useTunerUi } from './state';
import { Field } from './TestTab';
import { targetBlock } from './loop';
import { defaultSignal, signalDuration, signalExtent, type SignalConfig } from './signals';
import { tTuner } from './messages';

export function FreqTab() {
  const { fmtValue } = useI18n();
  const api = useTuner();
  const { ctx, config } = api;
  const busy = useTunerUi((s) => s.busy) !== null;
  const lim = config.limits;
  const [s, setS] = useState<SignalConfig>(() => {
    const centre = ctx.integrating ? (lim.rangeMin + lim.rangeMax) / 2 : lim.maxAmplitude * 0.4;
    const amp = ctx.integrating ? (lim.rangeMax - lim.rangeMin) * 0.08 : lim.maxAmplitude * 0.08;
    return { ...defaultSignal('chirp', 0), offset: Number(centre.toFixed(ctx.digits)), amplitude: Number(amp.toPrecision(2)), f0: 0.2, f1: 20, sweep: 15, pre: 1.5, repeats: 1 };
  });
  const [lo, hi] = signalExtent(s);
  const block = targetBlock(ctx, lim, lo) ?? targetBlock(ctx, lim, hi) ?? (signalDuration(s) > lim.maxDuration ? 'duration' : null);
  const run = [...api.runs].reverse().find((r) => r.analysis.bode);
  const mg = run?.analysis.bode?.margins;
  const grade = (v: number, good: number, fair: number) => (!Number.isFinite(v) ? 'good' : v >= good ? 'good' : v >= fair ? 'fair' : 'poor');
  const f = (label: string, k: keyof SignalConfig, unit: string, digits: number, step: number, min?: number) => (
    <Field label={label} value={s[k] as number} unit={unit} digits={digits} step={step} min={min} disabled={busy} onCommit={(v) => setS({ ...s, [k]: v })} />
  );
  return (
    <div className="tuner-panel-stack">
      <section className="tuner-section">
        <header className="tuner-section__head">
          <h3>
            <Waves size={14} aria-hidden /> {tTuner('freq.title')}
          </h3>
          <Tooltip content={api.armed ? tTuner('freq.runHint') : tTuner('needArm')}>
            <span>
              <Button size="sm" icon={Play} disabled={!api.armed || busy || block !== null} onClick={() => void api.runClosed(s)}>
                {tTuner('assist.run')}
              </Button>
            </span>
          </Tooltip>
        </header>
        <p className="tuner-muted">{tTuner('freq.body')}</p>
        <div className="tuner-fields">
          {f(tTuner('gen.offset'), 'offset', ctx.unit, ctx.digits, 10 ** -ctx.digits)}
          {f(tTuner('gen.amplitude'), 'amplitude', ctx.unit, ctx.digits + 1, 10 ** -ctx.digits, 0)}
          {f('f0', 'f0', 'Hz', 2, 0.1, 0.05)}
          {f('f1', 'f1', 'Hz', 1, 1, 0.1)}
          {f(tTuner('gen.sweep'), 'sweep', 's', 1, 1, 2)}
        </div>
        {block && <p className="tuner-hint tuner-hint--danger">{tTuner(`block.${block}`)}</p>}
      </section>
      {run && mg && (
        <section className="tuner-section">
          <header className="tuner-section__head">
            <h3>{tTuner('freq.margins', { n: run.n })}</h3>
            <Button size="sm" variant="ghost" onClick={() => setUi({ view: 'bode', focus: run.id })}>
              {tTuner('freq.show')}
            </Button>
          </header>
          <ul className="tuner-metrics">
            <li className={cx('tuner-metric', `is-${grade(mg.phaseMarginDeg, 45, 30)}`)}>
              <span className="tuner-metric__dot" />
              <span className="tuner-metric__label">{tTuner('freq.pm')}</span>
              <span className="tuner-metric__value cy-mono">{Number.isFinite(mg.phaseMarginDeg) ? fmtValue(mg.phaseMarginDeg, '°', 1) : '—'}</span>
            </li>
            <li className={cx('tuner-metric', `is-${grade(mg.gainMarginDb, 6, 3)}`)}>
              <span className="tuner-metric__dot" />
              <span className="tuner-metric__label">{tTuner('freq.gm')}</span>
              <span className="tuner-metric__value cy-mono">{Number.isFinite(mg.gainMarginDb) ? fmtValue(mg.gainMarginDb, 'dB', 1) : '∞'}</span>
            </li>
            <li className="tuner-metric is-info">
              <span className="tuner-metric__dot" />
              <span className="tuner-metric__label">{tTuner('freq.wc')}</span>
              <span className="tuner-metric__value cy-mono">{fmtValue(mg.gainCrossHz, 'Hz', 2)}</span>
            </li>
            <li className="tuner-metric is-info">
              <span className="tuner-metric__dot" />
              <span className="tuner-metric__label">{tTuner('freq.w180')}</span>
              <span className="tuner-metric__value cy-mono">{fmtValue(mg.phaseCrossHz, 'Hz', 2)}</span>
            </li>
          </ul>
          {!Number.isFinite(mg.gainCrossHz) && <p className="tuner-hint tuner-hint--warn">{tTuner('freq.noCross')}</p>}
          <p className="tuner-muted">{tTuner('freq.note')}</p>
        </section>
      )}
    </div>
  );
}
