import { useEffect } from 'react';
import { create } from 'zustand';

export type StatusItemTone = 'neutral' | 'info' | 'warn' | 'danger';

/** One entry in the shell's status bar, owned by a screen or service. */
export interface StatusItem {
  /** Already translated text (call `t()` in the owner). */
  text: string;
  tone?: StatusItemTone;
  /** Tooltip / accessible description. */
  title?: string;
  /** Makes the item a button (e.g. navigate to the owner screen). */
  onClick?: () => void;
  /** Lower first. */
  order?: number;
}

interface StatusItemsState {
  items: Readonly<Record<string, StatusItem>>;
}

export const useStatusItems = create<StatusItemsState>(() => ({ items: {} }));

export function setStatusItem(id: string, item: StatusItem | null): void {
  useStatusItems.setState((s) => {
    const items = { ...s.items };
    if (item) items[id] = item;
    else delete items[id];
    return { items };
  });
}

/**
 * Shows `item` in the status bar (right of the link state) while the component is mounted and
 * `item` is non-null. `id` must be unique app-wide (`<screen>.<what>`).
 * ```tsx
 * useStatusItem('scope.recording', recording ? { text: t('rec', { n }), tone: 'danger' } : null);
 * ```
 */
export function useStatusItem(id: string, item: StatusItem | null): void {
  const key = item ? `${item.text}|${item.tone ?? ''}|${item.title ?? ''}|${item.order ?? 0}` : '';
  const click = item?.onClick;
  useEffect(() => {
    if (!item) return;
    setStatusItem(id, item);
    return () => setStatusItem(id, null);
    // item is compared by its visible fields (key); onClick tracked separately
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, click]);
}
