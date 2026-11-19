import { describe, expect, it } from 'vitest';
import { setActiveSet, setLoopConfig, storeGainSet, tunerSection } from './project';
import { EMPTY_SECTION, forModel, isTunerSection, loopId, type GainSets } from './types';

const cfg = {
  signal: { kind: 'step' as const, from: 0, to: 1, pre: 0.2, hold: 1, offset: 0, amplitude: 1, period: 1, freq: 1, ramp: 0, f0: 1, f1: 10, sweep: 5, repeats: 1 },
  limits: { maxAmplitude: 1, rangeMin: -1, rangeMax: 1, maxDuration: 5, maxOpen: 0.5 },
};

describe('tuner records follow the card model, not the uid48 alone', () => {
  it('ignores sets and test settings made on another model with the same uid48', () => {
    tunerSection.set(EMPTY_SECTION);
    const id = loopId('0123456789ab', 'vel');
    storeGainSet('0123456789ab', 'vel', 'esc80a', 'B', { kp: 0.5 });
    setLoopConfig('0123456789ab', 'vel', 'esc80a', cfg);
    const s = tunerSection.get();
    expect(isTunerSection(s)).toBe(true);
    expect(forModel(s.sets[id], 'esc80a')?.B).toEqual({ kp: 0.5 });
    expect(forModel(s.sets[id], 'esc20a')).toBeUndefined();
    expect(forModel(s.configs[id], 'esc20a')).toBeUndefined();
    // The other card starts afresh instead of inheriting the B set.
    setActiveSet('0123456789ab', 'vel', 'esc20a', 'B');
    expect(tunerSection.get().sets[id]).toEqual({ A: null, B: null, active: 'B', modelKey: 'esc20a' });
  });

  it('takes older records without a model as they are', () => {
    const old: GainSets = { A: null, B: null, active: 'A' };
    expect(forModel(old, 'esc20a')).toBe(old);
    expect(forModel<GainSets>(undefined, 'esc20a')).toBeUndefined();
  });
});
