import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import './SplitPane.css';
import { useI18n } from '../../i18n';
import { readStored, writeStored } from '../../lib/storage';
import { cx } from './types';

export interface SplitPaneProps {
  /** `horizontal`: panes side by side; `vertical`: stacked. */
  direction?: 'horizontal' | 'vertical';
  /** Initial size of the first pane as a fraction 0..1 (default 0.5). */
  defaultFraction?: number;
  /** Minimum size of each pane in px (default 160). */
  minSize?: number;
  /** Persist the split under this localStorage key. */
  storageKey?: string;
  children: [ReactNode, ReactNode];
  className?: string;
}

/** Two panes with a draggable (and keyboard-adjustable) divider. */
export function SplitPane({ direction = 'horizontal', defaultFraction = 0.5, minSize = 160, storageKey, children, className }: SplitPaneProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const [frac, setFrac] = useState(() => {
    const stored = storageKey ? Number(readStored(storageKey)) : NaN;
    return stored > 0 && stored < 1 ? stored : defaultFraction;
  });
  const horizontal = direction === 'horizontal';

  const clampFrac = useCallback(
    (f: number): number => {
      const el = root.current;
      const total = el ? (horizontal ? el.clientWidth : el.clientHeight) : 0;
      if (total <= minSize * 2) return 0.5;
      const lo = minSize / total;
      return Math.min(1 - lo, Math.max(lo, f));
    },
    [horizontal, minSize],
  );

  const commit = (f: number): void => {
    const v = clampFrac(f);
    setFrac(v);
    if (storageKey) writeStored(storageKey, v.toFixed(4));
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const el = root.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const move = (ev: globalThis.PointerEvent): void => {
      const f = horizontal ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      commit(f);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      document.body.classList.remove('cy-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    document.body.classList.add('cy-resizing');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const dec = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const inc = horizontal ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec || e.key === inc) {
      e.preventDefault();
      commit(frac + (e.key === inc ? 0.02 : -0.02) * (e.shiftKey ? 5 : 1));
    }
  };

  return (
    <div ref={root} className={cx('cy-split', `cy-split--${direction}`, className)}>
      <div className="cy-split__pane" style={{ flexBasis: `${frac * 100}%` }}>
        {children[0]}
      </div>
      <div
        className="cy-split__handle"
        role="separator"
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(frac * 100)}
        aria-label={t('ui.split.resize')}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(defaultFraction)}
      />
      <div className="cy-split__pane cy-split__pane--rest">{children[1]}</div>
    </div>
  );
}
