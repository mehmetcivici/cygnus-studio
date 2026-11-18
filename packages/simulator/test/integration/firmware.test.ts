import { CyError, FwStatus, Model, type FirmwareProgress } from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { makeDemoFirmware } from '../../src/firmware';
import { createScenario } from '../../src/scenarios';
import { connect, cycanNodes } from './harness';

/** Minimal AbortController stand-in (the protocol package only needs AbortSignalLike). */
function abortable(): { signal: { aborted: boolean; addEventListener(t: 'abort', l: () => void): void; removeEventListener(t: 'abort', l: () => void): void }; abort(): void } {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_t: 'abort', l: () => void) => listeners.add(l),
    removeEventListener: (_t: 'abort', l: () => void) => listeners.delete(l),
  };
  return {
    signal,
    abort() {
      signal.aborted = true;
      for (const l of [...listeners]) l();
    },
  };
}

describe('host ↔ simulator: firmware update', () => {
  it.each([[true], [false]])('happy path (fd=%s): bootloader, transfer, new version runs', async (fd) => {
    const sim = createScenario('bench.flywheel', { fd });
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    if (!fd) await r.settle(d.getParam('can.data_bitrate'));
    const img = makeDemoFirmware(Model.ESC_80A, '1.4.2', { size: fd ? 24_000 : 6_000 });
    const phases = new Set<string>();
    let last = 0;
    let monotonic = true;
    const res = await r.settle(
      d.firmware.update(img, {
        onProgress: (p: FirmwareProgress) => {
          phases.add(p.phase);
          if (p.fraction < last) monotonic = false;
          last = p.fraction;
        },
      }),
      60_000,
    );
    expect(res.version).toEqual({ major: 1, minor: 4, patch: 2 });
    expect(res.previous).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(res.rewinds).toBe(0);
    expect(monotonic).toBe(true);
    expect(last).toBe(1);
    expect([...phases]).toEqual(expect.arrayContaining(['enterBootloader', 'erase', 'transfer', 'verify']));
    expect(sim.node('esc').firmware).toEqual({ major: 1, minor: 4, patch: 2 });
    await r.until(() => d.infoLoaded, 3000, 'INFO after update');
    expect(d.state).not.toBe(1);
  });

  it('completes under 5 % frame loss with rewinds', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    sim.setBusLoss(5);
    const img = makeDemoFirmware(Model.ESC_80A, '2.0.0', { size: 32_000 });
    const res = await r.settle(d.firmware.update(img), 120_000);
    expect(res.version).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(res.rewinds).toBeGreaterThan(0);
    expect(sim.node('esc').firmware.major).toBe(2);
  });

  it('refuses an image for another model before touching the board', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    const e = await r.caught(d.firmware.update(makeDemoFirmware(Model.CYNCODER, '9.0.0')));
    expect(e).toMatchObject({ code: 'INVALID', reason: 'wrong_model' });
    expect(sim.node('esc').mode).toBe(2);
  });

  it('the bootloader rejects a wrong-model image that got past the host (BAD_IMAGE)', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    // Pretend the host believes the board is a different model, so its own check passes.
    const img = makeDemoFirmware(Model.ESC_20A, '3.0.0', { size: 4000 });
    (d as unknown as { model: number }).model = Model.ESC_20A;
    const e = await r.caught(d.firmware.update(img), 30_000);
    expect(e).toBeInstanceOf(CyError);
    expect(e).toMatchObject({ code: 'REJECTED', status: FwStatus.BAD_IMAGE, statusKind: 'fw' });
    // The application was erased: the board waits in the bootloader and reports 0.0.0.
    await r.runFor(1200);
    expect(sim.node('esc').mode).toBe(3);
    expect(d.bootloader).toBe(true);
    expect(d.fw).toEqual({ major: 0, minor: 0, patch: 0 });
    // A correct image recovers it straight from the bootloader.
    (d as unknown as { model: number }).model = Model.ESC_80A;
    const ok = await r.settle(d.firmware.update(makeDemoFirmware(Model.ESC_80A, '1.0.1', { size: 4000 })), 30_000);
    expect(ok.version).toEqual({ major: 1, minor: 0, patch: 1 });
  });

  it('abort stops the transfer; the board stays in the bootloader and can be updated again', async () => {
    const sim = createScenario('bench.flywheel');
    const r = await connect(sim);
    await r.discover();
    const d = r.dev('esc');
    const ctl = abortable();
    const img = makeDemoFirmware(Model.ESC_80A, '1.5.0', { size: 40_000 });
    const p = d.firmware.update(img, {
      signal: ctl.signal,
      onProgress: (pr) => {
        if (pr.phase === 'transfer' && pr.sent > 10_000) ctl.abort();
      },
    });
    expect(await r.caught(p, 30_000)).toMatchObject({ code: 'ABORTED' });
    expect(d.firmware.busy).toBe(false);
    await r.runFor(1000);
    expect(sim.node('esc').mode).toBe(3);
    const res = await r.settle(d.firmware.update(img), 60_000);
    expect(res.version).toEqual({ major: 1, minor: 5, patch: 0 });
  });

  it('updateAllFirmware: matching boards in turn, others skipped', async () => {
    const sim = createScenario('all.devices');
    const r = await connect(sim);
    await r.discover();
    const imgs = [makeDemoFirmware(Model.ESC_80A, '1.1.0', { size: 8000 }), makeDemoFirmware(Model.CYNCODER, '1.1.0', { size: 8000 }), makeDemoFirmware(Model.GYRO, '1.0.0', { size: 4000 })];
    const started: string[] = [];
    const out = await r.settle(r.bus.updateAllFirmware(imgs, { onDevice: (dev) => started.push(dev.uid48) }), 120_000);
    const byId = new Map(cycanNodes(sim).map((n) => [r.dev(n.id).uid48, n.id]));
    const result = Object.fromEntries(out.map((o) => [byId.get(o.device.uid48), o.skipped ?? (o.ok ? 'ok' : `error ${o.error?.message}`)]));
    expect(result['esc80a']).toBe('ok');
    expect(result['cyncoder']).toBe('ok');
    expect(result['gyro']).toBe('same_version');
    expect(result['esc20a']).toBe('no_image');
    expect(started.length).toBe(2);
    expect(sim.node('esc80a').firmware).toEqual({ major: 1, minor: 1, patch: 0 });
    expect(sim.node('cyncoder').firmware).toEqual({ major: 1, minor: 1, patch: 0 });
    expect(sim.node('esc20a').firmware).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});
