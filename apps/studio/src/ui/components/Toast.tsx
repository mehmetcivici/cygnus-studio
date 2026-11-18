import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import './Toast.css';
import { useI18n } from '../../i18n';
import { cx } from './types';

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface ToastOptions {
  /** Secondary line. */
  description?: ReactNode;
  /** ms before auto-dismiss; 0 keeps it until closed. Default 4000 (error 7000). */
  duration?: number;
  /** Optional action button (e.g. "Undo", "Show"). */
  action?: { label: string; onClick: () => void };
  /** Same id replaces an existing toast instead of stacking. */
  id?: string;
}

interface ToastItem extends ToastOptions {
  id: string;
  kind: ToastKind;
  title: ReactNode;
}

interface ToastState {
  items: ToastItem[];
  push: (t: ToastItem) => void;
  dismiss: (id: string) => void;
}

const MAX_TOASTS = 5;
let seq = 0;

const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => set((s) => ({ items: [...s.items.filter((x) => x.id !== t.id), t].slice(-MAX_TOASTS) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

function show(kind: ToastKind, title: ReactNode, opts: ToastOptions = {}): string {
  const id = opts.id ?? `t${++seq}`;
  useToasts.getState().push({ ...opts, id, kind, title });
  return id;
}

/**
 * Imperative notifications, callable from anywhere (services included):
 * `toast.success(t('device.saved'))`. Requires `<ToastHost />` mounted once.
 */
export const toast = {
  success: (title: ReactNode, opts?: ToastOptions) => show('success', title, opts),
  error: (title: ReactNode, opts?: ToastOptions) => show('error', title, opts),
  info: (title: ReactNode, opts?: ToastOptions) => show('info', title, opts),
  warn: (title: ReactNode, opts?: ToastOptions) => show('warn', title, opts),
  dismiss: (id: string) => useToasts.getState().dismiss(id),
};

const ICONS = { success: CircleCheck, error: CircleX, info: Info, warn: TriangleAlert } as const;

function ToastView({ item }: { item: ToastItem }) {
  const { t } = useI18n();
  const dismiss = useToasts((s) => s.dismiss);
  const duration = item.duration ?? (item.kind === 'error' ? 7000 : 4000);
  useEffect(() => {
    if (!duration) return;
    const h = window.setTimeout(() => dismiss(item.id), duration);
    return () => window.clearTimeout(h);
  }, [item, duration, dismiss]);
  const Icon = ICONS[item.kind];
  return (
    <div className={cx('cy-toast', `cy-toast--${item.kind}`)} role={item.kind === 'error' ? 'alert' : 'status'}>
      <Icon className="cy-toast__icon" size={18} strokeWidth={2.2} aria-hidden />
      <div className="cy-toast__body">
        <div className="cy-toast__title">{item.title}</div>
        {item.description != null && <div className="cy-toast__desc">{item.description}</div>}
      </div>
      {item.action && (
        <button
          type="button"
          className="cy-toast__action"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <button type="button" className="cy-toast__close" aria-label={t('ui.toast.dismiss')} onClick={() => dismiss(item.id)}>
        <X size={14} strokeWidth={2.2} />
      </button>
      {duration > 0 && <span className="cy-toast__timer" style={{ animationDuration: `${duration}ms` }} />}
    </div>
  );
}

/** Mount once at the app root. */
export function ToastHost() {
  const items = useToasts((s) => s.items);
  return (
    <div className="cy-toasts" aria-live="polite">
      {items.map((it) => (
        <ToastView key={it.id} item={it} />
      ))}
    </div>
  );
}
