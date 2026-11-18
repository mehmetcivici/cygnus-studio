import type { ReactNode } from 'react';
import './BarMeter.css';
import { useI18n } from '../../i18n';
import { cx, type Tone } from './types';

export interface BarMeterProps {
  value: number | null;
  max: number;
  min?: number;
  /** Limit line (e.g. channel current limit). Above it the bar turns danger. */
  threshold?: number;
  /** Fraction of `threshold` where the bar turns warn (default 0.8). */
  warnRatio?: number;
  unit?: string;
  digits?: number;
  /** Label under the bar (channel name). */
  label?: ReactNode;
  /** Bar track height in px (default 120). */
  height?: number;
  /** Bar width in px (default 22). */
  width?: number;
  /** Force tone instead of threshold logic. */
  tone?: Tone;
  /** Dim (channel disabled). */
  inactive?: boolean;
  className?: string;
}

/** Vertical level bar with threshold line, e.g. per-channel current. */
export function BarMeter({
  value,
  max,
  min = 0,
  threshold,
  warnRatio = 0.8,
  unit,
  digits = 1,
  label,
  height = 120,
  width = 22,
  tone,
  inactive,
  className,
}: BarMeterProps) {
  const { fmtNumber } = useI18n();
  const span = max - min || 1;
  const frac = value == null ? 0 : Math.min(1, Math.max(0, (value - min) / span));
  const auto: Tone =
    threshold === undefined || value == null ? 'accent' : value > threshold ? 'danger' : value > threshold * warnRatio ? 'warn' : 'accent';
  const effTone = tone ?? auto;
  const tFrac = threshold === undefined ? null : Math.min(1, Math.max(0, (threshold - min) / span));
  return (
    <div className={cx('cy-bar', `cy-bar--${effTone}`, inactive && 'is-inactive', className)} style={{ width: Math.max(width + 14, 36) }}>
      <div className="cy-bar__value">
        {fmtNumber(value, digits)}
        {unit && <span className="cy-bar__unit">{unit}</span>}
      </div>
      <div
        className="cy-bar__track"
        style={{ height, width }}
        role="meter"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value ?? undefined}
      >
        <div className="cy-bar__fill" style={{ height: `${frac * 100}%` }} />
        {tFrac !== null && <div className="cy-bar__threshold" style={{ bottom: `${tFrac * 100}%` }} />}
      </div>
      {label != null && <div className="cy-bar__label">{label}</div>}
    </div>
  );
}
