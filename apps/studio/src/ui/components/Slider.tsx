import type { CSSProperties } from 'react';
import './Slider.css';
import { useI18n } from '../../i18n';
import { cx } from './types';

export interface SliderProps {
  value: number;
  /** Fires continuously while dragging. */
  onChange: (value: number) => void;
  /** Fires once on release / key up (send to device here). */
  onCommit?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Show the formatted value at the right. */
  showValue?: boolean;
  unit?: string;
  digits?: number;
  /** Center-origin fill (for bipolar values like duty −1..1). */
  bipolar?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Slider({ value, onChange, onCommit, min, max, step = 1, showValue, unit, digits = 0, bipolar, disabled, ariaLabel, className }: SliderProps) {
  const { fmtValue } = useI18n();
  const span = max - min || 1;
  const pct = ((Math.min(max, Math.max(min, value)) - min) / span) * 100;
  const zero = bipolar ? ((Math.min(max, Math.max(min, 0)) - min) / span) * 100 : 0;
  const style = { '--from': `${Math.min(zero, pct)}%`, '--to': `${Math.max(zero, pct)}%` } as CSSProperties;
  return (
    <div className={cx('cy-slider', disabled && 'is-disabled', className)}>
      <input
        type="range"
        className="cy-slider__input"
        style={style}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number(e.currentTarget.value))}
        onKeyUp={(e) => onCommit?.(Number(e.currentTarget.value))}
      />
      {showValue && <span className="cy-slider__value cy-mono">{fmtValue(value, unit, digits)}</span>}
    </div>
  );
}
