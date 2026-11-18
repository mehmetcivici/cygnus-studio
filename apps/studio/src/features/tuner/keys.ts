import { useEffect, useRef } from 'react';
import { useTuner } from './controller';
import { useTunerUi } from './state';

function interactive(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || el.getAttribute('role') === 'slider' || el.getAttribute('role') === 'option';
}

/**
 * Screen shortcuts: Enter starts the configured test, A / B switch the gain set (↑/↓ live in
 * the manual control). Space is the global E-STOP and is never handled here.
 */
export function useTunerKeys(): void {
  const api = useTuner();
  const ref = useRef(api);
  ref.current = api;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || interactive(e.target)) return;
      if (document.querySelector('.cy-modal-backdrop')) return;
      const a = ref.current;
      if (e.key === 'Enter') {
        if (!a.armed || useTunerUi.getState().busy || a.signalBlock || a.config.signal.kind === 'manual') return;
        e.preventDefault();
        void a.runClosed();
      } else if (e.key === 'a' || e.key === 'A' || e.key === 'b' || e.key === 'B') {
        if (useTunerUi.getState().busy) return;
        e.preventDefault();
        void a.switchSet(e.key.toUpperCase() as 'A' | 'B');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
