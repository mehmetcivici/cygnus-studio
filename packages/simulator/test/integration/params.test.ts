import {
  CyError,
  ParamStatus,
  PType,
  decodeParamValue,
  encodeParamGet,
  encodeParamSet,
  idClass,
  Cls,
  type CanFrame,
  type DeviceHandle,
} from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { createScenario } from '../../src/scenarios';
import { connect, cycanNodes, type Rig } from './harness';

function f32(v: number): number {
  return Math.fround(v);
}

/** Sends a raw PARAM request and returns the board's VALUE answer. */
async function rawParam(r: Rig, d: DeviceHandle, frame: () => ReturnType<typeof encodeParamGet>): Promise<ReturnType<typeof decodeParamValue>> {
  const rx: CanFrame[] = [];
  const off = r.bus.on('frame', (e) => {
    if (e.dir === 'rx' && idClass(e.frame.id) === Cls.PARAM_RSP && (e.frame.id & 0x3f) === d.num && ((e.frame.id >>> 24) & 0x1f) === d.devType) rx.push(e.frame);
  });
  r.bus.send(frame());
  await r.runFor(10);
  off();
  return rx[0] ? decodeParamValue(rx[0].data) : null;
}

describe('host ↔ simulator: parameters', () => {
  it('readAllParams returns every catalog parameter with the board value, for every model', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    for (const n of cycanNodes(sim)) {
      const d = r.dev(n.id);
      let progress = 0;
      const res = await r.settle(d.readAllParams({ onProgress: (p) => (progress = p.done / p.total) }));
      expect(res.failed).toEqual([]);
      expect(progress).toBe(1);
      const board = n.params.toRecord();
      expect(Object.keys(res.values).sort()).toEqual(Object.keys(board).sort());
      for (const [k, v] of Object.entries(board)) {
        const p = n.def.params.find((x) => x.key === k)!;
        expect(res.values[k], `${n.id} ${k}`).toBe(p.ptype === PType.F32 ? f32(v) : v);
        expect(d.cachedParam(k)).toBe(res.values[k]);
      }
    }
    expect(r.bus.currentStats.requestTimeouts).toBe(0);
  });

  it('writes, saves, survives a reboot, and loads defaults', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const node = sim.node('esc80a');
    const d = r.dev('esc80a');
    expect(await r.settle(d.setParam('vel.kp', 0.0123))).toBe(f32(0.0123));
    expect(node.params.getKey('vel.kp')).toBe(f32(0.0123));
    await r.until(() => d.flags.unsaved, 1500, 'UNSAVED flag');
    await r.settle(d.save());
    await r.until(() => !d.flags.unsaved, 1500, 'UNSAVED cleared');
    await r.settle(d.reboot());
    await r.until(() => d.infoLoaded && d.online, 3000, 'board back after reboot');
    expect(await r.settle(d.getParam('vel.kp'))).toBe(f32(0.0123));

    await r.settle(d.setParam('ctrl.timeout_ms', 500));
    await r.settle(d.loadDefaults());
    expect(d.cachedParam('vel.kp')).toBeUndefined();
    const def = node.def.params.find((p) => p.key === 'vel.kp')!.default;
    expect(await r.settle(d.getParam('vel.kp'))).toBe(f32(def));
    expect(await r.settle(d.getParam('ctrl.timeout_ms'))).toBe(200);
    // LOAD_DEFAULTS is RAM only: number and name stay, and a reboot brings the saved value back.
    expect(d.num).toBe(2);
    await r.settle(d.reboot());
    await r.until(() => d.infoLoaded && d.online, 3000, 'board back after reboot');
    expect(d.name).toBe('ESC 80A');
    expect(await r.settle(d.getParam('vel.kp'))).toBe(f32(0.0123));
  });

  it('rename persists with save', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('gyro');
    await r.settle(d.rename('Şasi jiroskobu'));
    expect(sim.node('gyro').nameText).toBe('Şasi jiroskobu');
    await r.settle(d.save());
    await r.settle(d.reboot());
    await r.until(() => d.infoLoaded && d.online, 3000, 'board back');
    expect(d.name).toBe('Şasi jiroskobu');
  });

  it('every rejection status: host-side checks and board answers', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc80a');
    // Host refuses before sending.
    expect(await r.caught(d.setParam('ctrl.timeout_ms', 5))).toMatchObject({ code: 'INVALID', reason: 'out_of_range' });
    expect(await r.caught(d.setParam('can.termination', 1))).toMatchObject({ code: 'INVALID' });
    expect(await r.caught(d.getParam('no.such'))).toMatchObject({ code: 'INVALID', reason: 'unknown_param' });

    // Board-side statuses on the wire.
    const addr = { devType: d.devType, num: d.num };
    expect((await rawParam(r, d, () => encodeParamGet(addr, { pid: 0x0fff })))?.status).toBe(ParamStatus.UNKNOWN_PARAM);
    expect((await rawParam(r, d, () => encodeParamSet(addr, { pid: 0x0003, ptype: PType.F32, value: 300 })))?.status).toBe(ParamStatus.TYPE_MISMATCH);
    const oor = await rawParam(r, d, () => encodeParamSet(addr, { pid: 0x0003, ptype: PType.U32, value: 5 }));
    expect(oor).toMatchObject({ status: ParamStatus.OUT_OF_RANGE, value: 200 });
    expect((await rawParam(r, d, () => encodeParamSet(addr, { pid: 0x0002, ptype: PType.BOOL, value: 1 })))?.status).toBe(ParamStatus.READ_ONLY);

    // DENIED_WHILE_ENABLED through the host API, while the motor is driven.
    const loop = d.control.start('duty', 0.1);
    await r.until(() => d.flags.enabled, 1500, 'ENABLED');
    const e = await r.caught(d.setParam('motor.pole_pairs', 3));
    expect(e).toBeInstanceOf(CyError);
    expect(e).toMatchObject({ code: 'REJECTED', status: ParamStatus.DENIED_WHILE_ENABLED, statusKind: 'param' });
    expect(d.cachedParam('motor.pole_pairs')).toBe(7);
    loop.stop();
    await r.until(() => !d.flags.enabled, 1500, 'not ENABLED');
    expect(await r.settle(d.setParam('motor.pole_pairs', 3))).toBe(3);
  });
});
