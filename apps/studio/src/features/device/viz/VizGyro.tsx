import { useId } from 'react';
import { GyroCalStatus, signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, type Tone } from '../../../ui';
import { useSignals } from '../../../core';
import { tDevice } from '../messages';
import { CenterBar, Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const KEYS = ['yaw', 'pitch', 'roll', 'gyro.x', 'gyro.y', 'gyro.z', 'cal.status', 'temp'] as const;
const RATE_SPAN = 500;
const CAL_TONE: Record<number, Tone> = { [GyroCalStatus.NONE]: 'warn', [GyroCalStatus.RUNNING]: 'accent', [GyroCalStatus.DONE]: 'ok', [GyroCalStatus.FAILED_MOTION]: 'danger' };

/** Attitude indicator: the horizon moves with pitch (px per degree) and turns with roll. */
function Horizon({ pitch, roll }: { pitch: number; roll: number }) {
  const clip = useId();
  const p = Number.isFinite(pitch) ? Math.max(-60, Math.min(60, pitch)) : 0;
  const r = Number.isFinite(roll) ? roll : 0;
  const k = 1.6;
  const ladder = [-40, -30, -20, -10, 10, 20, 30, 40];
  return (
    <svg viewBox="0 0 200 200" className="dv-horizon" role="img" aria-label={tDevice('viz.gyro.horizon')}>
      <defs>
        <clipPath id={clip}>
          <circle cx={100} cy={100} r={86} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <g transform={`rotate(${-r} 100 100) translate(0 ${p * k})`}>
          <rect x={-200} y={-400} width={600} height={500} className="dv-horizon__sky" />
          <rect x={-200} y={100} width={600} height={500} className="dv-horizon__ground" />
          <line x1={-200} y1={100} x2={400} y2={100} className="dv-horizon__line" />
          {ladder.map((d) => (
            <g key={d}>
              <line x1={100 - (d % 20 === 0 ? 26 : 14)} x2={100 + (d % 20 === 0 ? 26 : 14)} y1={100 - d * k} y2={100 - d * k} className="dv-horizon__rung" />
              {d % 20 === 0 && (
                <text x={100 + 32} y={100 - d * k + 3.5} className="dv-horizon__num">
                  {Math.abs(d)}
                </text>
              )}
            </g>
          ))}
        </g>
      </g>
      <circle cx={100} cy={100} r={86} className="dv-horizon__rim" />
      <path d="M58 100h26l8 8 8-8 8 8 8-8h26" className="dv-horizon__plane" />
      <circle cx={100} cy={100} r={2.5} className="dv-horizon__dot" />
      <path d="M100 18l-6 10h12z" className="dv-horizon__pointer" transform={`rotate(${-r} 100 100)`} />
    </svg>
  );
}

function Compass({ yaw }: { yaw: number }) {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const ticks = Array.from({ length: 36 }, (_, i) => i * 10);
  const cardinal = tDevice('viz.gyro.cardinal').split(',');
  return (
    <div className="dv-compass">
      <svg viewBox="0 0 200 200" role="img" aria-label={tDevice('viz.gyro.compass')}>
        <circle cx={100} cy={100} r={86} className="dv-dial__face" />
        <g transform={`rotate(${-y} 100 100)`}>
          {ticks.map((a) => (
            <line key={a} x1={100} y1={a % 90 === 0 ? 20 : a % 30 === 0 ? 22 : 24} x2={100} y2={14} transform={`rotate(${a} 100 100)`} className={a % 30 === 0 ? 'dv-dial__tick is-mid' : 'dv-dial__tick'} />
          ))}
          {cardinal.map((c, i) => (
            <text key={c} x={100} y={40} textAnchor="middle" transform={`rotate(${i * 90} 100 100)`} className={i === 0 ? 'dv-compass__card is-north' : 'dv-compass__card'}>
              {c}
            </text>
          ))}
        </g>
        <path d="M100 52l9 48h-18z" className="dv-compass__needle" />
        <path d="M100 148l9-48h-18z" className="dv-compass__tail" />
        <circle cx={100} cy={100} r={5} className="dv-dial__hub is-accent" />
      </svg>
    </div>
  );
}

/** Gyro: attitude indicator (pitch/roll), compass (yaw) and axis rates. */
export function VizGyro({ uid48, def }: VizProps) {
  const { tl } = useI18n();
  const s = useSignals(uid48, KEYS);
  const fmt = useSignalFormat(def);
  const cal = s['cal.status'] ?? NaN;
  const calOpt = signalByKey(def, 'cal.status')?.options?.find((o) => o.value === cal);
  return (
    <div className="dv-viz dv-viz--gyro">
      <VizBlock title={tDevice('viz.gyro.attitude')}>
        <div className="dv-pair">
          <div className="dv-pair__item">
            <Horizon pitch={s.pitch ?? NaN} roll={s.roll ?? NaN} />
            <div className="dv-readouts dv-readouts--center">
              <Readout label={fmt('pitch', NaN).label} text={fmt('pitch', s.pitch ?? NaN).text} unit="°" size="sm" />
              <Readout label={fmt('roll', NaN).label} text={fmt('roll', s.roll ?? NaN).text} unit="°" size="sm" />
            </div>
          </div>
          <div className="dv-pair__item">
            <Compass yaw={s.yaw ?? NaN} />
            <div className="dv-readouts dv-readouts--center">
              <Readout label={fmt('yaw', NaN).label} text={fmt('yaw', s.yaw ?? NaN).text} unit="°" size="sm" />
            </div>
          </div>
        </div>
      </VizBlock>
      <VizBlock
        title={tDevice('viz.gyro.rates')}
        aside={
          <Badge size="sm" tone={CAL_TONE[cal] ?? 'neutral'}>
            {calOpt ? tl(calOpt.label) : '—'}
          </Badge>
        }
      >
        <div className="dv-bars">
          {(['gyro.x', 'gyro.y', 'gyro.z'] as const).map((k) => {
            const v = s[k] ?? NaN;
            const f = fmt(k, v);
            return <CenterBar key={k} value={v} min={-RATE_SPAN} max={RATE_SPAN} label={f.label} text={f.text} unit={f.unit} tone={Math.abs(v) > RATE_SPAN ? 'caution' : 'accent'} />;
          })}
        </div>
        <p className="dv-note">{tDevice('viz.gyro.rateScale', { span: RATE_SPAN })}</p>
        <div className="dv-readouts">
          <Readout label={fmt('temp', NaN).label} text={fmt('temp', s.temp ?? NaN).text} unit={fmt('temp', s.temp ?? NaN).unit} size="sm" />
        </div>
      </VizBlock>
    </div>
  );
}
