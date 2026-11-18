import { describe, expect, it } from 'vitest';
import {
  MAX_SIGNALS,
  addPane,
  addSignal,
  defaultLayout,
  groupedLayout,
  isScopeLayout,
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
