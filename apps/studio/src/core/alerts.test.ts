import { describe, expect, it } from 'vitest';
import type { BusStats } from '@cygnus/protocol';
import { createScenario } from '@cygnus/simulator';
import { AlertTracker, simFeedMap, type AlertDevice, type AlertInput } from './alerts';

const stats = (o: Partial<BusStats> = {}): BusStats => ({ rxFps: 500, txFps: 20, loadPct: 20, rxTotal: 0, txTotal: 0, enumTimeouts: 0, requestTimeouts: 0, windowMs: 1000, ...o });
const dev = (uid48: string, o: Partial<AlertDevice> = {}): AlertDevice => ({ uid48, name: '', num: 1, online: true, status: 'ok', faults: { list: [] }, label: uid48, ...o });
const input = (o: Partial<AlertInput>): AlertInput => ({ now: 0, phase: 'connected', connectedFor: 10_000, stats: stats(), devices: [], estopLatched: false, ...o });

describe('AlertTracker (tasarim B5–B8)', () => {
  it('reports a shorted / silent bus as one danger alert instead of N lost boards', () => {
    const tr = new AlertTracker();
    tr.update(input({ devices: [dev('a'), dev('b')] }));
    const short = tr.update(input({ now: 100, simShorted: true, stats: stats({ rxFps: 0 }), devices: [dev('a', { online: false }), dev('b', { online: false })] }));
    expect(short.map((a) => a.id)).toEqual(['bus.short']);
    const silent = tr.update(input({ now: 200, stats: stats({ rxFps: 0 }), devices: [dev('a', { online: false }), dev('b', { online: false })] }));
    expect(silent.map((a) => a.id)).toEqual(['bus.silent']);
  });

  it('warns about saturation, request timeouts and a single lost board', () => {
    const tr = new AlertTracker();
    tr.update(input({ devices: [dev('a'), dev('b')] }));
    const r = tr.update(input({ now: 1000, stats: stats({ loadPct: 92, requestTimeouts: 9 }), devices: [dev('a'), dev('b', { online: false })] }));
    expect(r.map((a) => a.id).sort()).toEqual(['bus.load', 'bus.timeouts', 'lost.b']);
    expect(r.find((a) => a.id === 'bus.load')?.params).toEqual({ pct: 92 });
  });

  it('ties a lost board to the fuse feeding it (simulator wiring)', () => {
    const tr = new AlertTracker();
    const pdh = (mask: number) => dev('p', { signals: { 'fuse.mask': mask }, label: 'PDH' });
    tr.update(input({ devices: [pdh(0), dev('e')] }));
    const r = tr.update(input({ now: 500, devices: [pdh(0b100), dev('e', { online: false })], feedOf: (u) => (u === 'e' ? { pdh: 'p', ch: 3 } : null) }));
    expect(r.find((a) => a.id === 'fuse.p.3')?.params).toEqual({ name: 'PDH', ch: 3 });
    const lost = r.find((a) => a.id === 'lost.e');
    expect(lost?.detailKey).toBe('core.alerts.lostByFuse');
    expect(lost?.detailParams).toEqual({ pdh: 'PDH', ch: 3 });
  });

  it('on hardware only notes a fuse that blew at about the same time', () => {
    const tr = new AlertTracker();
    const pdh = (mask: number) => dev('p', { signals: { 'fuse.mask': mask }, label: 'PDH' });
    tr.update(input({ devices: [pdh(0), dev('e'), dev('f')] }));
    tr.update(input({ now: 1000, devices: [pdh(1), dev('e', { online: false }), dev('f')] }));
    const r = tr.update(input({ now: 10_000, devices: [pdh(1), dev('e', { online: false }), dev('f', { online: false })] }));
    expect(r.find((a) => a.id === 'lost.e')?.detailKey).toBe('core.alerts.lostNearFuse');
    expect(r.find((a) => a.id === 'lost.f')?.detailKey).toBeUndefined();
  });

  it('maps simulator boards to their distribution channel', () => {
    const sim = createScenario('all.devices', { seed: 1 });
    const feedOf = simFeedMap(sim);
    const hex = (n: number) => n.toString(16).padStart(12, '0');
    const fed = sim.nodes.map((n) => feedOf(hex(n.uid48))).filter((x) => x !== null);
    expect(fed.length).toBeGreaterThan(0);
    for (const f of fed) expect(f.ch).toBeGreaterThanOrEqual(1);
  });
});
