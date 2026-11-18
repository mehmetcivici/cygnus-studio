import type { ReactNode } from 'react';
import './Page.css';
import { cx, type IconComponent } from './types';

export interface PageProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconComponent;
  /** Right side of the page header (primary actions). */
  actions?: ReactNode;
  /** Row under the title (tabs, filters). */
  toolbar?: ReactNode;
  /** `fill`: content takes the remaining height without page scroll (charts, tables). */
  layout?: 'scroll' | 'fill';
  children?: ReactNode;
  className?: string;
}

/** Standard screen frame used by every feature. */
export function Page({ title, subtitle, icon: Icon, actions, toolbar, layout = 'scroll', children, className }: PageProps) {
  return (
    <div className={cx('cy-page', `cy-page--${layout}`, className)}>
      <header className="cy-page__head">
        <div className="cy-page__titles">
          {Icon && (
            <span className="cy-page__icon">
              <Icon size={18} strokeWidth={2} aria-hidden />
            </span>
          )}
          <div className="cy-page__text">
            <h1 className="cy-page__title">{title}</h1>
            {subtitle != null && <p className="cy-page__subtitle">{subtitle}</p>}
          </div>
        </div>
        {actions != null && <div className="cy-page__actions">{actions}</div>}
      </header>
      {toolbar != null && <div className="cy-page__toolbar">{toolbar}</div>}
      <div className="cy-page__content">{children}</div>
    </div>
  );
}
