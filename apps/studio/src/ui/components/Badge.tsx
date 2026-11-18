import type { ReactNode } from 'react';
import './Badge.css';
import { cx, type IconComponent, type Tone } from './types';

export interface BadgeProps {
  tone?: Tone;
  /** `soft` (default) tinted fill, `solid` strong fill, `outline` border only. */
  variant?: 'soft' | 'solid' | 'outline';
  icon?: IconComponent;
  /** Monospace text for IDs, versions, hex. */
  mono?: boolean;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
  children?: ReactNode;
}

export function Badge({ tone = 'neutral', variant = 'soft', icon: Icon, mono, size = 'md', title, className, children }: BadgeProps) {
  return (
    <span title={title} className={cx('cy-badge', `cy-badge--${tone}`, `cy-badge--${variant}`, `cy-badge--${size}`, mono && 'cy-badge--mono', className)}>
      {Icon && <Icon size={size === 'sm' ? 11 : 12} strokeWidth={2.4} aria-hidden />}
      {children}
    </span>
  );
}
