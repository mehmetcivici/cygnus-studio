import type { ReactNode } from 'react';
import './SegmentedControl.css';
import { cx, type ControlSize, type IconComponent } from './types';

export interface SegmentOption<T extends string | number> {
  value: T;
  label?: ReactNode;
  icon?: IconComponent;
  /** Tooltip / accessible name when the label is icon-only. */
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string | number> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: ControlSize;
  ariaLabel?: string;
  /** Equal-width segments filling the container. */
  block?: boolean;
  disabled?: boolean;
  className?: string;
}

/** Mutually exclusive choice among 2–5 options (loop mode, units, language). */
export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  ariaLabel,
  block,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx('cy-seg', `cy-seg--${size}`, block && 'cy-seg--block', disabled && 'is-disabled', className)}>
      {options.map((o) => {
        const Icon = o.icon;
        const sel = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={sel}
            aria-label={o.label == null ? o.title : undefined}
            title={o.title}
            disabled={disabled || o.disabled}
            className={cx('cy-seg__item', sel && 'is-selected')}
            onClick={() => !sel && onChange(o.value)}
          >
            {Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2} aria-hidden />}
            {o.label != null && <span>{o.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
