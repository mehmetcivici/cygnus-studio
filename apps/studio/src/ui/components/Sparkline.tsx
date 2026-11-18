import { useMemo } from 'react';
import { cx } from './types';

export interface SparklineProps {
  values: readonly number[];
  /** Height in px; width follows the container. */
  height?: number;
  /** CSS color (default: current tone / accent). */
  color?: string;
  /** Soft area fill under the line. */
  fill?: boolean;
  /** Fixed y domain; defaults to data min/max. */
  min?: number;
  max?: number;
  className?: string;
}

const W = 100;

/** Tiny trend line for tiles and table cells (SVG, scales to container width). */
export function Sparkline({ values, height = 28, color = 'var(--tone, var(--cy-accent))', fill = true, min, max, className }: SparklineProps) {
  const { line, area } = useMemo(() => {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return { line: '', area: '' };
    const lo = min ?? Math.min(...finite);
    const hi = max ?? Math.max(...finite);
    const range = hi - lo || 1;
    const n = values.length;
    const pad = 1.5;
    const pts: string[] = [];
    values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const x = (i / (n - 1)) * W;
      const y = pad + (1 - (Math.min(hi, Math.max(lo, v)) - lo) / range) * (height - pad * 2);
      pts.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    });
    const l = `M${pts.join('L')}`;
    return { line: l, area: `${l}L${W},${height}L0,${height}Z` };
  }, [values, height, min, max]);
  return (
    <svg className={cx('cy-spark', className)} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" style={{ height, width: '100%', display: 'block' }} aria-hidden>
      {fill && area && <path d={area} fill={color} opacity={0.12} />}
      {line && <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
    </svg>
  );
}
