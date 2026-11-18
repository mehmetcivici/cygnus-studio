import { memo } from 'react';
import { SERVO16_CHANNELS, signalByKey } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { Badge, cx } from '../../../ui';
import { useParam, useSignal, useSignals } from '../../../core';
import { tDevice } from '../messages';
import { CenterBar, Dial, Readout, VizBlock, useSignalFormat, type VizProps } from './shared';

const PULSE_MIN = 500;
const PULSE_MAX = 2500;
const RAIL_KEYS = ['rail.voltage', 'rail.current', 'temp'] as const;
const CHANNELS = Array.from({ length: SERVO16_CHANNELS }, (_, i) => i + 1);

const PulseRow = memo(function PulseRow({ uid48, ch }: { uid48: string; ch: number }) {
  const { fmtNumber } = useI18n();
  const v = useSignal(uid48, `ch.${ch}.pulse`);
  const enabled = useParam(uid48, `ch.${ch}.enable`).value;
  const center = useParam(uid48, `ch.${ch}.center_us`).value ?? 1500;
  const off = !Number.isFinite(v) || v === 0;
  const span = PULSE_MAX - PULSE_MIN;
  const c = (center - PULSE_MIN) / span;
  const x = off ? c : (Math.min(PULSE_MAX, Math.max(PULSE_MIN, v)) - PULSE_MIN) / span;
  return (
    <div className={cx('dv-pulse', (off || enabled === 0) && 'is-off')}>
      <span className="dv-pulse__ch cy-mono">{ch}</span>
      <div className="dv-pulse__track">
        <span className="dv-pulse__center" style={{ left: `${c * 100}%` }} />
        {!off && <span className="dv-pulse__fill" style={{ left: `${Math.min(c, x) * 100}%`, width: `${Math.abs(x - c) * 100}%` }} />}
        {!off && <span className="dv-pulse__mark" style={{ left: `${x * 100}%` }} />}
      </div>
      <span className="dv-pulse__value cy-mono">
        {enabled === 0 ? tDevice('viz.servo.disabled') : off ? tDevice('viz.servo.off') : `${fmtNumber(v, 0)} µs`}
      </span>
    </div>
  );
});

/** 16-channel servo board: one pulse bar per channel around its centre, rail readouts. */
export function VizServo16({ uid48, def }: VizProps) {
  const s = useSignals(uid48, RAIL_KEYS);
  const fmt = useSignalFormat(def);
  const half = Math.ceil(CHANNELS.length / 2);
  return (
    <div className="dv-viz dv-viz--wide">
      <VizBlock
        title={tDevice('viz.servo.pulses')}
        aside={
          <span className="dv-block__meta">
            {PULSE_MIN}–{PULSE_MAX} µs
          </span>
        }
      >
        <div className="dv-pulses">
          <div>
            {CHANNELS.slice(0, half).map((ch) => (
              <PulseRow key={ch} uid48={uid48} ch={ch} />
            ))}
          </div>
          <div>
            {CHANNELS.slice(half).map((ch) => (
              <PulseRow key={ch} uid48={uid48} ch={ch} />
            ))}
          </div>
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.servo.rail')}>
        <div className="dv-readouts dv-readouts--col">
          {RAIL_KEYS.map((k) => {
            const f = fmt(k, s[k] ?? NaN);
            return <Readout key={k} label={f.label} text={f.text} unit={f.unit} />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}

const SEALED_KEYS = ['position', 'setpoint', 'velocity', 'current', 'voltage', 'temp', 'output', 'error', 'ctrl.mode'] as const;

/** Sealed servo: angle dial with setpoint needle and soft limits, current and output bars. */
export function VizSealedServo({ uid48, def }: VizProps) {
  const { tl, fmtNumber } = useI18n();
  const s = useSignals(uid48, SEALED_KEYS);
  const fmt = useSignalFormat(def);
  const lo = useParam(uid48, 'limits.min_angle_deg').value;
  const hi = useParam(uid48, 'limits.max_angle_deg').value;
  const continuous = useParam(uid48, 'motion.continuous').value === 1;
  const iLimit = useParam(uid48, 'limits.current_a').value;
  const pos = s.position ?? NaN;
  const mode = signalByKey(def, 'ctrl.mode')?.options?.find((o) => o.value === s['ctrl.mode']);
  const cur = s.current ?? NaN;
  const out = s.output ?? NaN;
  const vel = s.velocity ?? NaN;
  const iSpan = iLimit && iLimit > 0 ? iLimit * 1.25 : 10;
  return (
    <div className="dv-viz">
      <VizBlock
        title={tDevice('viz.sealed.angle')}
        aside={
          <Badge size="sm" tone={mode && mode.value !== 0 ? 'accent' : 'neutral'}>
            {tDevice('viz.esc.mode')}: {mode ? tl(mode.label) : '—'}
          </Badge>
        }
      >
        <Dial
          angle={pos}
          ghost={s['ctrl.mode'] ? (s.setpoint ?? NaN) : undefined}
          limits={!continuous && lo !== undefined && hi !== undefined ? [lo, hi] : undefined}
          signedLabels
          center={
            <>
              <span className="cy-mono">{fmtNumber(pos, 1)}</span>
              <span className="dv-readout__unit">°</span>
            </>
          }
          sub={
            continuous
              ? tDevice('viz.sealed.continuous')
              : lo !== undefined && hi !== undefined
                ? tDevice('viz.sealed.limits', { lo: fmtNumber(lo, 0), hi: fmtNumber(hi, 0) })
                : undefined
          }
          ariaLabel={tDevice('viz.sealed.angle')}
        />
        <div className="dv-legend">
          <span className="dv-legend__item is-needle">{fmt('position', NaN).label}</span>
          <span className="dv-legend__item is-ghost">{fmt('setpoint', NaN).label}</span>
          <span className="dv-legend__item is-limits">{tDevice('viz.sealed.limitsLegend')}</span>
        </div>
      </VizBlock>
      <VizBlock title={tDevice('viz.sealed.load')}>
        <div className="dv-bars">
          <CenterBar value={cur} min={-iSpan} max={iSpan} label={fmt('current', cur).label} text={fmt('current', cur).text} unit="A" tone={iLimit && Math.abs(cur) > iLimit * 0.9 ? 'caution' : 'accent'} />
          <CenterBar value={out} min={-1} max={1} label={fmt('output', out).label} text={Number.isFinite(out) ? (out * 100).toFixed(0) : '—'} unit="%" />
          <CenterBar value={vel} min={-720} max={720} label={fmt('velocity', vel).label} text={fmt('velocity', vel).text} unit={fmt('velocity', vel).unit} />
        </div>
        <div className="dv-readouts">
          {(['error', 'voltage', 'temp'] as const).map((k) => {
            const f = fmt(k, s[k] ?? NaN);
            return <Readout key={k} label={f.label} text={f.text} unit={k === 'error' ? '°' : f.unit} size="sm" />;
          })}
        </div>
      </VizBlock>
    </div>
  );
}
