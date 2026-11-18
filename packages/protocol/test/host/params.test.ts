import { describe, expect, it } from 'vitest';
import { getModel } from '../../src/catalog/catalog';
import { Cls, CommandStatus, Model, ParamStatus } from '../../src/core/constants';
import { idClass } from '../../src/core/id';
import { CyError } from '../../src/host/errors';
import { settle, run } from '../helpers/fake-bus';
import { caught, rig } from '../helpers/setup';

describe('parameters', () => {
  it('reads and writes values, caches them and emits paramChanged', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 30, num: 1 });
    const h = await r.ready(n);
    const changes: string[] = [];
    h.on('paramChanged', (c) => changes.push(`${c.key}=${c.value}`));
    expect(await settle(r.sched, h.getParam('motor.pole_pairs'))).toBe(7);
    expect(h.cachedParam('motor.pole_pairs')).toBe(7);
    expect(await settle(r.sched, h.setParam('vel.kp', 0.5))).toBeCloseTo(0.5);
    expect(n.param('vel.kp')).toBeCloseTo(0.5);
    expect(h.params.get('vel.kp')).toBeCloseTo(0.5);
    expect(changes).toEqual(['motor.pole_pairs=7', 'vel.kp=0.5']);
    // The board now reports unsaved changes; save clears that.
    await run(r.sched, 600);
    expect(h.flags.unsaved).toBe(true);
    await settle(r.sched, h.save());
    await run(r.sched, 600);
    expect(h.flags.unsaved).toBe(false);
  });

  it('checks type and range on the host before sending', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 31, num: 1 });
    const h = await r.ready(n);
    const sent = r.transport.sent.length;
    expect(await caught(h.setParam('motor.pole_pairs', 99))).toMatchObject({ code: 'INVALID', reason: 'out_of_range' });
    expect(await caught(h.setParam('motor.pole_pairs', 2.5))).toMatchObject({ code: 'INVALID', reason: 'not_integer' });
    expect(await caught(h.setParam('can.termination', 1))).toMatchObject({ code: 'INVALID', reason: 'read_only' });
    expect(await caught(h.setParam('motor.idle_mode', 7))).toMatchObject({ code: 'INVALID', reason: 'invalid_option' });
    expect(await caught(h.getParam('no.such'))).toMatchObject({ code: 'INVALID', reason: 'unknown_param' });
    expect(r.transport.sent.length).toBe(sent);
  });

  it('turns board statuses into typed errors and keeps the value the board reports', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 32, num: 1 });
    const h = await r.ready(n);
    n.enabled = true;
    const e = await caught(settle(r.sched, h.setParam('motor.pole_pairs', 8)));
    expect(e).toBeInstanceOf(CyError);
    expect(e).toMatchObject({ code: 'REJECTED', status: ParamStatus.DENIED_WHILE_ENABLED, statusKind: 'param' });
    expect((e as CyError).statusLabel?.en).toBe('Locked while enabled');
    expect(h.cachedParam('motor.pole_pairs')).toBe(7);
  });

  it('retries on timeout and gives up after three attempts', async () => {
    const r = await rig();
    const n = r.node({ model: Model.CYNCODER, seed: 33, num: 1 });
    const h = await r.ready(n);
    const before = r.bus.currentStats.requestTimeouts;
    n.dropParamGets = 2;
    expect(await settle(r.sched, h.getParam('can.data_bitrate'))).toBe(1);
    n.dropParamGets = 3;
    const t0 = r.sched.now();
    expect(await caught(settle(r.sched, h.getParam('can.data_bitrate')))).toMatchObject({ code: 'TIMEOUT' });
    expect(r.sched.now() - t0).toBeGreaterThanOrEqual(300);
    await run(r.sched, 1000);
    expect(r.bus.currentStats.requestTimeouts - before).toBe(5);
  });

  it('reads every parameter with a request window and reports progress', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_80A, seed: 34, num: 1 });
    const h = await r.ready(n);
    n.dropParamGets = 3;
    const progress: number[] = [];
    const t0 = r.sched.now();
    const res = await settle(r.sched, h.readAllParams({ onProgress: (p) => progress.push(p.done) }));
    const total = getModel(Model.ESC_80A)!.params.length;
    expect(Object.keys(res.values)).toHaveLength(total);
    expect(res.failed).toEqual([]);
    expect(progress.at(-1)).toBe(total);
    expect(res.values['limits.phase_current_a']).toBeCloseTo(n.param('limits.phase_current_a')!);
    // Pipelined: far faster than one round trip after another.
    expect(r.sched.now() - t0).toBeLessThan(total * 2);
    // The three dropped GETs were retransmitted.
    const gets = r.wire.hostFrames().filter((f) => idClass(f.id) === Cls.PARAM_REQ);
    expect(gets.length).toBe(total + 3);
  });

  it('renames the board and invalidates the cache on load defaults', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 35, num: 1 });
    const h = await r.ready(n);
    await settle(r.sched, h.rename('Sağ arka itici'));
    expect(n.nameText).toBe('Sağ arka itici');
    expect(h.name).toBe('Sağ arka itici');
    await settle(r.sched, h.setParam('vel.kp', 0.25));
    let invalidated = 0;
    h.on('paramsInvalidated', () => invalidated++);
    await settle(r.sched, h.loadDefaults());
    expect(invalidated).toBe(1);
    expect(h.cachedParam('vel.kp')).toBeUndefined();
    expect(await settle(r.sched, h.getParam('vel.kp'))).toBeCloseTo(getModel(Model.ESC_20A)!.params.find((p) => p.key === 'vel.kp')!.default);
  });
});

describe('commands', () => {
  it('follows IN_PROGRESS to the final result and decodes self-test bits', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 40, num: 1 });
    const h = await r.ready(n);
    n.selfTestMask = 0b101;
    let progress = 0;
    const st = await settle(r.sched, h.selfTest({ onProgress: () => progress++ }));
    expect(progress).toBe(1);
    expect(st.passed).toBe(false);
    expect(st.mask).toBe(5);
    expect(st.failed.map((b) => b.key)).toEqual(['gate_driver', 'voltage_sense']);
    n.selfTestMask = 0;
    expect((await settle(r.sched, h.selfTest())).passed).toBe(true);
  });

  it('runs catalog actions by key and validates arguments', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 41, num: 1 });
    const h = await r.ready(n);
    const res = await settle(r.sched, h.command('measure_motor'));
    expect(res).toMatchObject({ status: CommandStatus.OK, result: 1 });
    await settle(r.sched, h.command('set_position', 1.5));
    expect(await caught(h.command('set_position', 1e9))).toMatchObject({ code: 'INVALID', reason: 'out_of_range' });
    expect(await caught(h.command('no_such'))).toMatchObject({ code: 'INVALID' });
  });

  it('maps failure statuses and long-running timeouts', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 42, num: 1 });
    const h = await r.ready(n);
    expect(await caught(settle(r.sched, h.command(0x7f)))).toMatchObject({ code: 'REJECTED', status: CommandStatus.UNSUPPORTED });
    n.commandScripts.set(0x41, { status: CommandStatus.FAILED, delayMs: 50 });
    expect(await caught(settle(r.sched, h.command('measure_motor')))).toMatchObject({ code: 'REJECTED', status: CommandStatus.FAILED });
    n.commandScripts.set(0x41, { status: CommandStatus.OK, delayMs: 5000 });
    expect(await caught(settle(r.sched, h.command('measure_motor', 0, { finalTimeoutMs: 1000 })))).toMatchObject({ code: 'TIMEOUT' });
  });

  it('reads faults resolved through the catalog and clears sticky ones', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 43, num: 1 });
    const h = await r.ready(n);
    n.faults = { active: 1 << 3, sticky: (1 << 3) | (1 << 12), warn: 1 << 4 };
    await run(r.sched, 700);
    // The heartbeat fault change triggers a FAULT_REQ in the background.
    expect(h.faults.sticky).toBe((1 << 3) | (1 << 12));
    expect(h.faults.list.map((f) => `${f.kind}:${f.key}`)).toEqual([
      'active:overtemp',
      'sticky:overtemp',
      'sticky:locked_rotor',
      'warn:ctrl_timeout',
    ]);
    await settle(r.sched, h.clearFaults());
    expect(n.faults.sticky).toBe(0);
    expect(h.faults.sticky).toBe(0);
    h.identify(3);
    await run(r.sched, 2);
    expect(n.identifySeconds).toBe(3);
  });
});

describe('late answers (review host-sim #2)', () => {
  it('does not hand a retransmitted SET answer to the next SET of the same parameter', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 320, num: 1 });
    const h = await r.ready(n);
    // The first PARAM answer is slow (130 ms, so the host retransmits), later ones take 20 ms.
    let first = true;
    r.wire.delay = (f, from) => {
      if (from !== 'node' || idClass(f.id) !== Cls.PARAM_RSP) return 0;
      if (first) {
        first = false;
        return 130;
      }
      return 20;
    };
    const a = h.setParam('vel.kp', 0.001);
    const b = h.setParam('vel.kp', 0.002);
    const vb = await settle(r.sched, b);
    expect(await a).toBeCloseTo(0.001, 6);
    expect(vb).toBeCloseTo(0.002, 6);
    await run(r.sched, 300);
    expect(n.param('vel.kp')).toBeCloseTo(0.002, 6);
    expect(h.cachedParam('vel.kp')).toBeCloseTo(0.002, 6);
  });

  it('keeps GETs apart in the same way', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 321, num: 1 });
    const h = await r.ready(n);
    let first = true;
    r.wire.delay = (f, from) => {
      if (from !== 'node' || idClass(f.id) !== Cls.PARAM_RSP) return 0;
      if (first) {
        first = false;
        return 130;
      }
      return 20;
    };
    const a = h.getParam('vel.kp');
    await settle(r.sched, a);
    // The board changes the value (another host); the stale answer of the first GET is still in flight.
    n.params.set(getModel(Model.ESC_20A)!.params.find((p) => p.key === 'vel.kp')!.pid, Math.fround(0.004));
    const b = await settle(r.sched, h.getParam('vel.kp'));
    expect(b).toBeCloseTo(0.004, 6);
  });
});

describe('loadSaved', () => {
  it('reloads the saved parameters and drops the cache', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 322, num: 1 });
    const h = await r.ready(n);
    const saved = n.param('vel.kp');
    await settle(r.sched, h.setParam('vel.kp', 0.0042));
    let invalidated = 0;
    h.on('paramsInvalidated', () => invalidated++);
    await settle(r.sched, h.loadSaved());
    expect(invalidated).toBe(1);
    expect(h.cachedParam('vel.kp')).toBeUndefined();
    expect(n.param('vel.kp')).toBe(saved);
    expect(n.unsaved).toBe(false);
  });
});
