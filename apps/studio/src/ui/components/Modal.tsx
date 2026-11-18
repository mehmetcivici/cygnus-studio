import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { TriangleAlert, X } from 'lucide-react';
import './Modal.css';
import { useI18n } from '../../i18n';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { cx } from './types';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Action buttons, right-aligned. */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Allow Esc / backdrop click to close (default true). Disable during critical work (flashing). */
  dismissible?: boolean;
  className?: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialog in a portal with focus trap, Esc to close and focus restore. */
export function Modal({ open, onClose, title, children, footer, size = 'md', dismissible = true, className }: ModalProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        const a = items[0];
        const b = items[items.length - 1];
        if (!a || !b) return;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus();
    };
  }, [open, dismissible]);

  if (!open) return null;
  return createPortal(
    <div className="cy-modal-backdrop" onMouseDown={(e) => dismissible && e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={cx('cy-modal', `cy-modal--${size}`, className)}>
        <header className="cy-modal__head">
          <h2 id={titleId} className="cy-modal__title">
            {title}
          </h2>
          {dismissible && <IconButton icon={X} label={t('common.close')} size="sm" onClick={onClose} noTooltip />}
        </header>
        {children != null && <div className="cy-modal__body">{children}</div>}
        {footer != null && <footer className="cy-modal__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for destructive / actuating actions. */
  tone?: 'primary' | 'danger';
  /** Shows a spinner on the confirm button and blocks dismissal. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, cancelLabel, tone = 'primary', busy, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          {/* Destructive dialogs focus Cancel so a stray Enter cannot confirm. */}
          <Button variant="ghost" onClick={onCancel} disabled={busy} data-autofocus={tone === 'danger' ? '' : undefined}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} data-autofocus={tone === 'danger' ? undefined : ''}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className={cx('cy-confirm', `cy-confirm--${tone}`)}>
        {tone === 'danger' && (
          <span className="cy-confirm__icon">
            <TriangleAlert size={18} strokeWidth={2.2} aria-hidden />
          </span>
        )}
        <div className="cy-confirm__msg">{message}</div>
      </div>
    </Modal>
  );
}
