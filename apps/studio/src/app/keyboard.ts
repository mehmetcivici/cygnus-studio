import { navFeatures } from '../features/registry';
import { navigate } from './nav';

function typing(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/** `1`–`8` switch screens in navigation order (not while typing, not with modifiers). */
export function installScreenShortcuts(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || typing(e.target)) return;
    if (document.querySelector('.cy-modal-backdrop')) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const f = navFeatures()[n - 1];
    if (!f) return;
    e.preventDefault();
    navigate(f.id);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
