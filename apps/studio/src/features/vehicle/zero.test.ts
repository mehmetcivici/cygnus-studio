import { describe, expect, it } from 'vitest';
import { rotToSignedDeg, zeroEncoders, type ZeroDevice } from './zero';

const dev = (log: string[], name: string, fail = false, model = 'cyncoder'): ZeroDevice =>
  ({
    def: { key: model },
    command: (k: string) => (fail ? Promise.reject(new Error('nak')) : (log.push(`${name} ${k}`), Promise.resolve({}))),
    save: () => (log.push(`${name} save`), Promise.resolve()),
  }) as unknown as ZeroDevice;

describe('zeroEncoders (swerve offset step)', () => {
  it('zeroes then saves every module in order and keeps going after a failure', async () => {
    const log: string[] = [];
    const r = await zeroEncoders([
      { slotId: 'fl.enc', device: dev(log, 'fl'), model: 'cyncoder' },
      { slotId: 'fr.enc', device: dev(log, 'fr', true), model: 'cyncoder' },
      { slotId: 'bl.enc', device: undefined, model: 'cyncoder' },
      { slotId: 'br.enc', device: dev(log, 'br'), model: 'cyncoder' },
    ]);
    expect(log).toEqual(['fl zero_here', 'fl save', 'br zero_here', 'br save']);
    expect(r.ok).toEqual(['fl.enc', 'br.enc']);
    expect(r.failed.map((f) => f.slotId)).toEqual(['fr.enc', 'bl.enc']);
  });

  it('never commands a board whose model is not the bound one (uid48 reused by another card)', async () => {
    const log: string[] = [];
    const r = await zeroEncoders([{ slotId: 'fl.enc', device: dev(log, 'fl', false, 'gyro'), model: 'cyncoder' }]);
    expect(log).toEqual([]);
    expect(r.failed.map((f) => f.slotId)).toEqual(['fl.enc']);
  });

  it('maps rotations to a signed angle', () => {
    expect(rotToSignedDeg(0.25)).toBeCloseTo(90);
    expect(rotToSignedDeg(0.75)).toBeCloseTo(-90);
    expect(rotToSignedDeg(-0.5)).toBeCloseTo(180);
    expect(rotToSignedDeg(1)).toBeCloseTo(0);
  });
});
