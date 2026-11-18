import { create } from 'zustand';

export type NavParams = Readonly<Record<string, string>>;

export const DEFAULT_SCREEN = 'bus';

interface NavState {
  /** Active screen id (a feature id, e.g. `tuner`). */
  screen: string;
  /** Optional screen parameters, e.g. `{ device: 'esc80-3' }`. */
  params: NavParams;
  navigate: (screen: string, params?: NavParams) => void;
}

/** Parses `#/tuner?device=esc-3` → `{ screen: 'tuner', params: { device: 'esc-3' } }`. */
export function parseHash(hash: string): { screen: string; params: NavParams } {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  const screen = decodeURIComponent(path.split('/')[0] ?? '') || DEFAULT_SCREEN;
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { screen, params };
}

export function formatHash(screen: string, params: NavParams = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#/${encodeURIComponent(screen)}${q ? `?${q}` : ''}`;
}

function sameParams(a: NavParams, b: NavParams): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Navigation store; the URL hash mirrors it (no router library). Services
 * that must react to page changes (e.g. stop actuation) can
 * `useNav.subscribe(...)`.
 */
export const useNav = create<NavState>((set, get) => ({
  ...(typeof location !== 'undefined' ? parseHash(location.hash) : { screen: DEFAULT_SCREEN, params: {} }),
  navigate: (screen, params = {}) => {
    const cur = get();
    if (cur.screen === screen && sameParams(cur.params, params)) return;
    set({ screen, params });
    if (typeof location !== 'undefined') {
      const h = formatHash(screen, params);
      if (location.hash !== h) location.hash = h;
    }
  },
}));

export function navigate(screen: string, params?: NavParams): void {
  useNav.getState().navigate(screen, params);
}

/** Keeps the store in sync with back/forward and manual hash edits. */
export function initNavSync(): () => void {
  const onHash = (): void => {
    const { screen, params } = parseHash(location.hash);
    useNav.getState().navigate(screen, params);
  };
  window.addEventListener('hashchange', onHash);
  if (!location.hash) history.replaceState(null, '', formatHash(useNav.getState().screen, useNav.getState().params));
  return () => window.removeEventListener('hashchange', onHash);
}
