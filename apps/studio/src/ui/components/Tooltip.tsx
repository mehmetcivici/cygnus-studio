import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';
import { cx } from './types';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: TooltipSide;
  /** Hover delay in ms (default 350). Focus shows immediately. */
  delay?: number;
  /** Stretch the trigger wrapper to block layout. */
  block?: boolean;
  disabled?: boolean;
}

const GAP = 8;

/** Hover/focus tooltip rendered in a portal so it is never clipped by panels. */
export function Tooltip({ content, children, side = 'top', delay = 350, block, disabled }: TooltipProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; side: TooltipSide } | null>(null);

  const show = (immediate: boolean): void => {
    if (disabled || content == null || content === '') return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), immediate ? 0 : delay);
  };
  const hide = (): void => {
    window.clearTimeout(timer.current);
    setOpen(false);
    setPos(null);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const a = anchor.current.getBoundingClientRect();
    const t = tip.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let s = side;
    if (s === 'top' && a.top - t.height - GAP < 4) s = 'bottom';
    else if (s === 'bottom' && a.bottom + t.height + GAP > vh - 4) s = 'top';
    else if (s === 'left' && a.left - t.width - GAP < 4) s = 'right';
    else if (s === 'right' && a.right + t.width + GAP > vw - 4) s = 'left';
    let x: number;
    let y: number;
    if (s === 'top' || s === 'bottom') {
      x = a.left + a.width / 2 - t.width / 2;
      y = s === 'top' ? a.top - t.height - GAP : a.bottom + GAP;
    } else {
      x = s === 'left' ? a.left - t.width - GAP : a.right + GAP;
      y = a.top + a.height / 2 - t.height / 2;
    }
    x = Math.max(4, Math.min(vw - t.width - 4, x));
    y = Math.max(4, Math.min(vh - t.height - 4, y));
    setPos({ x, y, side: s });
  }, [open, side, content]);

  return (
    <span
      ref={anchor}
      className={cx('cy-tooltip-anchor', block && 'is-block')}
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      onFocus={(e) => {
        if (e.target instanceof HTMLElement && e.target.matches(':focus-visible')) show(true);
      }}
      onBlur={hide}
      onMouseDown={hide}
    >
      {children}
      {open &&
        createPortal(
          <div
            ref={tip}
            role="tooltip"
            className={cx('cy-tooltip', pos && `is-${pos.side}`, pos && 'is-placed')}
            style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
