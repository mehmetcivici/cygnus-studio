import { forwardRef, type ButtonHTMLAttributes } from 'react';
import './Button.css';
import { Tooltip } from './Tooltip';
import { ICON_SIZE, cx, type ControlSize, type IconComponent } from './types';
import type { ButtonVariant } from './Button';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconComponent;
  /** Accessible name; also shown as tooltip. */
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
  /** Toggled-on look (e.g. active tool). */
  active?: boolean;
  /** Disable the hover tooltip (label stays as aria-label). */
  noTooltip?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, variant = 'ghost', size = 'md', active, noTooltip, className, type = 'button', ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      className={cx('cy-btn', `cy-btn--${variant}`, `cy-btn--${size}`, 'cy-btn--icon', active && 'is-active', className)}
      {...rest}
    >
      <Icon size={ICON_SIZE[size]} strokeWidth={2} aria-hidden />
    </button>
  );
  return noTooltip ? btn : <Tooltip content={label}>{btn}</Tooltip>;
});
