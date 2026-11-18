import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import './field.css';
import { cx, type ControlSize, type IconComponent } from './types';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange' | 'value' | 'prefix'> {
  value: string;
  onChange: (value: string) => void;
  size?: ControlSize;
  /** Leading icon, e.g. Search. */
  icon?: IconComponent;
  /** Trailing content (unit, clear button, Kbd hint). */
  suffix?: ReactNode;
  /** Error state; a string is shown under the field. */
  error?: boolean | string;
  /** Monospace (IDs, hex filters). */
  mono?: boolean;
  block?: boolean;
  width?: number | string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { value, onChange, size = 'md', icon: Icon, suffix, error, mono, block, width, className, disabled, readOnly, ...rest },
  ref,
) {
  return (
    <span className={cx('cy-textfield', className)} style={{ display: block ? 'block' : 'inline-block', width }}>
      <span
        className={cx(
          'cy-input',
          `cy-input--${size}`,
          'cy-input--block',
          error && 'is-error',
          disabled && 'is-disabled',
          readOnly && 'is-readonly',
        )}
      >
        {Icon && <Icon className="cy-input__icon" size={size === 'sm' ? 13 : 15} strokeWidth={2} aria-hidden />}
        <input
          ref={ref}
          className={cx('cy-input__control', mono && 'cy-mono')}
          value={value}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
        />
        {suffix != null && <span className="cy-input__affix">{suffix}</span>}
      </span>
      {typeof error === 'string' && error && <span className="cy-field-error">{error}</span>}
    </span>
  );
});
