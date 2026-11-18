import { describe, expect, it } from 'vitest';
import { Model } from '../../src/core/constants';
import { run, settle } from '../helpers/fake-bus';
import { FakeNode } from '../helpers/fake-node';
import { CyncoderV3Device } from '../../src/legacy';
import { legacyRig } from './rig';

describe('CyCAN and Cyncoder v3 on one CygnusBus', () => {
  it('discovers both families side by side and keeps each protocol working', async () => {
    const r = await legacyRig();
    // A CyCAN Cyncoder and a legacy Cyncoder deliberately share CAN number 3.
    const cycan = new FakeNode(r.wire, { model: Model.CYNCODER, seed: 5, num: 3, status: true });
    const esc = new FakeNode(r.wire, { model: Model.ESC_20A, seed: 6, num: 3 });
    const old = r.board({ uid: 0xdeadbeef, num: 3 });
    old.positionDeg = 45;
    await run(r.sched, 2500);

    const all = r.bus.devices;
    expect(all.map((d) => [d.driver, d.devType, d.num])).toEqual([
      ['cycan', 2, 3],
      ['cycan', 7, 3],
      ['cyncoder-v3', 10, 3],
    ]);
    const v3 = all.find((d) => d.driver === 'cyncoder-v3') as CyncoderV3Device;
    const sibling = r.bus.deviceByUid(cycan.uid48);
    expect(sibling?.def?.key).toBe('cyncoder');
    // Lookups by address belong to CyCAN; the legacy board is found through its driver.
    expect(r.bus.device(10, 3)).toBeUndefined();
    expect(r.legacy.deviceByUid('deadbeef')).toBe(v3);

    // CyCAN parameter traffic is untouched by the legacy driver.
    const escHandle = r.bus.deviceByUid(esc.uid48);
    expect(await settle(r.sched, escHandle!.getParam('motor.pole_pairs'))).toBe(7);
    // The legacy board reads its own telemetry and obeys its command.
    expect(v3.getSignal('position.deg')).toBeCloseTo(45, 3);
    expect((await settle(r.sched, v3.command('blink'))).confirmed).toBe(true);
    expect(old.blinks).toBe(1);

    // CyCAN boards were never confused by the legacy frames, and nothing lost its place.
    expect(r.bus.unresolved).toHaveLength(0);
    expect(all.every((d) => d.online)).toBe(true);
  });

  it('describes legacy frames in the CAN monitor and leaves CyCAN frames to the standard decoder', async () => {
    const r = await legacyRig();
    const frames: Array<{ id: number; data: Uint8Array }> = [];
    r.bus.on('frame', (e) => {
      if (e.dir === 'rx') frames.push(e.frame);
    });
    new FakeNode(r.wire, { model: Model.ESC_20A, seed: 6, num: 2 });
    const old = r.board({ uid: 0xdeadbeef, num: 4 });
    old.positionDeg = 12.5;
    await run(r.sched, 700);
    const pos = frames.find((f) => (f.id & 0x1fffffff) === ((10 << 24) | (8 << 16) | 4));
    expect(pos).toBeDefined();
    const d = r.bus.describeFrame({ ...(pos as { id: number; data: Uint8Array }), fd: false, brs: false, timestamp: 0 }, 'en');
    expect(d.protocol).toBe('cyncoder-v3');
    expect(d.dir).toBe('fromDevice');
    expect(d.indexName).toBe('POSITION_VELOCITY');
    expect(d.address).toBe('Cyncoder v3 #4');
    expect(d.fields.map((f) => f.key)).toEqual(['positionDeg', 'velocityDps']);
    const cy = frames.find((f) => ((f.id >>> 10) & 0x3f) === 0x13);
    expect(cy).toBeDefined();
    expect(r.bus.describeFrame({ ...(cy as { id: number; data: Uint8Array }), fd: false, brs: false, timestamp: 0 }).protocol).toBe('cycan');
  });

  it('keeps the legacy board quiet on CyCAN broadcast traffic (E-stop, enumeration)', async () => {
    const r = await legacyRig();
    const old = r.board({ uid: 0xdeadbeef, num: 4 });
    await run(r.sched, 700);
    r.bus.estop();
    await run(r.sched, 1200);
    expect(old.applied).toHaveLength(0);
  });
});
