import type { ReactNode } from 'react';
import './EmptyState.css';
import { cx, type IconComponent } from './types';

export interface EmptyStateProps {
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  /** Buttons guiding the next step. */
  actions?: ReactNode;
  /** `sm` for inside panels/tables. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, actions, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cx('cy-empty', `cy-empty--${size}`, className)}>
      {Icon && (
        <div className="cy-empty__icon">
          <Icon size={size === 'sm' ? 20 : 26} strokeWidth={1.6} aria-hidden />
        </div>
      )}
      <div className="cy-empty__title">{title}</div>
      {description != null && <div className="cy-empty__desc">{description}</div>}
      {actions != null && <div className="cy-empty__actions">{actions}</div>}
    </div>
  );
}
