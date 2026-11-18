import { ChevronDown } from 'lucide-react';
import './field.css';
import './Select.css';
import { cx, type ControlSize } from './types';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  value: T | null;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Shown (disabled) when value is null. */
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  error?: boolean;
  /** CSS width; default fits content. */
  width?: number | string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Native select with themed chrome: keyboard, touch and screen readers work
 * out of the box. Values may be strings or numbers (enum parameters).
 */
export function Select<T extends string | number>({
  value,
  options,
  onChange,
  placeholder,
  size = 'md',
  disabled,
  error,
  width,
  id,
  ariaLabel,
  className,
}: SelectProps<T>) {
  const idx = value === null ? -1 : options.findIndex((o) => o.value === value);
  return (
    <span className={cx('cy-input', `cy-input--${size}`, 'cy-select', error && 'is-error', disabled && 'is-disabled', className)} style={{ width }}>
      <select
        id={id}
        className="cy-input__control cy-select__control"
        value={idx < 0 ? '' : String(idx)}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          const o = options[Number(e.target.value)];
          if (o) onChange(o.value);
        }}
      >
        {idx < 0 && (
          <option value="" disabled>
            {placeholder ?? ''}
          </option>
        )}
        {options.map((o, i) => (
          <option key={String(o.value)} value={String(i)} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="cy-select__chevron" size={14} strokeWidth={2.2} aria-hidden />
    </span>
  );
}
