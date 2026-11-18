import type { HTMLAttributes, ReactNode } from 'react';
import './Panel.css';
import { cx, type IconComponent } from './types';

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Secondary text next to the title (e.g. model name, count). */
  subtitle?: ReactNode;
  icon?: IconComponent;
  /** Header action slot (buttons, segmented controls). */
  actions?: ReactNode;
  /** Body padding (default `md`). */
  padding?: 'none' | 'sm' | 'md';
  /** Fill available height; the body scrolls. */
  fill?: boolean;
  /** Optional footer bar (e.g. Apply / Revert). */
  footer?: ReactNode;
  children?: ReactNode;
}

/** Titled surface; the main building block of every screen. */
export function Panel({ title, subtitle, icon: Icon, actions, padding = 'md', fill, footer, className, children, ...rest }: PanelProps) {
  const hasHead = title != null || actions != null;
  return (
    <section className={cx('cy-panel', fill && 'cy-panel--fill', className)} {...rest}>
      {hasHead && (
        <header className="cy-panel__head">
          {Icon && <Icon className="cy-panel__icon" size={15} strokeWidth={2} aria-hidden />}
          <div className="cy-panel__titles">
            {title != null && <h2 className="cy-panel__title">{title}</h2>}
            {subtitle != null && <span className="cy-panel__subtitle">{subtitle}</span>}
          </div>
          {actions != null && <div className="cy-panel__actions">{actions}</div>}
        </header>
      )}
      <div className={cx('cy-panel__body', `cy-panel__body--${padding}`)}>{children}</div>
      {footer != null && <footer className="cy-panel__foot">{footer}</footer>}
    </section>
  );
}

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Hover/press affordance; use with onClick. */
  interactive?: boolean;
  selected?: boolean;
  /** Left accent stripe tone (e.g. device status). */
  tone?: 'accent' | 'ok' | 'warn' | 'caution' | 'danger';
  children?: ReactNode;
}

/** Compact, untitled surface for list items such as device cards. */
export function Card({ interactive, selected, tone, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cx('cy-card', interactive && 'is-interactive', selected && 'is-selected', tone && `cy-card--${tone}`, className)}
      tabIndex={interactive && rest.tabIndex === undefined ? 0 : rest.tabIndex}
      aria-selected={interactive ? selected : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}
