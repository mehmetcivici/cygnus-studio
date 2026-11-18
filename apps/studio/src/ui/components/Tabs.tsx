import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import './Tabs.css';
import { cx, type IconComponent } from './types';

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  icon?: IconComponent;
  /** Small count/status after the label. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string = string> {
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  /** `line` (default) for page sections, `pill` inside panels. */
  variant?: 'line' | 'pill';
  ariaLabel?: string;
  className?: string;
}

/** Controlled tab strip (content is rendered by the caller). Arrow keys move focus. */
export function Tabs<T extends string = string>({ items, value, onChange, variant = 'line', ariaLabel, className }: TabsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number): void => {
    const dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let k = 1; k <= items.length; k++) {
      const j = (i + dir * k + items.length) % items.length;
      const it = items[j];
      if (it && !it.disabled) {
        refs.current[j]?.focus();
        onChange(it.id);
        break;
      }
    }
  };
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('cy-tabs', `cy-tabs--${variant}`, className)}>
      {items.map((it, i) => {
        const Icon = it.icon;
        const sel = it.id === value;
        return (
          <button
            key={it.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={sel}
            tabIndex={sel ? 0 : -1}
            disabled={it.disabled}
            className={cx('cy-tab', sel && 'is-selected')}
            onClick={() => onChange(it.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {Icon && <Icon size={15} strokeWidth={2} aria-hidden />}
            <span>{it.label}</span>
            {it.badge != null && <span className="cy-tab__badge">{it.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
