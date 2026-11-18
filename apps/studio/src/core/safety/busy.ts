import { useEffect } from 'react';
import { create } from 'zustand';
import type { MessageParams } from '../../i18n';

/**
 * Busy locks: long operations that must not be interrupted by leaving the screen or dropping the
 * link (firmware update, bus capture, parameter restore …). While any lock is held, navigation,
 * disconnect/source change and page unload ask the user first, and the status bar shows it.
 */
export interface BusyLock {
  id: number;
  /** Global i18n key describing the operation, e.g. `firmware.busy.flashing`. */
  reasonKey: string;
  params?: MessageParams;
  since: number;
}

/** What the user is about to do while a lock is held. */
export type LeaveAction = 'navigate' | 'disconnect' | 'unload';

interface BusyState {
  locks: readonly BusyLock[];
  /** Open confirmation, answered by `<BusyPrompt>` in the shell. */
  prompt: { action: LeaveAction; resolve: (ok: boolean) => void } | null;
}

export const useBusy = create<BusyState>(() => ({ locks: [], prompt: null }));
let seq = 0;

/**
 * Holds a busy lock until the returned release function is called (idempotent).
 * ```ts
 * const release = acquireBusyLock('firmware.busy.flashing', { count: 3 });
 * try { await flash(); } finally { release(); }
 * ```
 */
export function acquireBusyLock(reasonKey: string, params?: MessageParams): () => void {
  const lock: BusyLock = { id: ++seq, reasonKey, ...(params ? { params } : {}), since: Date.now() };
  useBusy.setState((s) => ({ locks: [...s.locks, lock] }));
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    useBusy.setState((s) => ({ locks: s.locks.filter((l) => l.id !== lock.id) }));
  };
}

/**
 * Holds a lock while the component is mounted and `reasonKey` is non-null:
 * `useBusyLock(flashing ? 'firmware.busy.flashing' : null)`.
 * `params` are read when the lock is taken; pass a stable object.
 */
export function useBusyLock(reasonKey: string | null | undefined, params?: MessageParams): void {
  const paramsKey = params ? JSON.stringify(params) : '';
  useEffect(() => {
    if (!reasonKey) return;
    return acquireBusyLock(reasonKey, params);
    // params are captured by value through paramsKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reasonKey, paramsKey]);
}

export function isBusy(): boolean {
  return useBusy.getState().locks.length > 0;
}

/**
 * Resolves true when `action` may go ahead: immediately without locks, otherwise after the user
 * confirmed in the shell's dialog. A second request while a dialog is open is refused.
 * Without a mounted `<BusyPrompt>` (tests, early startup) it resolves false while locked.
 */
export function confirmLeave(action: LeaveAction): Promise<boolean> {
  if (!isBusy()) return Promise.resolve(true);
  if (useBusy.getState().prompt || !promptHost) return Promise.resolve(false);
  return new Promise((resolve) => {
    useBusy.setState({
      prompt: {
        action,
        resolve: (ok) => {
          useBusy.setState({ prompt: null });
          resolve(ok);
        },
      },
    });
  });
}

let promptHost = 0;
/** @internal The shell's dialog registers itself so `confirmLeave` knows someone can answer. */
export function registerBusyPromptHost(): () => void {
  promptHost++;
  return () => {
    promptHost--;
  };
}
