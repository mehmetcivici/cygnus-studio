import type { ReactNode } from 'react';
import './StatTile.css';
import { useI18n } from '../../i18n';
import { Sparkline } from './Sparkline';
import { cx, type IconComponent, type Tone } from './types';

export interface StatTileProps {
  label: ReactNode;
  /** null renders an em dash (no data yet). */
  value: number | null;
  unit?: string;
  /** Decimals (default 1). */
  digits?: number;
  /** Tints the value and sparkline; use for limit states. */
  tone?: Tone;
  icon?: IconComponent;
  /** Recent values for the mini trend line. */
  trend?: readonly number[];
  /** Small line under the value (e.g. "limit 40 A"). */
  caption?: ReactNode;
  size?: 'md' | 'lg';
  className?: string;
}

/** Big live number with unit, label and optional sparkline. */
export function StatTile({ label, value, unit, digits = 1, tone = 'neutral', icon: Icon, trend, caption, size = 'md', className }: StatTileProps) {
  const { fmtNumber, lang } = useI18n();
  const num = fmtNumber(value, digits);
  const pctPrefix = unit === '%' && lang === 'tr';
  return (
    <div className={cx('cy-stat', `cy-stat--${tone}`, `cy-stat--${size}`, className)}>
      <div className="cy-stat__label">
        {Icon && <Icon size={13} strokeWidth={2.2} aria-hidden />}
        <span>{label}</span>
      </div>
      <div className="cy-stat__value">
        {pctPrefix && <span className="cy-stat__unit cy-stat__unit--pre">%</span>}
        <span className="cy-stat__num">{num}</span>
        {unit && !pctPrefix && <span className="cy-stat__unit">{unit}</span>}
      </div>
      {caption != null && <div className="cy-stat__caption">{caption}</div>}
      {trend && trend.length > 1 && (
        <div className="cy-stat__trend">
          <Sparkline values={trend} height={size === 'lg' ? 34 : 24} />
        </div>
      )}
    </div>
  );
}
