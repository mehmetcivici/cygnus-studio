import { CHART_COLORS } from '../../ui';

export type Axis = 'left' | 'right';
export type ScopeMode = 'normal' | 'fast';

export interface ScopeSignalCfg {
  /** `${uid48}/${key}`; one entry per signal. */
  id: string;
  uid48: string;
  key: string;
  /**
   * Catalog model of the card the signal was picked on. A uid48 alone may match another card
   * (a different simulator scenario, a re-flashed board); absent in older project files.
   */
  model?: number;
  /** Theme token (`chart-3`) or CSS color. */
  color: string;
  axis: Axis;
  visible: boolean;
  pane: string;
}

export interface ScopeLayout {
  panes: string[];
  signals: ScopeSignalCfg[];
  windowS: number;
  /** Requested stream period for high-speed mode, µs. */
  periodUs: number;
}

export const WINDOW_OPTIONS_S = [1, 2, 5, 10, 30, 60, 120, 300] as const;
export const PERIOD_OPTIONS_US = [500, 1000, 2000, 5000, 10000, 20000, 50000] as const;
export const MAX_SIGNALS = 16;
export const MAX_PANES = 4;

export const signalId = (uid48: string, key: string): string => `${uid48}/${key}`;

export const defaultLayout = (): ScopeLayout => ({ panes: ['p1'], signals: [], windowS: 10, periodUs: 1000 });

function isCfg(v: unknown): v is ScopeSignalCfg {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.uid48 === 'string' &&
    typeof o.key === 'string' &&
    (o.model === undefined || typeof o.model === 'number') &&
    typeof o.color === 'string' &&
    (o.axis === 'left' || o.axis === 'right') &&
    typeof o.visible === 'boolean' &&
    typeof o.pane === 'string'
  );
}

export function isScopeLayout(v: unknown): v is ScopeLayout {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.panes) || o.panes.length === 0 || !o.panes.every((p) => typeof p === 'string')) return false;
  if (!Array.isArray(o.signals) || !o.signals.every(isCfg)) return false;
  const panes = o.panes as string[];
  return (
    (o.signals as ScopeSignalCfg[]).every((s) => panes.includes(s.pane)) &&
    typeof o.windowS === 'number' &&
    o.windowS > 0 &&
    typeof o.periodUs === 'number' &&
    o.periodUs >= 100
  );
}

type UnitOf = (s: ScopeSignalCfg) => string;

/**
 * Axis for a signal joining a pane: the axis its unit already uses there; otherwise the
 * right axis when the left one holds another unit; otherwise left. Equal units always
 * share one axis so values stay comparable.
 */
export function autoAxis(siblings: readonly ScopeSignalCfg[], unit: string, unitOf: UnitOf): Axis {
  const same = siblings.find((s) => unitOf(s) === unit);
  if (same) return same.axis;
  const leftUsed = siblings.some((s) => s.axis === 'left');
  const rightUsed = siblings.some((s) => s.axis === 'right');
  if (!leftUsed) return 'left';
  return rightUsed ? 'left' : 'right';
}

function nextColor(signals: readonly ScopeSignalCfg[]): string {
  const used = new Set(signals.map((s) => s.color));
  return CHART_COLORS.find((c) => !used.has(c)) ?? CHART_COLORS[signals.length % CHART_COLORS.length] ?? 'chart-1';
}

export function addSignal(layout: ScopeLayout, uid48: string, key: string, unit: string, unitOf: UnitOf, pane?: string, model?: number): ScopeLayout {
  const id = signalId(uid48, key);
  if (layout.signals.some((s) => s.id === id) || layout.signals.length >= MAX_SIGNALS) return layout;
  const target = pane && layout.panes.includes(pane) ? pane : (layout.panes[0] ?? 'p1');
  const siblings = layout.signals.filter((s) => s.pane === target);
  const cfg: ScopeSignalCfg = {
    id,
    uid48,
    key,
    ...(model !== undefined ? { model } : {}),
    color: nextColor(layout.signals),
    axis: autoAxis(siblings, unit, unitOf),
    visible: true,
    pane: target,
  };
  return { ...layout, signals: [...layout.signals, cfg] };
}

export function removeSignal(layout: ScopeLayout, id: string): ScopeLayout {
  return { ...layout, signals: layout.signals.filter((s) => s.id !== id) };
}

export function moveSignal(layout: ScopeLayout, id: string, pane: string, unitOf: UnitOf): ScopeLayout {
  const sig = layout.signals.find((s) => s.id === id);
  if (!sig || sig.pane === pane || !layout.panes.includes(pane)) return layout;
  const siblings = layout.signals.filter((s) => s.pane === pane);
  const axis = autoAxis(siblings, unitOf(sig), unitOf);
  return { ...layout, signals: layout.signals.map((s) => (s.id === id ? { ...s, pane, axis } : s)) };
}

/** Moves every signal of the same unit in the pane together (same unit, same axis). */
export function setAxis(layout: ScopeLayout, id: string, axis: Axis, unitOf: UnitOf): ScopeLayout {
  const sig = layout.signals.find((s) => s.id === id);
  if (!sig) return layout;
  const unit = unitOf(sig);
  return { ...layout, signals: layout.signals.map((s) => (s.pane === sig.pane && unitOf(s) === unit ? { ...s, axis } : s)) };
}

export function patchSignal(layout: ScopeLayout, id: string, patch: Partial<Pick<ScopeSignalCfg, 'color' | 'visible'>>): ScopeLayout {
  return { ...layout, signals: layout.signals.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function addPane(layout: ScopeLayout): ScopeLayout {
  if (layout.panes.length >= MAX_PANES) return layout;
  let n = layout.panes.length + 1;
  while (layout.panes.includes(`p${n}`)) n++;
  return { ...layout, panes: [...layout.panes, `p${n}`] };
}

/** Removes a pane; its signals move to the first remaining one. The last pane stays. */
export function removePane(layout: ScopeLayout, pane: string, unitOf: UnitOf): ScopeLayout {
  if (layout.panes.length <= 1 || !layout.panes.includes(pane)) return layout;
  const rest = layout.panes.filter((p) => p !== pane);
  const target = rest[0] ?? 'p1';
  let signals = layout.signals;
  for (const s of layout.signals.filter((x) => x.pane === pane)) {
    const siblings = signals.filter((x) => x.pane === target && x.id !== s.id);
    const axis = autoAxis(siblings, unitOf(s), unitOf);
    signals = signals.map((x) => (x.id === s.id ? { ...x, pane: target, axis } : x));
  }
  return { ...layout, panes: rest, signals };
}

export interface SignalSpec {
  key: string;
  unit: string;
}

/** One pane per distinct unit (at most `MAX_PANES`), signals in the order given. */
export function groupedLayout(uid48: string, specs: readonly SignalSpec[], base: ScopeLayout = defaultLayout(), model?: number): ScopeLayout {
  const units: string[] = [];
  for (const s of specs) if (!units.includes(s.unit) && units.length < MAX_PANES) units.push(s.unit);
  let layout: ScopeLayout = { ...base, panes: units.map((_, i) => `p${i + 1}`), signals: [] };
  if (layout.panes.length === 0) layout = { ...layout, panes: ['p1'] };
  const unitOf = (c: ScopeSignalCfg): string => specs.find((s) => s.key === c.key)?.unit ?? '';
  for (const s of specs) {
    const idx = Math.min(Math.max(0, units.indexOf(s.unit)), layout.panes.length - 1);
    layout = addSignal(layout, uid48, s.key, s.unit, unitOf, layout.panes[idx], model);
  }
  return layout;
}

/** What is known about the card a uid48 points at; undefined while it is absent or unidentified. */
export interface CardIdentity {
  model: number;
  signals: ReadonlySet<string>;
}

/**
 * Checks a stored layout against the cards on the bus: a signal whose uid48 now belongs to a
 * card of another model, or to a card without that signal key, is dropped (it would otherwise
 * show a raw key bound to the wrong card). Signals of absent cards stay. Kept signals from older
 * files without a model get the card's model, so a later mismatch is caught.
 */
export function reconcileLayout(layout: ScopeLayout, cardOf: (uid48: string) => CardIdentity | undefined): { layout: ScopeLayout; dropped: ScopeSignalCfg[] } {
  const dropped: ScopeSignalCfg[] = [];
  let stamped = false;
  const signals: ScopeSignalCfg[] = [];
  for (const s of layout.signals) {
    const card = cardOf(s.uid48);
    if (!card) signals.push(s);
    else if ((s.model !== undefined && s.model !== card.model) || !card.signals.has(s.key)) dropped.push(s);
    else if (s.model === undefined) {
      signals.push({ ...s, model: card.model });
      stamped = true;
    } else signals.push(s);
  }
  if (dropped.length === 0 && !stamped) return { layout, dropped };
  return { layout: { ...layout, signals }, dropped };
}
