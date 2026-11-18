import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import './Button.css';
import { Spinner } from './Spinner';
import { ICON_SIZE, cx, type ControlSize, type IconComponent } from './types';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Leading icon component, e.g. `icon={Save}`. */
  icon?: IconComponent;
  iconRight?: IconComponent;
  /** Shows a spinner, keeps width, blocks clicks. */
  loading?: boolean;
  /** Stretch to container width. */
  block?: boolean;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight, loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const is = ICON_SIZE[size];
  return (
    <button
      ref={ref}
      type={type}
      className={cx('cy-btn', `cy-btn--${variant}`, `cy-btn--${size}`, block && 'cy-btn--block', loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={is - 2} /> : Icon && <Icon size={is} strokeWidth={2} aria-hidden />}
      {children !== undefined && <span className="cy-btn__label">{children}</span>}
      {IconRight && !loading && <IconRight size={is} strokeWidth={2} aria-hidden />}
    </button>
  );
});
