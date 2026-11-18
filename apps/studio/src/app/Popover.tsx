import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../ui';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The trigger; the panel is positioned under it. */
  anchor: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
}

/** Click-outside / Esc dismissable panel under a trigger (top bar menus). */
export function Popover({ open, onClose, anchor, children, align = 'start', width, className }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      // Modals and toasts render in portals; clicks there must not close the menu.
      if (ref.current?.contains(target) || (target instanceof Element && target.closest('.cy-modal-backdrop, .cy-toasts'))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  return (
    <div className="cy-popover-anchor" ref={ref}>
      {anchor}
      {open && (
        <div className={cx('cy-popover', `cy-popover--${align}`, className)} style={width ? { width } : undefined} role="dialog">
          {children}
        </div>
      )}
    </div>
  );
}
