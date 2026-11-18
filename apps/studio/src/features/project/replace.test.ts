import { getModel, Model } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import type { ProjectDevice } from '../../core';
import { installReplacement, type ReplaceBus, type ReplaceTarget } from './replace';

const def = getModel(Model.ESC_80A);
const project: ProjectDevice = { uid48: 'old', driver: 'cycan', model: Model.ESC_80A, modelKey: 'esc80a', devType: 2, num: 3, name: 'Sol', fw: '1.0.0', params: { 'vel.kp': 0.5, 'vel.ki': 0.25, 'motor.invert': 1 } };

function setup(cardValues: Record<string, number>, o: { assignFails?: boolean; name?: string } = {}) {
  const calls: string[] = [];
  const bus: ReplaceBus = {
    assignId: async (uid, num, opts) => {
      calls.push(`assign ${uid} ${num} force=${opts.force} persist=${opts.persist}`);
      if (o.assignFails) throw new Error('taken');
    },
    forget: (uid) => {
      calls.push(`forget ${uid}`);
      return true;
    },
  };
  const target = {
    uid48: 'new',
    num: 63 as number,
    name: o.name ?? '',
    readAllParams: async () => {
      calls.push('read');
      return { values: cardValues, failed: [] };
    },
    setParam: async (k: string, v: number) => {
      calls.push(`set ${k}=${v}`);
      return v;
    },
    rename: async (n: string) => void calls.push(`rename ${n}`),
    save: async () => void calls.push('save'),
  };
  return { bus, target: target satisfies ReplaceTarget, calls };
}

describe('installReplacement', () => {
  it('numbers the spare first (forced), writes only what differs, saves, then forgets the dead board', async () => {
    const { bus, target, calls } = setup({ 'vel.kp': 0.5, 'vel.ki': 0, 'motor.invert': 0 });
    const r = await installReplacement(bus, target, project, def);
    expect(calls).toEqual(['assign new 3 force=true persist=true', 'read', 'rename Sol', 'set motor.invert=1', 'set vel.ki=0.25', 'save', 'forget old']);
    expect(r.summary).toMatchObject({ written: 3, failed: 0, saved: true });
  });

  it('skips the number when the spare already has it and keeps the dead board listed on failures', async () => {
    const { bus, target, calls } = setup({ 'vel.kp': 0, 'vel.ki': 0.25, 'motor.invert': 1 }, { name: 'Sol' });
    target.num = 3;
    const r = await installReplacement(bus, target, project, def);
    expect(calls).toEqual(['read', 'set vel.kp=0.5', 'save', 'forget old']);
    expect(r.numberSet).toBe(true);
  });

  it('stops before touching anything when the number cannot be assigned', async () => {
    const { bus, target, calls } = setup({}, { assignFails: true });
    const r = await installReplacement(bus, target, project, def);
    expect(r.numberSet).toBe(false);
    expect(r.summary).toBeNull();
    expect(calls).toEqual(['assign new 3 force=true persist=true']);
  });
});
