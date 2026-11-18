import { create } from 'zustand';
import { readStored, writeStored } from '../../lib/storage';

export type ThemeName = 'dark' | 'light';

const STORAGE_KEY = 'cy.theme';

interface ThemeState {
  theme: ThemeName;
  setTheme: (theme: ThemeName) => void;
  toggleTheme: () => void;
}

function initialTheme(): ThemeName {
  return readStored(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: ThemeName): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

/** Global theme store. `data-theme` on <html> drives every CSS token. */
export const useTheme = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  setTheme: (theme) => {
    applyTheme(theme);
    writeStored(STORAGE_KEY, theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}));

applyTheme(useTheme.getState().theme);

/**
 * Resolves a CSS color that may reference a token (`var(--cy-chart-1)` or the
 * short form `chart-1`) to a concrete color string. Canvas renderers (uPlot)
 * cannot use CSS variables directly.
 */
export function resolveColor(color: string, el: Element = document.documentElement): string {
  let name: string | null = null;
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (m?.[1]) name = m[1];
  else if (/^[a-z][\w-]*$/.test(color) && !CSS_NAMED.has(color)) name = `--cy-${color}`;
  if (!name) return color;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || color;
}

// Plain CSS color keywords that must not be mistaken for token short names.
const CSS_NAMED = new Set(['transparent', 'currentcolor', 'black', 'white', 'red', 'green', 'blue', 'orange', 'yellow', 'gray', 'grey']);

/** Default series colors, cycled by index. */
export const CHART_COLORS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8'] as const;

export function chartColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length] ?? 'chart-1';
}
