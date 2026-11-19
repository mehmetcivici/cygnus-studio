import { describe, expect, it } from 'vitest';
import {
  MAX_SIGNALS,
  addPane,
  addSignal,
  defaultLayout,
  groupedLayout,
  isScopeLayout,
  reconcileLayout,
  moveSignal,
  removePane,
  setAxis,
  type ScopeSignalCfg,
} from './layout';

const UNITS: Record<string, string> = { v1: 'V', v2: 'V', a1: 'A', t1: '°C', t2: '°C' };
const unitOf = (s: ScopeSignalCfg): string => UNITS[s.key] ?? '';
const add = (l: ReturnType<typeof defaultLayout>, key: string, pane?: string) => addSignal(l, 'u1', key, UNITS[key] ?? '', unitOf, pane);

describe('axis assignment', () => {
  it('puts the same unit on the same axis and a new unit on the right', () => {
    let l = add(defaultLayout(), 'v1');
    l = add(l, 'a1');
    l = add(l, 'v2');
    const by = Object.fromEntries(l.signals.map((s) => [s.key, s.axis]));
    expect(by).toEqual({ v1: 'left', a1: 'right', v2: 'left' });
  });

  it('moves all signals of a unit together when the axis changes', () => {
    let l = add(add(add(defaultLayout(), 'v1'), 'v2'), 'a1');
    const id = l.signals.find((s) => s.key === 'v1')?.id ?? '';
    l = setAxis(l, id, 'right', unitOf);
    const by = Object.fromEntries(l.signals.map((s) => [s.key, s.axis]));
    expect(by.v1).toBe('right');
    expect(by.v2).toBe('right');
    expect(by.a1).toBe('right');
  });

  it('re-derives the axis when a signal moves to another pane', () => {
    let l = addPane(defaultLayout());
    l = add(l, 'v1', 'p1');
    l = add(l, 'a1', 'p1');
    l = add(l, 'v2', 'p2');
    l = moveSignal(l, l.signals.find((s) => s.key === 'a1')?.id ?? '', 'p2', unitOf);
    expect(l.signals.find((s) => s.key === 'a1')).toMatchObject({ pane: 'p2', axis: 'right' });
  });
});

describe('layout editing', () => {
  it('assigns distinct colors and refuses duplicates and overflow', () => {
    let l = add(add(defaultLayout(), 'v1'), 'v1');
    expect(l.signals).toHaveLength(1);
    l = add(l, 'v2');
    expect(new Set(l.signals.map((s) => s.color)).size).toBe(2);
    let big = defaultLayout();
    for (let i = 0; i < MAX_SIGNALS + 3; i++) big = addSignal(big, 'u', `k${i}`, 'V', unitOf);
    expect(big.signals).toHaveLength(MAX_SIGNALS);
  });

  it('removes a pane by moving its signals to the first one, never the last pane', () => {
    let l = addPane(defaultLayout());
    l = add(l, 'v1', 'p1');
    l = add(l, 'a1', 'p2');
    l = removePane(l, 'p2', unitOf);
    expect(l.panes).toEqual(['p1']);
    expect(l.signals.every((s) => s.pane === 'p1')).toBe(true);
    expect(removePane(l, 'p1', unitOf).panes).toEqual(['p1']);
  });

  it('builds a recommended layout with one pane per unit', () => {
    const l = groupedLayout('u1', [
      { key: 'v1', unit: 'V' },
      { key: 'a1', unit: 'A' },
      { key: 'v2', unit: 'V' },
    ]);
    expect(l.panes).toEqual(['p1', 'p2']);
    expect(l.signals.filter((s) => s.pane === 'p1').map((s) => s.key)).toEqual(['v1', 'v2']);
    expect(l.signals.find((s) => s.key === 'a1')?.pane).toBe('p2');
  });
});

describe('isScopeLayout', () => {
  it('accepts a saved layout and rejects damaged ones', () => {
    const l = add(defaultLayout(), 'v1');
    expect(isScopeLayout(JSON.parse(JSON.stringify(l)))).toBe(true);
    expect(isScopeLayout({ ...l, panes: [] })).toBe(false);
    expect(isScopeLayout({ ...l, signals: [{ ...l.signals[0], pane: 'nope' }] })).toBe(false);
    expect(isScopeLayout(null)).toBe(false);
    expect(isScopeLayout({ ...l, windowS: 'x' })).toBe(false);
  });
});

describe('saved layout vs. the cards on the bus', () => {
  const esc = { model: 0x11, signals: new Set(['v1', 'a1']) };
  const base = (): ReturnType<typeof defaultLayout> => {
    let l = addSignal(defaultLayout(), 'u1', 'v1', 'V', unitOf, undefined, 0x11);
    l = addSignal(l, 'u1', 'a1', 'A', unitOf, undefined, 0x11);
    return addSignal(l, 'u2', 't1', '°C', unitOf);
  };

  it('keeps a layout whose cards match, and signals of absent cards', () => {
    const l = base();
    const r = reconcileLayout(l, (u) => (u === 'u1' ? esc : undefined));
    expect(r.dropped).toEqual([]);
    expect(r.layout).toBe(l);
  });

  it('drops signals whose uid48 now belongs to a card of another model or without that key', () => {
    const other = { model: 0x30, signals: new Set(['v1', 't1']) };
    const r = reconcileLayout(base(), (u) => (u === 'u1' ? other : u === 'u2' ? esc : undefined));
    expect(r.dropped.map((s) => s.id).sort()).toEqual(['u1/a1', 'u1/v1', 'u2/t1']);
    expect(r.layout.signals).toEqual([]);
    expect(isScopeLayout(r.layout)).toBe(true);
  });

  it('binds signals of older files (no model) to the card they matched', () => {
    const l = addSignal(defaultLayout(), 'u1', 'v1', 'V', unitOf);
    expect(l.signals[0]?.model).toBeUndefined();
    const r = reconcileLayout(l, () => esc);
    expect(r.dropped).toEqual([]);
    expect(r.layout.signals[0]?.model).toBe(0x11);
    expect(isScopeLayout(r.layout)).toBe(true);
    expect(isScopeLayout({ ...r.layout, signals: [{ ...r.layout.signals[0], model: 'x' }] })).toBe(false);
  });
});
