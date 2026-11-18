import { createElement, Fragment, type ComponentType, type ReactNode } from 'react';
import { create } from 'zustand';

/**
 * Named extension points in the shell. Core services (connection manager, bus
 * health) fill them at startup without the shell importing those modules.
 */
export type SlotId =
  | 'topbar.connection'
  | 'topbar.health'
  | 'topbar.actions'
  | 'statusbar.left'
  | 'statusbar.right';

interface SlotEntry {
  key: number;
  component: ComponentType;
  order: number;
}

interface SlotState {
  slots: Partial<Record<SlotId, readonly SlotEntry[]>>;
}

const useSlots = create<SlotState>(() => ({ slots: {} }));
let seq = 0;

/**
 * Renders `component` in `slot`. Lower `order` renders first.
 * Returns an unregister function (call it on HMR / teardown).
 *
 * ```ts
 * registerSlot('topbar.connection', ConnectionPicker);
 * ```
 */
export function registerSlot(slot: SlotId, component: ComponentType, order = 0): () => void {
  const key = ++seq;
  useSlots.setState((s) => ({
    slots: { ...s.slots, [slot]: [...(s.slots[slot] ?? []), { key, component, order }].sort((a, b) => a.order - b.order) },
  }));
  return () =>
    useSlots.setState((s) => ({
      slots: { ...s.slots, [slot]: (s.slots[slot] ?? []).filter((e) => e.key !== key) },
    }));
}

export function useSlotFilled(slot: SlotId): boolean {
  return useSlots((s) => (s.slots[slot]?.length ?? 0) > 0);
}

/** Renders everything registered for `id`, or `fallback` when empty. */
export function Slot({ id, fallback = null }: { id: SlotId; fallback?: ReactNode }): ReactNode {
  const entries = useSlots((s) => s.slots[id]);
  if (!entries?.length) return fallback;
  return createElement(
    Fragment,
    null,
    entries.map((e) => createElement(e.component, { key: e.key })),
  );
}
