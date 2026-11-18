import type { ReactNode } from 'react';
import './Gauge.css';
import { useI18n } from '../../i18n';
import { cx, type Tone } from './types';

export interface GaugeZone {
  from: number;
  to: number;
  tone: Tone;
}

export interface GaugeProps {
  value: number | null;
  min: number;
  max: number;
  unit?: string;
  label?: ReactNode;
  digits?: number;
  /** Colored bands on the outer rim; the value arc takes the tone of its zone. */
  zones?: readonly GaugeZone[];
  /** Force the value arc tone. */
  tone?: Tone;
  /** Diameter in px (default 168). */
  size?: number;
  className?: string;
}

const SWEEP = 240;
const TONE_VAR: Record<Tone, string> = {
  neutral: 'var(--cy-text-3)',
  accent: 'var(--cy-accent)',
  ok: 'var(--cy-ok)',
  warn: 'var(--cy-warn)',
  caution: 'var(--cy-caution)',
  danger: 'var(--cy-danger)',
};

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** 240° arc gauge with value readout (temperature, voltage, load). */
export function Gauge({ value, min, max, unit, label, digits = 1, zones, tone, size = 168, className }: GaugeProps) {
  const { fmtNumber, lang } = useI18n();
  const pctPrefix = unit === '%' && lang === 'tr';
  const c = 50;
  const r = 40;
  const span = max - min || 1;
  const toAngle = (v: number): number => -SWEEP / 2 + (Math.min(max, Math.max(min, v)) - min) / span * SWEEP;
  const v = value ?? min;
  const zone = zones?.find((z) => v >= z.from && v <= z.to);
  const color = TONE_VAR[tone ?? zone?.tone ?? 'accent'];
  const a = toAngle(v);
  const [nx, ny] = polar(c, c, r, a);
  return (
    <div className={cx('cy-gauge', className)} style={{ width: size, ['--gauge-size' as string]: `${size}px` }}>
      <svg viewBox="0 0 100 86" className="cy-gauge__svg" role="img" aria-label={value == null ? undefined : `${fmtNumber(value, digits)} ${unit ?? ''}`}>
        <path d={arc(c, c, r, -SWEEP / 2, SWEEP / 2)} className="cy-gauge__track" />
        {zones?.map((z, i) => (
          <path key={i} d={arc(c, c, r + 6.5, toAngle(z.from), toAngle(z.to))} className="cy-gauge__zone" style={{ stroke: TONE_VAR[z.tone] }} />
        ))}
        {value != null && a > -SWEEP / 2 + 0.5 && <path d={arc(c, c, r, -SWEEP / 2, a)} className="cy-gauge__value" style={{ stroke: color }} />}
        {value != null && <circle cx={nx} cy={ny} r={3.4} className="cy-gauge__knob" style={{ stroke: color }} />}
        <text x={polar(c, c, r, -SWEEP / 2)[0] + 2} y={84} className="cy-gauge__limit" textAnchor="middle">
          {fmtNumber(min, 0)}
        </text>
        <text x={polar(c, c, r, SWEEP / 2)[0] - 2} y={84} className="cy-gauge__limit" textAnchor="middle">
          {fmtNumber(max, 0)}
        </text>
      </svg>
      <div className="cy-gauge__readout">
        {pctPrefix && <span className="cy-gauge__unit">%</span>}
        <span className="cy-gauge__num" style={{ color: zone && zone.tone !== 'ok' && zone.tone !== 'neutral' ? color : undefined }}>
          {fmtNumber(value, digits)}
        </span>
        {unit && !pctPrefix && <span className="cy-gauge__unit">{unit}</span>}
      </div>
      {label != null && <div className="cy-gauge__label">{label}</div>}
    </div>
  );
}
