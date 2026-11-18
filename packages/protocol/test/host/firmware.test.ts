import { describe, expect, it } from 'vitest';
import { Cls, DeviceState, FW_CHUNK_CLASSIC, FwReq, FwStatus, Model } from '../../src/core/constants';
import { buildCyfw } from '../../src/core/cyfw';
import { idClass, idIndex } from '../../src/core/id';
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
    expect(phases).toEqual(['validate', 'enterBootloader', 'erase', 'transfer', 'verify']);
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
});
