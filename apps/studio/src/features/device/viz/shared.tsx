import type { ReactNode } from 'react';
import { signalByKey, type ModelDef } from '@cygnus/protocol';
import { useI18n } from '../../../i18n';
import { cx, type Tone } from '../../../ui';
import { formatSignal, useSettings } from '../../../core';
import { tDevice } from '../messages';

export interface VizProps {
  uid48: string;
  def: ModelDef;
  /** Board is reachable (live values); otherwise the last known values are shown dimmed. */
  live: boolean;
}

/** Formats one catalog signal with unit preferences. */
export function useSignalFormat(def: ModelDef): (key: string, v: number) => { text: string; unit: string; label: string } {
  const { lang, tl } = useI18n();
  const angleUnit = useSettings((s) => s.angleUnit);
  const tempUnit = useSettings((s) => s.tempUnit);
  return (key, v) => {
    const sig = signalByKey(def, key);
    const f = formatSignal(sig, v, lang, { angleUnit, tempUnit });
    return { ...f, label: sig ? tl(sig.label) : key };
  };
}

/** Label + big number + unit. */
export function Readout({ label, text, unit, tone, size = 'md' }: { label: ReactNode; text: string; unit?: string; tone?: Tone; size?: 'sm' | 'md' | 'lg' }) {
  const { lang } = useI18n();
  // Turkish writes the percent sign first (%20).
  const pctFirst = unit === '%' && lang === 'tr';
  return (
    <div className={cx('dv-readout', `dv-readout--${size}`, tone && `is-${tone}`)}>
      <span className="dv-readout__label">{label}</span>
      <span className="dv-readout__value">
        {pctFirst && <span className="dv-readout__unit">%</span>}
        <span className="cy-mono">{text}</span>
        {unit && !pctFirst && <span className="dv-readout__unit">{unit}</span>}
      </span>
    </div>
  );
}

const polar = (r: number, deg: number): [number, number] => {
  const a = (deg * Math.PI) / 180;
  return [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
};

function arcPath(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const sweep = a1 - a0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(sweep) > 180 ? 1 : 0} ${sweep >= 0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface DialProps {
  /** Needle angle, degrees clockwise from the top (NaN hides it). */
  angle: number;
  /** Second, thinner needle (setpoint). */
  ghost?: number;
  /** Allowed range drawn as an arc (degrees clockwise from the top). */
  limits?: [number, number];
  /** Text in the middle. */
  center?: ReactNode;
  sub?: ReactNode;
  /** Tick labels every 90° (default 0/90/180/270 or ±). */
  signedLabels?: boolean;
  tone?: Tone;
  size?: number;
  ariaLabel?: string;
}

/** 360° angle dial: ticks every 30°, needle, optional setpoint needle and limit arc. */
export function Dial({ angle, ghost, limits, center, sub, signedLabels, tone = 'accent', size = 220, ariaLabel }: DialProps) {
  const ticks = Array.from({ length: 72 }, (_, i) => i * 5);
  const labels = signedLabels ? ['0°', '90°', '±180°', '−90°'] : ['0°', '90°', '180°', '270°'];
  const showNeedle = Number.isFinite(angle);
  const [nx, ny] = polar(70, angle);
  const [gx, gy] = ghost !== undefined && Number.isFinite(ghost) ? polar(78, ghost) : [NaN, NaN];
  return (
    <div className="dv-dial" style={{ width: size }}>
      <svg viewBox="0 0 200 200" role="img" aria-label={ariaLabel}>
        <circle cx={100} cy={100} r={88} className="dv-dial__face" />
        {limits && <path d={arcPath(92, limits[0], limits[1])} className="dv-dial__limits" />}
        {ticks.map((a) => {
          const major = a % 90 === 0;
          const mid = a % 30 === 0;
          const [x0, y0] = polar(major ? 74 : mid ? 79 : 83, a);
          const [x1, y1] = polar(87, a);
          return <line key={a} x1={x0} y1={y0} x2={x1} y2={y1} className={cx('dv-dial__tick', major && 'is-major', mid && 'is-mid')} />;
        })}
        {labels.map((l, i) => {
          const [x, y] = polar(61, i * 90);
          return (
            <text key={l} x={x} y={y + 3.5} textAnchor="middle" className="dv-dial__label">
              {l}
            </text>
          );
        })}
        {Number.isFinite(gx) && <line x1={100} y1={100} x2={gx} y2={gy} className="dv-dial__ghost" />}
        {showNeedle && <line x1={100} y1={100} x2={nx} y2={ny} className={cx('dv-dial__needle', `is-${tone}`)} />}
        <circle cx={100} cy={100} r={5} className={cx('dv-dial__hub', `is-${tone}`)} />
      </svg>
      {(center != null || sub != null) && (
        <div className="dv-dial__center">
          {center != null && <div className="dv-dial__value">{center}</div>}
          {sub != null && <div className="dv-dial__sub">{sub}</div>}
        </div>
      )}
    </div>
  );
}

export interface CenterBarProps {
  value: number;
  min: number;
  max: number;
  label: ReactNode;
  text: string;
  unit?: string;
  tone?: Tone;
}

/** Horizontal bar that grows from zero (bipolar ranges grow both ways). */
export function CenterBar({ value, min, max, label, text, unit, tone = 'accent' }: CenterBarProps) {
  const span = max - min || 1;
  const zero = min < 0 && max > 0 ? -min / span : 0;
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, (value - min) / span)) : zero;
  const left = Math.min(zero, v);
  const width = Math.abs(v - zero);
  return (
    <div className="dv-cbar">
      <div className="dv-cbar__head">
        <span className="dv-cbar__label">{label}</span>
        <span className="dv-cbar__value cy-mono">
          {text}
          {unit && <span className="dv-readout__unit">{unit}</span>}
        </span>
      </div>
      <div className="dv-cbar__track">
        {zero > 0 && <span className="dv-cbar__zero" style={{ left: `${zero * 100}%` }} />}
        <span className={cx('dv-cbar__fill', `is-${tone}`)} style={{ left: `${left * 100}%`, width: `${width * 100}%` }} />
      </div>
    </div>
  );
}

/** One chip per fuse bit: ok / blown. */
export function FuseChips({ mask, count, labels }: { mask: number; count: number; labels: (i: number) => string }) {
  const known = Number.isFinite(mask);
  return (
    <div className="dv-fuses">
      {Array.from({ length: count }, (_, i) => {
        const blown = known && (mask & (1 << i)) !== 0;
        return (
          <span key={i} className={cx('dv-fuse', blown && 'is-blown', !known && 'is-unknown')} title={labels(i)}>
            <span className="dv-fuse__n cy-mono">{i + 1}</span>
            <span className="dv-fuse__state">{known ? (blown ? tDevice('viz.fuseBlown') : tDevice('viz.fuseOk')) : '—'}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Small titled block inside a visualisation panel. */
export function VizBlock({ title, children, className, aside }: { title?: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <div className={cx('dv-block', className)}>
      {(title != null || aside != null) && (
        <div className="dv-block__head">
          {title != null && <h3 className="dv-block__title">{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}
