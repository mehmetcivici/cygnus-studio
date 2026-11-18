import { describe, expect, it } from 'vitest';
import { Cls } from '@cygnus/protocol';
import { composeId, ctrlGate, periodicLimitMs, sendRisks } from './ids';

const boards = [
  { uid48: 'aaaaaaaaaaaa', devType: 2, num: 1, legacy: false, online: true },
  { uid48: 'bbbbbbbbbbbb', devType: 2, num: 2, legacy: false, online: false },
];

describe('CTRL frames from the send panel (uygulama #3)', () => {
  it('ties a CTRL frame to the one online board it addresses', () => {
    const id = composeId({ devType: 2, mfr: 8, cls: Cls.CTRL, index: 0, num: 1 });
    expect(sendRisks(id)).toContain('ctrl');
    expect(ctrlGate(id, boards)).toEqual({ kind: 'target', uid48: 'aaaaaaaaaaaa' });
  });

  it('refuses broadcast CTRL and CTRL to a missing or offline board', () => {
    expect(ctrlGate(composeId({ devType: 2, mfr: 8, cls: Cls.CTRL, index: 0, num: 0 }), boards)).toEqual({ kind: 'blocked', reason: 'broadcast' });
    expect(ctrlGate(composeId({ devType: 2, mfr: 8, cls: Cls.CTRL, index: 0, num: 2 }), boards)).toEqual({ kind: 'blocked', reason: 'noBoard' });
    expect(ctrlGate(composeId({ devType: 2, mfr: 8, cls: Cls.CTRL, index: 0, num: 9 }), boards)).toEqual({ kind: 'blocked', reason: 'noBoard' });
  });

  it('leaves other classes alone', () => {
    expect(ctrlGate(composeId({ devType: 2, mfr: 8, cls: Cls.SYS_REQ, index: 3, num: 1 }), boards)).toEqual({ kind: 'none' });
    expect(ctrlGate(null, boards)).toEqual({ kind: 'none' });
  });

  it('caps periodic sending, tighter for CTRL', () => {
    expect(periodicLimitMs(true)).toBeLessThan(periodicLimitMs(false));
    expect(periodicLimitMs(true)).toBeLessThanOrEqual(10_000);
  });
});
