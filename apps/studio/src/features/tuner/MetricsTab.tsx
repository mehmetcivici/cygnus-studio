import { useState } from 'react';
import { CircleHelp, History, Lightbulb } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Button, EmptyState, SegmentedControl, Tooltip, cx } from '../../ui';
import { useTuner } from './controller';
import { useTunerUi } from './state';
import { gradeStep, type Grade, type MetricKey, type StepMetrics } from './analysis/step';
import { updateRun } from './project';
import type { TunerRun } from './types';
import { runLabelKey } from './runs';
import { tTuner } from './messages';

const ORDER: MetricKey[] = ['riseTime', 'peakTime', 'overshoot', 'settlingTime', 'steadyError', 'iae', 'itae', 'damping', 'saturation', 'noiseRms'];

/** Run whose metrics the panel shows: the focused one, else the newest step run of the loop. */
export function useFocusRun(): TunerRun | undefined {
  const api = useTuner();
  const focus = useTunerUi((s) => s.focus);
  return api.runs.find((r) => r.id === focus) ?? [...api.runs].reverse().find((r) => r.analysis.steps.length > 0);
}

export function MetricsTab() {
  const { fmtValue, fmtNumber, lang } = useI18n();
  const api = useTuner();
  const run = useFocusRun();
  const [stepIdx, setStepIdx] = useState(0);
  if (!run) return <EmptyState icon={History} title={tTuner('metrics.emptyTitle')} description={tTuner('metrics.emptyBody')} size="sm" />;
  const steps = run.analysis.steps;
  const m: StepMetrics | undefined = steps[Math.min(stepIdx, steps.length - 1)];
  const hasKi = (run.gains.ki ?? 0) > 0;
  const hasFf = (run.gains.kV ?? 0) > 0;
  const graded = m ? gradeStep(m, { hasKi, hasFf }) : null;
  const unit = run.unit;
  const digits = api.ctx.digits;
  // A residual inside the loop's own "allowed error" parameter is by design, not a tuning fault.
  const tolKey = (api.ctx.loop.extraParams ?? []).find((k) => /tolerance/.test(k));
  const tips = graded?.tips ?? [];
  const show = (k: MetricKey): string => {
    if (!m) return '—';
    switch (k) {
      case 'riseTime':
      case 'peakTime':
        return fmtValue(m[k], 's', 3);
      case 'settlingTime':
        return Number.isNaN(m.settlingTime) ? tTuner('metrics.notSettled') : fmtValue(m.settlingTime, 's', 3);
      case 'overshoot':
      case 'saturation':
        return fmtValue(m[k], '%', 1);
      case 'steadyError':
        return `${fmtValue(m.steadyError, unit, digits + 1)} · ${fmtValue(m.steadyErrorPct, '%', 1)}`;
      case 'iae':
        return fmtNumber(m.iae, 4);
      case 'itae':
        return fmtNumber(m.itae, 4);
      case 'damping':
        return Number.isFinite(m.damping) ? fmtNumber(m.damping, 2) : '—';
      case 'noiseRms':
        return fmtValue(m.noiseRms, unit, digits + 1);
    }
  };
  const date = new Date(run.createdAt).toLocaleTimeString(lang === 'tr' ? 'tr-TR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <div className="tuner-panel-stack">
      <section className="tuner-section">
        <header className="tuner-section__head">
          <h3>
            #{run.n} · {tTuner(runLabelKey(run))}
            {run.gainSet ? <span className="tuner-set">{run.gainSet}</span> : null}
          </h3>
          <span className="tuner-muted cy-mono">{date}</span>
        </header>
        {steps.length > 1 && (
          <SegmentedControl<number>
            size="sm"
            value={Math.min(stepIdx, steps.length - 1)}
            onChange={setStepIdx}
            ariaLabel={tTuner('metrics.step')}
            options={steps.slice(0, 6).map((s, i) => ({ value: i, label: `${i + 1}: ${fmtNumber(s.from, digits)}→${fmtNumber(s.to, digits)}` }))}
          />
        )}
        {m ? (
          <ul className="tuner-metrics">
            {ORDER.map((k) => {
              const g: Grade = graded?.grades.find((x) => x.key === k)?.grade ?? 'info';
              return (
                <li key={k} className={cx('tuner-metric', `is-${g}`)}>
                  <span className="tuner-metric__dot" aria-label={tTuner(`grade.${g}`)} />
                  <span className="tuner-metric__label">
                    {tTuner(`m.${k}`)}
                    <Tooltip content={tTuner(`mh.${k}`)}>
                      <CircleHelp size={12} className="tuner-metric__help" aria-label={tTuner(`mh.${k}`)} />
                    </Tooltip>
                  </span>
                  <span className="tuner-metric__value cy-mono">{show(k)}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="tuner-muted">{tTuner('metrics.noSteps')}</p>
        )}
      </section>
      {m && (
        <section className="tuner-section tuner-tips">
          <header className="tuner-section__head">
            <h3>
              <Lightbulb size={14} aria-hidden /> {tTuner('metrics.tips')}
            </h3>
          </header>
          <ul>
            {tips.map((tip) => (
              <li key={tip} className={cx(tip === 'good' && 'is-good')}>
                {tip === 'steadyError' && tolKey ? tTuner('tip.steadyErrorTol', { param: tolKey }) : tTuner(`tip.${tip}`)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="tuner-section">
        <header className="tuner-section__head">
          <h3>{tTuner('metrics.gains')}</h3>
          <Button size="sm" onClick={() => void api.writeGains(run.gains)} disabled={!api.view.online}>
            {tTuner('metrics.restore')}
          </Button>
        </header>
        <div className="tuner-kv cy-mono">
          {api.ctx.roles.map((r) => (
            <span key={r}>
              {r} = {fmtNumber(run.gains[r] ?? NaN, 6, { grouping: false })}
            </span>
          ))}
        </div>
        <label className="tuner-note">
          <span className="tuner-field__label">{tTuner('metrics.note')}</span>
          <textarea value={run.note} rows={2} placeholder={tTuner('metrics.notePh')} onChange={(e) => updateRun(run.id, { note: e.target.value })} />
        </label>
      </section>
    </div>
  );
}
