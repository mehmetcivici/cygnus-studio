import type { ReactNode } from 'react';
import './Toggle.css';
import { cx } from './types';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  /** Accessible name when no visible label. */
  ariaLabel?: string;
  /** Use a danger tint when on (e.g. "Enable actuation"). */
  tone?: 'accent' | 'ok' | 'danger';
  className?: string;
}

/** On/off switch (`role="switch"`). */
export function Toggle({ checked, onChange, label, disabled, size = 'md', ariaLabel, tone = 'accent', className }: ToggleProps) {
  return (
    <label className={cx('cy-toggle', `cy-toggle--${size}`, `cy-toggle--${tone}`, disabled && 'is-disabled', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cx('cy-toggle__track', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="cy-toggle__thumb" />
      </button>
      {label != null && <span className="cy-toggle__label">{label}</span>}
    </label>
  );
}
