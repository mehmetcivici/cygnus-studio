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

/** Text-entry targets where a plain Space must type a space. */
export function typingTarget(el: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    // Numeric fields never need a space, so Space still stops there.
    if (el.dataset.numeric !== undefined) return false;
    return ['text', 'search', 'email', 'url', 'password', 'tel', ''].includes(el.type);
  }
  return false;
}

const isSpace = (e: KeyboardEvent): boolean => e.code === 'Space' || e.key === ' ';

/** Two Escape presses within this window trigger E-STOP from anywhere. */
export const ESC_DOUBLE_MS = 600;

/**
 * E-STOP keyboard rules, as pure handlers (unit-tested with jsdom):
 * - Space: anywhere except free-text fields. A focused button never also "clicks".
 * - Ctrl+Space: everywhere, text and number fields included.
 * - Esc, Esc (within 600 ms): everywhere; the first Esc still closes dialogs.
 */
export function createEstopKeyHandlers(fire: () => void, now: () => number = () => performance.now()) {
  let lastEsc = -Infinity;
  // Space keydowns we consumed: their keyup is swallowed too, even if Ctrl was released first.
  let swallowSpaceUp = false;
  const keydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (e.repeat) return;
      const t = now();
      if (t - lastEsc <= ESC_DOUBLE_MS) {
        lastEsc = -Infinity;
        e.preventDefault();
        e.stopPropagation();
        fire();
      } else lastEsc = t;
      return;
    }
    lastEsc = -Infinity;
    if (!isSpace(e)) return;
    const chord = e.ctrlKey && !e.altKey && !e.metaKey;
    if (!chord && (e.ctrlKey || e.altKey || e.metaKey)) return;
    if (!chord && typingTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    swallowSpaceUp = true;
    if (!e.repeat) fire();
  };
  // Swallow the matching keyup too, otherwise a focused button would still "click".
  const keyup = (e: KeyboardEvent): void => {
    if (!isSpace(e)) return;
    if (swallowSpaceUp || !typingTarget(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
    swallowSpaceUp = false;
  };
  return { keydown, keyup };
}

/** Installs the E-STOP shortcuts in the capture phase so focused controls cannot swallow them. */
export function installEstopShortcut(): () => void {
  const h = createEstopKeyHandlers(() => triggerEstop('keyboard'));
  window.addEventListener('keydown', h.keydown, true);
  window.addEventListener('keyup', h.keyup, true);
  return () => {
    window.removeEventListener('keydown', h.keydown, true);
    window.removeEventListener('keyup', h.keyup, true);
  };
}
