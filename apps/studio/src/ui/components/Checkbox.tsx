import { useEffect, useRef, type ReactNode } from 'react';
import { Check, Minus } from 'lucide-react';
import './Checkbox.css';
import { cx } from './types';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function Checkbox({ checked, onChange, label, indeterminate, disabled, ariaLabel, className }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  const Mark = indeterminate ? Minus : Check;
  return (
    <label className={cx('cy-check', disabled && 'is-disabled', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="cy-check__input"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={cx('cy-check__box', (checked || indeterminate) && 'is-on')} aria-hidden>
        <Mark size={12} strokeWidth={3.2} />
      </span>
      {label != null && <span className="cy-check__label">{label}</span>}
    </label>
  );
}
