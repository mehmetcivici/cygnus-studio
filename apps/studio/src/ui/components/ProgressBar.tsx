import type { ReactNode } from 'react';
import './ProgressBar.css';
import { useI18n } from '../../i18n';
import { cx, type Tone } from './types';

export interface ProgressBarProps {
  /** 0..1; `null` for indeterminate. */
  value: number | null;
  tone?: Tone;
  size?: 'sm' | 'md';
  label?: ReactNode;
  /** Show the percentage at the right of the label row. */
  showPercent?: boolean;
  className?: string;
}

export function ProgressBar({ value, tone = 'accent', size = 'md', label, showPercent, className }: ProgressBarProps) {
  const { fmtValue } = useI18n();
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  return (
    <div className={cx('cy-progress', `cy-progress--${tone}`, `cy-progress--${size}`, className)}>
      {(label != null || showPercent) && (
        <div className="cy-progress__row">
          <span className="cy-progress__label">{label}</span>
          {showPercent && v != null && <span className="cy-progress__pct cy-mono">{fmtValue(v * 100, '%', 0)}</span>}
        </div>
      )}
      <div
        className="cy-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v == null ? undefined : Math.round(v * 100)}
      >
        <div className={cx('cy-progress__fill', v == null && 'is-indeterminate')} style={v == null ? undefined : { width: `${v * 100}%` }} />
      </div>
    </div>
  );
}
