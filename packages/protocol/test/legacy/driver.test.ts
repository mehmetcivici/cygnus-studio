import { describe, expect, it } from 'vitest';
import { DeviceState } from '../../src/core/constants';
import type { CanFrame } from '../../src/core/frame';
import { CyError } from '../../src/host/errors';
import type { DeviceHandle } from '../../src/host/types';
import {
  CYNCODER_V3_DEF,
  CyncoderV3Device,
  V3Ack,
  v3Id,
  V3Class,
  V3Telemetry,
} from '../../src/legacy';
import { flush, run, settle } from '../helpers/fake-bus';
import { caught } from '../helpers/setup';
import { legacyRig } from './rig';

const UID_A = 0x1234abcd;
const UID_B = 0x00c0ffee;

function injected(num: number, index: number, data: number[]): CanFrame {
  return { id: v3Id(V3Class.TELEMETRY, index, num), data: Uint8Array.from(data), fd: false, brs: false, timestamp: 0 };
}

describe('Cyncoder v3 discovery', () => {
  it('discovers a board from its UID frame and exposes it as a DeviceHandle', async () => {
    const r = await legacyRig();
    const added: DeviceHandle[] = [];
    r.bus.on('deviceAdded', (d) => added.push(d));
    r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 700);
    expect(added).toHaveLength(1);
    const d = added[0] as CyncoderV3Device;
    expect(d.driver).toBe('cyncoder-v3');
    expect(d.uid48).toBe('00001234abcd');
    expect(d.devType).toBe(10);
    expect(d.num).toBe(15);
    expect(d.def).toBe(CYNCODER_V3_DEF);
    expect(d.def?.key).toBe('cyncoder_v3');
    expect(d.catalogStatus).toBe('ok');
    expect(d.online).toBe(true);
    expect(r.bus.devices).toEqual([d]);
    expect(d.capabilities).toEqual({
      params: false,
      signals: true,
      stream: false,
      control: false,
      commands: true,
      faults: false,
      firmware: false,
      rename: false,
      identify: true,
      assignId: false,
    });
  });

  it('keeps two boards on the same CAN number apart by UID and withholds ambiguous telemetry', async () => {
    const r = await legacyRig();
    const a = r.board({ uid: UID_A, num: 15 });
    const b = r.board({ uid: UID_B, num: 15 });
    a.positionDeg = 10;
    b.positionDeg = 200;
    await run(r.sched, 700);
    const [da, db] = [r.legacy.deviceByUid(UID_A), r.legacy.deviceByUid(UID_B)];
    expect(da).toBeDefined();
    expect(db).toBeDefined();
    expect(r.legacy.devicesAt(15)).toHaveLength(2);
    expect(da?.conflict).toBe(true);
    expect(db?.conflict).toBe(true);
    expect(Number.isNaN(da?.getSignal('position.deg') ?? 0)).toBe(true);

    // Board B is renumbered (SET_CONFIG on the bus): both leave the conflict and read their own telemetry.
    b.num = 16;
    await run(r.sched, 700);
    expect(db?.num).toBe(16);
    expect(da?.conflict).toBe(false);
    expect(db?.conflict).toBe(false);
    expect(da?.getSignal('position.deg')).toBeCloseTo(10, 3);
    expect(db?.getSignal('position.deg')).toBeCloseTo(200, 3);
  });

  it('claims v3 frames so the CyCAN driver builds no device from them', async () => {
    const r = await legacyRig();
    const seen: number[] = [];
    r.bus.on('frame', (e) => seen.push(e.frame.id));
    r.board({ uid: UID_A, num: 1 });
    await run(r.sched, 600);
    expect(seen.length).toBeGreaterThan(0);
    expect([...r.bus.cycan.devices()]).toHaveLength(0);
    expect(r.bus.devices).toHaveLength(1);
  });
});

describe('Cyncoder v3 signals', () => {
  it('decodes known byte sequences', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 7 });
    await run(r.sched, 600);
    b.muteTelemetry();
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    // 90.0 deg = 0x42B40000, 60.0 deg/s = 0x42700000 (little-endian).
    r.wire.fromNode({ receive: () => undefined }, injected(7, V3Telemetry.POSITION_VELOCITY, [0x00, 0x00, 0xb4, 0x42, 0x00, 0x00, 0x70, 0x42]));
    // health 0, agc 200, magnitude 0x0234 (564), ticks 0x0400 (1024), version 3, bus-off 2.
    r.wire.fromNode({ receive: () => undefined }, injected(7, V3Telemetry.MAGNET_HEALTH, [0x00, 0xc8, 0x34, 0x02, 0x00, 0x04, 0x03, 0x02]));
    await run(r.sched, 1);
    expect(d.getSignal('position')).toBeCloseTo(0.25, 6);
    expect(d.getSignal('position.deg')).toBe(90);
    expect(d.getSignal('velocity.dps')).toBe(60);
    expect(d.getSignal('velocity')).toBeCloseTo(10, 6);
    expect(d.getSignal('magnet.health')).toBe(0);
    expect(d.getSignal('magnet.agc')).toBe(200);
    expect(d.getSignal('magnet.field')).toBe(564);
    expect(d.getSignal('abs.ticks')).toBe(1024);
    expect(d.getSignal('abs.position')).toBeCloseTo(0.25, 6);
    expect(d.getSignal('protocol.version')).toBe(3);
    expect(d.getSignal('bus_off.count')).toBe(2);
    expect(d.protocolVersion).toBe(3);
  });

  it('masks field strength to 12 bits, maps unknown health codes to ERROR, ignores corrupt floats', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 7 });
    await run(r.sched, 600);
    // Silence the real board so only injected frames count.
    b.muteTelemetry();
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const inject = (f: CanFrame): void => r.wire.fromNode({ receive: () => undefined }, f);
    inject(injected(7, V3Telemetry.MAGNET_HEALTH, [0x09, 0x10, 0x34, 0xf2, 0x00, 0x00, 0x00, 0x00]));
    await run(r.sched, 1);
    expect(d.getSignal('magnet.health')).toBe(2);
    expect(d.getSignal('magnet.field')).toBe(0x234);
    // Pre-v2 firmware: padded bytes, version 0.
    expect(d.getSignal('protocol.version')).toBe(0);
    expect(Number.isNaN(d.getSignal('abs.ticks'))).toBe(true);
    expect(d.protocolVersion).toBe(0);
    const before = d.getSignal('position.deg');
    inject(injected(7, V3Telemetry.POSITION_VELOCITY, [0x00, 0x00, 0xc0, 0x7f, 0, 0, 0, 0])); // NaN
    inject(injected(7, V3Telemetry.POSITION_VELOCITY, [1, 2, 3])); // short
    await run(r.sched, 1);
    expect(d.getSignal('position.deg')).toBe(before);
  });

  it('notifies onSignals once per frame with the keys it carried', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 7 });
    b.velocityDps = 30;
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const batches: string[][] = [];
    const off = d.onSignals((u) => batches.push([...u.keys]));
    await run(r.sched, 20);
    off();
    expect(batches.some((k) => k.includes('position.deg'))).toBe(true);
    expect(batches.some((k) => k.includes('magnet.health') && k.includes('abs.ticks'))).toBe(true);
    await run(r.sched, 20);
    expect(batches.length).toBeLessThanOrEqual(6);
  });

  it('turns ACTIVE with telemetry and FAULT on a sensor fault', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 7 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    expect(d.state).toBe(DeviceState.ACTIVE);
    b.sensorFault();
    await run(r.sched, 50);
    expect(d.getSignal('magnet.health')).toBe(3);
    expect(d.state).toBe(DeviceState.FAULT);
    expect(d.online).toBe(true);
  });
});

describe('Cyncoder v3 commands', () => {
  it('sends UID + sequence and resolves on a matching ACK', async () => {
    const r = await legacyRig({ initialSequence: 42 });
    const b = r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const res = await settle(r.sched, d.command('zero_here'));
    expect(res).toMatchObject({ cmd: 0x40, status: 0, result: 0, confirmed: true });
    const sent = r.wire.hostFrames().filter((f) => (f.id >>> 10 & 0x3f) === 1);
    expect(sent).toHaveLength(1);
    const f = sent[0] as CanFrame;
    expect(f.id).toBe((10 << 24) | (8 << 16) | (1 << 10) | (0 << 6) | 15);
    expect([...f.data]).toEqual([0xcd, 0xab, 0x34, 0x12, 42]);
    expect(f.fd).toBe(false);
    expect(b.applied).toEqual([{ index: 0, sequence: 42 }]);

    await settle(r.sched, d.command('factory_default'));
    await settle(r.sched, d.command(0x43));
    await settle(r.sched, d.identify(5));
    expect(b.applied.map((a) => [a.index, a.sequence])).toEqual([
      [0, 42],
      [2, 43],
      [3, 44],
      [3, 45],
    ]);
    expect(b.blinks).toBe(2);
  });

  it.each([
    [V3Ack.FLASH_WRITE_FAILED, 'applied_not_saved'],
    [V3Ack.INVALID_ARGUMENT, 'invalid_argument'],
    [V3Ack.CAN_ID_CHANGE_FAILED, 'can_id_change_failed'],
    [V3Ack.NOT_READY, 'not_ready'],
    [9, 'unknown_result'],
  ])('rejects ACK result %i as REJECTED/%s', async (code, reason) => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 15 });
    b.ackResult = code;
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const e = await settle(r.sched, caught(d.command('zero_here')));
    expect(e).toBeInstanceOf(CyError);
    expect((e as CyError).code).toBe('REJECTED');
    expect((e as CyError).reason).toBe(reason);
    expect((e as CyError).status).toBe(code);
    // The slot is free again for the next command.
    b.ackResult = V3Ack.OK;
    await expect(settle(r.sched, d.command('blink'))).resolves.toMatchObject({ confirmed: true });
  });

  it('times out after 500 ms without a matching ACK; stale or foreign ACKs do not count', async () => {
    const r = await legacyRig({ initialSequence: 7 });
    const b = r.board({ uid: UID_A, num: 15 });
    b.silent = true;
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const p = caught(d.command('zero_here'));
    r.sched.advance(100);
    b.sendAck(0, 6); // old sequence
    b.sendAck(0, 7, { uid: UID_B }); // another board's ACK
    b.sendAck(2, 7); // other command
    await flush();
    await run(r.sched, 390);
    const e = (await settle(r.sched, p)) as CyError;
    expect(e.code).toBe('TIMEOUT');
    expect(r.sched.now()).toBeGreaterThanOrEqual(1100);
  });

  it('refuses a second command while one waits for its ACK', async () => {
    const r = await legacyRig();
    r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const first = d.command('blink');
    const e = (await caught(d.command('blink'))) as CyError;
    expect(e.code).toBe('BUSY');
    await settle(r.sched, first);
  });

  it.each([0, 2] as const)('reports commands as unconfirmed on protocol version %i (no ACK)', async (version) => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 15, version });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const res = await settle(r.sched, d.command('zero_here'));
    expect(res.confirmed).toBe(false);
    expect(b.applied).toHaveLength(1);
    expect(r.sched.now()).toBeLessThan(700);
  });

  it('addresses only the targeted board when two share a number', async () => {
    const r = await legacyRig();
    const a = r.board({ uid: UID_A, num: 15 });
    const b = r.board({ uid: UID_B, num: 15 });
    await run(r.sched, 700);
    const db = r.legacy.deviceByUid(UID_B) as CyncoderV3Device;
    await settle(r.sched, db.command('blink'));
    expect(a.blinks).toBe(0);
    expect(b.blinks).toBe(1);
  });

  it('rejects an unknown command key as INVALID, including SET_CONFIG', async () => {
    const r = await legacyRig();
    r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    expect(((await caught(d.command('set_config'))) as CyError).code).toBe('INVALID');
    expect(((await caught(d.command(0x41))) as CyError).code).toBe('INVALID');
  });
});

describe('Cyncoder v3 supervision', () => {
  it('marks a silent board lost after 1.5 s and online again when it returns', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const events: string[] = [];
    r.bus.on('deviceLost', () => events.push('lost'));
    r.bus.on('deviceChanged', () => events.push('changed'));
    b.powerOff();
    await run(r.sched, 1400);
    expect(d.online).toBe(true);
    await run(r.sched, 200);
    expect(d.online).toBe(false);
    expect(events).toContain('lost');
    expect(d.getSignal('magnet.health')).toBe(-1);
    b.powerOn();
    await run(r.sched, 600);
    expect(d.online).toBe(true);
    expect(events).toContain('changed');
    expect(d.getSignal('magnet.health')).toBe(0);
  });

  it('flags stale telemetry quickly while the identity frame keeps the board online', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    expect(d.state).toBe(DeviceState.ACTIVE);
    b.muteTelemetry();
    await run(r.sched, 400);
    expect(d.online).toBe(true);
    expect(d.state).toBe(DeviceState.IDLE);
    expect(d.getSignal('magnet.health')).toBe(-1);
    b.unmuteTelemetry();
    await run(r.sched, 50);
    expect(d.state).toBe(DeviceState.ACTIVE);
    expect(d.getSignal('magnet.health')).toBe(0);
  });

  it('fails a pending command with DISCONNECTED when the transport drops, and keeps the handle offline', async () => {
    const r = await legacyRig();
    const b = r.board({ uid: UID_A, num: 15 });
    b.silent = true;
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const p = caught(d.command('zero_here'));
    r.transport.fail('unplugged');
    const e = (await p) as CyError;
    expect(e.code).toBe('DISCONNECTED');
    expect(d.online).toBe(false);
    expect(r.bus.devices).toEqual([d]);
    expect(((await caught(d.command('blink'))) as CyError).code).toBe('DISCONNECTED');
  });

  it('removes boards when the bus stops, and forget() drops one', async () => {
    const r = await legacyRig();
    r.board({ uid: UID_A, num: 15 });
    r.board({ uid: UID_B, num: 16 });
    await run(r.sched, 700);
    const removed: string[] = [];
    r.bus.on('deviceRemoved', (d) => removed.push(d.uid48));
    expect(r.legacy.forget(UID_B)).toBe(true);
    expect(removed).toEqual(['0000' + UID_B.toString(16).padStart(8, '0')]);
    await r.bus.stop();
    expect(removed).toHaveLength(2);
    expect(r.bus.devices).toHaveLength(0);
  });
});

describe('Cyncoder v3 unsupported features', () => {
  it('rejects with NOT_SUPPORTED', async () => {
    const r = await legacyRig();
    r.board({ uid: UID_A, num: 15 });
    await run(r.sched, 600);
    const d = r.legacy.deviceByUid(UID_A) as CyncoderV3Device;
    const calls: Array<() => Promise<unknown>> = [
      () => d.getParam('x'),
      () => d.setParam('x', 1),
      () => d.readAllParams(),
      () => d.save(),
      () => d.loadDefaults(),
      () => d.rename('x'),
      () => d.reboot(),
      () => d.clearFaults(),
      () => d.selfTest(),
      () => d.clearEstop(),
      () => d.readFaults(),
      () => d.firmware.update(new Uint8Array(4)),
    ];
    for (const c of calls) {
      const e = (await caught(c())) as CyError;
      expect(e.code).toBe('NOT_SUPPORTED');
    }
    for (const sync of [() => d.control.set('duty', 0), () => d.control.start('duty', 0), () => d.stream.open({ signals: ['position'], periodUs: 1000 })]) {
      expect(sync).toThrowError(CyError);
      try {
        sync();
      } catch (e) {
        expect((e as CyError).code).toBe('NOT_SUPPORTED');
      }
    }
    expect(() => d.control.stop()).not.toThrow();
    expect(d.params.size).toBe(0);
    await expect(r.bus.updateAllFirmware([])).resolves.toEqual([]);
  });
});
