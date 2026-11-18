import { create } from 'zustand';

export type EstopSource = 'button' | 'keyboard' | 'api';
export type EstopHandler = (source: EstopSource) => void;

const handlers = new Set<EstopHandler>();

interface EstopState {
  /** Increments on every trigger; the shell uses it for visual feedback. */
  count: number;
  lastSource: EstopSource | null;
}

export const useEstop = create<EstopState>(() => ({ count: 0, lastSource: null }));

/**
 * Registers an emergency-stop handler (e.g. the bus service sends the
 * broadcast disable frame). Returns an unregister function.
 */
export function onEstop(handler: EstopHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Fires all handlers. One failing handler never prevents the others. */
export function triggerEstop(source: EstopSource = 'api'): void {
  for (const h of handlers) {
    try {
      h(source);
    } catch (err) {
      console.error('[estop] handler failed', err);
    }
  }
  useEstop.setState((s) => ({ count: s.count + 1, lastSource: source }));
}

function typingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // Numeric fields never need a space, so Space still stops there.
    if (el.dataset.numeric !== undefined) return false;
    return ['text', 'search', 'email', 'url', 'password', ''].includes(el.type);
  }
  return false;
}

/**
 * Space = E-STOP anywhere except while typing free text. Registered in the
 * capture phase so focused buttons cannot swallow it.
 */
export function installEstopShortcut(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (typingTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) triggerEstop('keyboard');
  };
  // Swallow the matching keyup too, otherwise a focused button would still "click".
  const onKeyUp = (e: KeyboardEvent): void => {
    if ((e.code === 'Space' || e.key === ' ') && !typingTarget(e.target)) e.preventDefault();
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
  };
}
