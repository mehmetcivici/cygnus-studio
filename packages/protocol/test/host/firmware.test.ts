import { describe, expect, it } from 'vitest';
import {
  Cls,
  Command,
  DeviceState,
  ENTER_BOOTLOADER_INTENT,
  FW_CHUNK_CLASSIC,
  FwReq,
  FwStatus,
  Model,
  RECOVERY_BEACON_PERIOD_MS,
  RECOVERY_STAY_MAGIC,
  SysReq,
} from '../../src/core/constants';
import { buildCyfw } from '../../src/core/cyfw';
import { lengthToDlc, dlcToLength } from '../../src/core/fd';
import { idClass, idDevType, idIndex, idNum } from '../../src/core/id';
import { decodeCommand } from '../../src/core/messages';
import type { AbortSignalLike, FirmwareProgress } from '../../src/host/types';
import { run, settle } from '../helpers/fake-bus';
import { caught, rig } from '../helpers/setup';

function image(model: number, version: [number, number, number], size = 1500, hw: [number, number] = [1, 3]): Uint8Array {
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = (i * 31 + 7) & 0xff;
  return buildCyfw(
    {
      model,
      hwRevMin: hw[0],
      hwRevMax: hw[1],
      fwMajor: version[0],
      fwMinor: version[1],
      fwPatch: version[2],
      catalogRev: 1,
      gitHash: 0x1234,
      buildDay: 320,
      name: 'test',
    },
    payload,
  );
}

class TestAbort implements AbortSignalLike {
  aborted = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_t: 'abort', l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: 'abort', l: () => void): void {
    this.listeners.delete(l);
  }
  abort(): void {
    this.aborted = true;
    for (const l of this.listeners) l();
  }
}

const dataFrames = (frames: { id: number }[]): number =>
  frames.filter((f) => idClass(f.id) === Cls.FW_REQ && idIndex(f.id) === FwReq.DATA).length;

describe('firmware update', () => {
  it('enters the bootloader, transfers with FD chunks and verifies the new version', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 70, num: 1, fw: [1, 0, 0], hwRev: 2 });
    const h = await r.ready(n);
    const img = image(Model.ESC_20A, [2, 1, 0]);
    const progress: FirmwareProgress[] = [];
    const res = await settle(r.sched, h.firmware.update(img, { onProgress: (p) => progress.push(p) }));
    expect(res.version).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(res.previous).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(res.rewinds).toBe(0);
    expect(n.fw).toEqual([2, 1, 0]);
    expect(h.state).toBe(DeviceState.IDLE);
    expect(dataFrames(r.wire.hostFrames())).toBe(Math.ceil(img.length / 61));
    const phases = [...new Set(progress.map((p) => p.phase))];
    expect(phases).toEqual(['validate', 'enterBootloader', 'erase', 'transfer', 'finish', 'verify']);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!.fraction).toBeGreaterThanOrEqual(progress[i - 1]!.fraction);
    expect(progress.at(-1)!.fraction).toBe(1);
    expect(h.firmware.busy).toBe(false);
    // INFO is re-read after leaving the bootloader.
    await run(r.sched, 200);
    expect(h.infoLoaded).toBe(true);
  });

  it('uses 5-byte chunks on a classic link and handles an image ending on a window boundary', async () => {
    const r = await rig({ fd: false });
    const n = r.node({ model: Model.CYNCODER, seed: 71, num: 1, fd: false });
    const h = await r.ready(n);
    // 64-byte header + 1216 bytes = 1280 = 256 chunks = 16 full windows.
    const img = image(Model.CYNCODER, [1, 5, 0], 1216);
    const res = await settle(r.sched, h.firmware.update(img));
    expect(res.version.minor).toBe(5);
    expect(dataFrames(r.wire.hostFrames())).toBe(img.length / FW_CHUNK_CLASSIC);
  });

  it('rewinds on BAD_OFFSET', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 72, num: 1 });
    const h = await r.ready(n);
    n.fwDropOffsetOnce = 61 * 20;
    const img = image(Model.ESC_20A, [1, 1, 0], 4000);
    const res = await settle(r.sched, h.firmware.update(img));
    expect(res.rewinds).toBe(1);
    expect(n.fw).toEqual([1, 1, 0]);
  });

  it('fails with REJECTED(BAD_CRC) when the board sees a corrupt image', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 73, num: 1 });
    const h = await r.ready(n);
    n.fwCorruptOffset = 500;
    const e = await caught(settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 1, 0]))));
    expect(e).toMatchObject({ code: 'REJECTED', status: FwStatus.BAD_CRC, statusKind: 'fw' });
    expect(h.firmware.busy).toBe(false);
    // Still in the bootloader; a second attempt (without corruption) succeeds from there.
    await run(r.sched, 600);
    expect(h.bootloader).toBe(true);
    n.fwCorruptOffset = null;
    const res = await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 1, 0])));
    expect(res.version.minor).toBe(1);
  });

  it('can be aborted and sends nothing afterwards', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 74, num: 1 });
    const h = await r.ready(n);
    const ctl = new TestAbort();
    const p = h.firmware.update(image(Model.ESC_20A, [3, 0, 0], 20_000), {
      signal: ctl,
      onProgress: (pr) => {
        if (pr.phase === 'transfer' && pr.sent > 3000) ctl.abort();
      },
    });
    expect(await caught(settle(r.sched, p))).toMatchObject({ code: 'ABORTED' });
    const sent = dataFrames(r.wire.hostFrames());
    await run(r.sched, 100);
    expect(dataFrames(r.wire.hostFrames())).toBe(sent);
    expect(h.firmware.busy).toBe(false);
  });

  it('rejects images for another model or hardware revision before touching the board', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 75, num: 1, hwRev: 5 });
    const h = await r.ready(n);
    expect(await caught(h.firmware.update(image(Model.ESC_80A, [2, 0, 0])))).toMatchObject({ code: 'INVALID', reason: 'wrong_model' });
    expect(await caught(h.firmware.update(image(Model.ESC_20A, [2, 0, 0])))).toMatchObject({ code: 'INVALID', reason: 'wrong_hw_rev' });
    const bad = image(Model.ESC_20A, [2, 0, 0], 100, [1, 9]);
    bad[80] = (bad[80] ?? 0) ^ 1;
    expect(await caught(h.firmware.update(bad))).toMatchObject({ code: 'INVALID', reason: 'bad_payload_crc' });
    expect(n.inBootloader).toBe(false);
  });

  it('reports a version mismatch after the update', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 76, num: 1 });
    const h = await r.ready(n);
    n.fwVersionAfterUpdate = [9, 9, 9];
    expect(await caught(settle(r.sched, h.firmware.update(image(Model.ESC_20A, [2, 0, 0], 300))))).toMatchObject({
      code: 'REJECTED',
      reason: 'version_mismatch',
    });
  });

  it('updates every matching board in turn and skips current ones', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 77, num: 1, fw: [1, 0, 0] });
    const b = r.node({ model: Model.ESC_20A, seed: 78, num: 2, fw: [2, 0, 0] });
    const c = r.node({ model: Model.CYNCODER, seed: 79, num: 1, fw: [1, 0, 0] });
    const g = r.node({ model: Model.GYRO, seed: 80, num: 1 });
    for (const x of [a, b, c, g]) await r.ready(x);
    const order: string[] = [];
    const res = await settle(
      r.sched,
      r.bus.updateAllFirmware([image(Model.ESC_20A, [2, 0, 0], 500), image(Model.CYNCODER, [1, 1, 0], 500)], {
        onDevice: (d) => order.push(d.def!.key),
      }),
    );
    expect(order).toEqual(['esc20a', 'cyncoder']);
    expect(a.fw).toEqual([2, 0, 0]);
    expect(c.fw).toEqual([1, 1, 0]);
    expect(res.find((x) => x.device.uid48 === r.bus.deviceByUid(b.uid48)!.uid48)?.skipped).toBe('same_version');
    expect(res.find((x) => x.device.model === Model.GYRO)?.skipped).toBe('no_image');
    expect(res.filter((x) => x.result).length).toBe(2);
  });

  it('asks for the bootloader with the intent argument and repeats an unanswered request', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 340, num: 1 });
    const h = await r.ready(n);
    n.ignoreEnterBootloader = 1;
    const res = await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 2, 0], 300)));
    expect(res.version.minor).toBe(2);
    const enters = r.transport.sent
      .filter((f) => idClass(f.id) === Cls.SYS_REQ && idIndex(f.id) === SysReq.COMMAND)
      .map((f) => decodeCommand(f.data))
      .filter((c) => c?.cmd === Command.ENTER_BOOTLOADER);
    expect(enters).toHaveLength(2);
    for (const c of enters) expect(c!.arg).toBe((ENTER_BOOTLOADER_INTENT | n.uid16) >>> 0);
  });

  it('also when only the answer to ENTER_BOOTLOADER is lost', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 341, num: 1 });
    const h = await r.ready(n);
    n.dropEnterBootloaderRsp = 1;
    const res = await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 3, 0], 300)));
    expect(res.version.minor).toBe(3);
  });

  it('confirms the update from the heartbeat version when the END answer is lost', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 342, num: 1 });
    const h = await r.ready(n);
    n.fwDropEndAcks = 1;
    const res = await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [4, 0, 0], 1000)));
    expect(res.version).toEqual({ major: 4, minor: 0, patch: 0 });
    // Only END was repeated: no DATA after the first END.
    const frames = r.transport.sent.filter((f) => idClass(f.id) === Cls.FW_REQ);
    const firstEnd = frames.findIndex((f) => idIndex(f.id) === FwReq.END);
    expect(frames.slice(firstEnd).every((f) => idIndex(f.id) === FwReq.END)).toBe(true);
  });

  it('waits out BUSY in the middle of a transfer and continues where the board says', async () => {
    const r = await rig({ fd: false });
    const n = r.node({ model: Model.CYNCODER, seed: 343, num: 1, fd: false });
    const h = await r.ready(n);
    n.fwBusyAt = { offset: 400, ms: 120 };
    const res = await settle(r.sched, h.firmware.update(image(Model.CYNCODER, [1, 7, 0], 900)));
    expect(res.version.minor).toBe(7);
  });

  it('leaves the installed application alone when the board refuses the header', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 344, num: 1, fw: [1, 0, 0], hwRev: 2 });
    const h = await r.ready(n);
    n.hwRev = 7; // the host still believes rev 2: the board's own check must catch it
    const e = await caught(settle(r.sched, h.firmware.update(image(Model.ESC_20A, [2, 0, 0], 600))));
    expect(e).toMatchObject({ code: 'REJECTED', status: FwStatus.BAD_IMAGE, statusKind: 'fw' });
    // Nothing was erased; the host restarted the board into its old application.
    await run(r.sched, 1000);
    expect(n.inBootloader).toBe(false);
    expect(n.fw).toEqual([1, 0, 0]);
    expect(h.state).toBe(DeviceState.IDLE);
  });

  it('sends only full chunks whose length + 3 is a valid frame length, and uses classic chunks when the board rate is unknown', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 345, num: 1 });
    const h = await r.ready(n);
    await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 1, 1], 777)));
    const lens = r.transport.sent.filter((f) => idClass(f.id) === Cls.FW_REQ && idIndex(f.id) === FwReq.DATA).map((f) => f.data.length);
    for (const len of lens.slice(0, -1)) expect(dlcToLength(lengthToDlc(len))).toBe(len);
    expect(new Set(lens.slice(0, -1))).toEqual(new Set([64]));

    // A board whose data rate is unknown (no answer to the GET) gets classic chunks.
    const r2 = await rig();
    const n2 = r2.node({ model: Model.ESC_20A, seed: 346, num: 1 });
    const h2 = await r2.ready(n2);
    n2.mute.add(Cls.PARAM_REQ);
    await settle(r2.sched, h2.firmware.update(image(Model.ESC_20A, [1, 1, 2], 300)));
    const lens2 = r2.transport.sent.filter((f) => idClass(f.id) === Cls.FW_REQ && idIndex(f.id) === FwReq.DATA).map((f) => f.data.length);
    expect(new Set(lens2.slice(0, -1))).toEqual(new Set([8]));
  });

  it('lists the boards it never reached when the link goes down during a batch', async () => {
    const r = await rig();
    const a = r.node({ model: Model.ESC_20A, seed: 347, num: 1 });
    const b = r.node({ model: Model.ESC_20A, seed: 348, num: 2 });
    await r.ready(a);
    await r.ready(b);
    const p = r.bus.updateAllFirmware([image(Model.ESC_20A, [5, 0, 0], 3000)], {
      onProgress: (_d, pr) => {
        if (pr.phase === 'transfer' && pr.sent > 500) r.transport.fail();
      },
    });
    const res = await settle(r.sched, p);
    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ ok: false, error: { code: 'DISCONNECTED' } });
    expect(res[1]).toMatchObject({ ok: false, skipped: 'aborted', error: { code: 'DISCONNECTED' } });
  });
});

describe('recovery mode', () => {
  it('keeps a board with a broken application in its bootloader while the user power-cycles', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 350, num: 1 });
    await r.ready(n);
    n.appBroken = true;
    const states: boolean[] = [];
    r.bus.on('recovery', (on) => states.push(on));
    r.bus.recovery.start();
    expect(r.bus.recovery.active).toBe(true);
    n.powerOff();
    await run(r.sched, 400);
    n.powerOn();
    await run(r.sched, 2000);
    expect(n.inBootloader).toBe(true);
    expect(r.bus.recovery.devices.map((d) => d.uid48)).toEqual([r.bus.deviceByUid(n.uid48)!.uid48]);
    const beacons = r.transport.sent.filter((f) => idClass(f.id) === Cls.SYS_REQ && idIndex(f.id) === SysReq.COMMAND && idDevType(f.id) === 0 && idNum(f.id) === 0);
    expect(beacons.length).toBeGreaterThanOrEqual(Math.floor(2400 / RECOVERY_BEACON_PERIOD_MS) - 1);
    expect(decodeCommand(beacons[0]!.data)).toMatchObject({ cmd: Command.ENTER_BOOTLOADER, arg: RECOVERY_STAY_MAGIC });
    r.bus.recovery.stop();
    const count = r.transport.sent.length;
    await run(r.sched, 100);
    expect(r.transport.sent.length - count).toBeLessThan(3);
    expect(states).toEqual([true, false]);
    // A good image can now go in from the bootloader.
    n.appBroken = false;
    const h = r.bus.deviceByUid(n.uid48)!;
    const res = await settle(r.sched, h.firmware.update(image(Model.ESC_20A, [1, 9, 0], 300)));
    expect(res.version.minor).toBe(9);
  });

  it('does not touch running applications', async () => {
    const r = await rig();
    const n = r.node({ model: Model.ESC_20A, seed: 351, num: 1 });
    await r.ready(n);
    r.bus.recovery.start();
    await run(r.sched, 500);
    r.bus.recovery.stop();
    expect(n.inBootloader).toBe(false);
    expect(n.state).toBe(DeviceState.IDLE);
  });
});
