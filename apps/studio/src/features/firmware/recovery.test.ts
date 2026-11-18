import { describe, expect, it } from 'vitest';
import { rebootOthers, recoveryStep } from './recovery';

describe('recovery mode helpers', () => {
  it('restarts every waiting board except the flashed ones and counts failures', async () => {
    const log: string[] = [];
    const dev = (uid48: string, fail = false) => ({ uid48, reboot: () => (log.push(uid48), fail ? Promise.reject(new Error('x')) : Promise.resolve()) });
    const r = await rebootOthers([dev('a'), dev('b'), dev('c', true)], new Set(['b']));
    expect(log).toEqual(['a', 'c']);
    expect(r).toEqual({ rebooted: 1, failed: 1 });
  });

  it('walks intro → listening → flashing → finished', () => {
    expect(recoveryStep(false, 0, false, false)).toBe('intro');
    expect(recoveryStep(true, 0, false, false)).toBe('listening');
    expect(recoveryStep(false, 2, false, false)).toBe('listening');
    expect(recoveryStep(false, 2, true, false)).toBe('flashing');
    expect(recoveryStep(false, 0, false, true)).toBe('finished');
  });
});
