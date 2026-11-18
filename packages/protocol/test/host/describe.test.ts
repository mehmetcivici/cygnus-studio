import { describe, expect, it } from 'vitest';
import { getModel } from '../../src/catalog/catalog';
import { encodeStatusFrame } from '../../src/catalog/status';
import { Command, CommandStatus, DeviceState, Model, ParamStatus } from '../../src/core/constants';
import { type CanFrame, type TxFrame, BROADCAST_ALL } from '../../src/core/frame';
import { encodeId } from '../../src/core/id';
import {
  encodeCommand,
  encodeCommandRsp,
  encodeCtrlSet,
  encodeEnumRsp,
  encodeEstop,
  encodeHeartbeat,
  encodeParamValue,
  encodeStatus,
  encodeStreamData,
} from '../../src/core/messages';
import { describeFrame } from '../../src/host/describe';
import { Model as M } from '../../src/core/constants';
import { run } from '../helpers/fake-bus';
import { rig } from '../helpers/setup';

const ESC = getModel(Model.ESC_20A)!;
const at = (f: TxFrame): CanFrame => ({ ...f, timestamp: 0 });
const modelAt = (dt: number, num: number) => (dt === 2 && num === 4 ? ESC : undefined);

describe('describeFrame', () => {
  it('names classes, indexes, addresses and fields', () => {
    const hb = describeFrame(
      at(encodeHeartbeat({ devType: 2, num: 4 }, {
        state: DeviceState.ACTIVE, unsaved: true, enabled: true, warning: false, identify: false,
        fault: 0x0008, uid16: 0xbeef, fwMajor: 1, fwMinor: 4, fwPatch: 2,
      })),
      { lang: 'en', modelAt },
    );
    expect(hb).toMatchObject({ protocol: 'cycan', dir: 'fromDevice', className: 'SYS_RSP', indexName: 'HEARTBEAT', address: 'ESC 20A #4' });
    expect(hb.fields.find((f) => f.key === 'state')?.value).toBe('Active');
    expect(hb.fields.find((f) => f.key === 'fw')?.value).toBe('1.4.2');
    const tr = describeFrame(at(encodeHeartbeat({ devType: 2, num: 4 }, {
      state: DeviceState.IDLE, unsaved: false, enabled: false, warning: false, identify: false, fault: 0, uid16: 1, fwMajor: 1, fwMinor: 0, fwPatch: 0,
    })), { lang: 'tr' });
    expect(tr.fields.find((f) => f.key === 'state')).toMatchObject({ label: 'Durum', value: 'Boşta' });
    expect(tr.address).toBe('Motor sürücü #4');

    const cmd = describeFrame(at(encodeCommand({ devType: 2, num: 4 }, { cmd: 0x41, arg: 0 })), { lang: 'en', modelAt });
    expect(cmd.dir).toBe('toDevice');
    expect(cmd.fields[0]?.value).toBe('Measure motor parameters');
    const rsp = describeFrame(at(encodeCommandRsp({ devType: 2, num: 4 }, { cmd: Command.SELF_TEST, status: CommandStatus.IN_PROGRESS, result: 0 })), { lang: 'en' });
    expect(rsp.summary).toContain('In progress');

    const pv = describeFrame(at(encodeParamValue({ devType: 2, num: 4 }, { pid: 0x0160, ptype: 2, status: ParamStatus.OUT_OF_RANGE, value: 0.5 })), { lang: 'en', modelAt });
    expect(pv.fields.map((f) => f.value)).toEqual(['vel.kp (0x0160)', 'f32', '0.5', 'Out of range']);

    const all = describeFrame(at(encodeEstop(BROADCAST_ALL)), { lang: 'en' });
    expect(all).toMatchObject({ indexName: 'ESTOP', address: 'all boards' });

    const en = describeFrame(at(encodeEnumRsp({ devType: 7, num: 0 }, { uid48: 0x0102030405, num: 63, conflict: false, bootloader: false, model: M.CYNCODER })), { lang: 'en' });
    expect(en.className).toBe('ENUM_RSP');
    expect(en.address).toMatch(/^hash10=0x/);
    expect(en.fields.find((f) => f.key === 'model')?.value).toBe('Cyncoder (3)');
  });

  it('decodes STATUS and CTRL through the catalog', () => {
    const f0 = ESC.statusFrames[0]!;
    const st = describeFrame(at(encodeStatus({ devType: 2, num: 4 }, { index: 0, data: encodeStatusFrame(f0, { velocity: 1234.5, 'phase.current': -3.21, duty: 0.5 }) })), {
      lang: 'en',
      modelAt,
    });
    expect(st.indexName).toBe('Fast');
    expect(st.fields.map((f) => [f.label, f.value])).toEqual([
      ['Velocity', '1234.5 rpm'],
      ['Phase current', '-3.21 A'],
      ['Duty cycle', '0.5'],
    ]);
    const ctrl = describeFrame(at(encodeCtrlSet({ devType: 2, num: 4 }, { mode: 3, flags: 0, value: 1500 })), { lang: 'tr', modelAt });
    expect(ctrl.fields.map((f) => f.value)).toEqual(['Hız', '1500 rpm']);
    const data = describeFrame(at(encodeStreamData({ devType: 2, num: 4 }, { seq: 3, firstSlot: 0, t100us: 99, values: [1.5, 2.5] })), { lang: 'en' });
    expect(data.fields.slice(3).map((f) => f.value)).toEqual(['1.5', '2.5']);
    // Without a known model STATUS stays raw.
    expect(describeFrame(at(encodeStatus({ devType: 2, num: 9 }, { index: 0, data: new Uint8Array(8) })), { modelAt }).fields).toEqual([]);
  });

  it('shows foreign and legacy frames raw', () => {
    const foreign = describeFrame({ id: encodeId({ devType: 2, mfr: 5, cls: 2, index: 1, num: 3 }), data: Uint8Array.of(1, 2, 0xab), fd: false, brs: false, timestamp: 0 }, { lang: 'en' });
    expect(foreign).toMatchObject({ protocol: 'unknown', dir: 'unknown', raw: '01 02 ab', fields: [] });
    const legacy = describeFrame({ id: encodeId({ devType: 10, cls: 0, index: 0, num: 1 }), data: new Uint8Array(8), fd: false, brs: false, timestamp: 0 }, { lang: 'en' });
    expect(legacy.protocol).toBe('cyncoder-v3');
  });

  it('uses discovered models through bus.describeFrame', async () => {
    const r = await rig();
    const n = r.node({ model: Model.CYNCODER, seed: 95, num: 2, status: true });
    await r.ready(n);
    const seen: string[] = [];
    r.bus.on('frame', (e) => {
      if (e.dir === 'rx') seen.push(r.bus.describeFrame(e.frame, 'en').indexName);
    });
    await run(r.sched, 300);
    const enc = getModel(Model.CYNCODER)!;
    expect(seen).toContain(enc.statusFrames[0]!.label.en);
  });
});

describe('describeFrame number format (tasarim B23)', () => {
  it('uses the decimal comma in Turkish and °/s for angular rates', () => {
    const ctrl = (lang: 'tr' | 'en') =>
      describeFrame(at(encodeCtrlSet({ devType: 2, num: 4 }, { mode: 1, flags: 0, value: 0.25 })), { lang, modelAt }).fields.find((f) => f.key === 'value')?.value;
    expect(ctrl('tr')).toMatch(/^0,25/);
    expect(ctrl('en')).toMatch(/^0\.25/);
    const gyro = getModel(M.GYRO)!;
    expect(gyro.signals.filter((s) => s.key.startsWith('gyro.')).map((s) => s.unit)).toEqual(['°/s', '°/s', '°/s']);
    expect(JSON.stringify(gyro)).not.toContain('"dps"');
  });
});
