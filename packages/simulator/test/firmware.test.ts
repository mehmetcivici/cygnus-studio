import {
  Command,
  CommandStatus,
  DeviceState,
  DevType,
  FW_CHUNK_CLASSIC,
  FW_CHUNK_FD,
  FwStatus,
  Model,
  crc32,
  encodeCommand,
  encodeFwBegin,
  encodeFwData,
  encodeFwEnd,
  encodeInfoReq,
  encodeParamGet,
  encodeFaultReq,
  validateCyfw,
} from '@cygnus/protocol';
import { describe, expect, it } from 'vitest';
import { CyncoderNode } from '../src/devices/cyncoder';
import { makeDemoFirmware } from '../src/firmware';
import { Simulation } from '../src/simulation';
import { Host } from './helpers';

const A = { devType: DevType.ENCODER, num: 1 };

function setup(fd = true): { sim: Simulation; host: Host; enc: CyncoderNode } {
  const sim = new Simulation({ seed: 4, fd });
  const enc = sim.addNode(new CyncoderNode({ id: 'enc', num: 1, ...(fd ? {} : { params: { 'can.data_bitrate': 0 } }) }));
  const host = new Host(sim);
  host.run(400);
  return { sim, host, enc };
}

function enterBootloader(host: Host): void {
  expect(host.ask(encodeCommand(A, { cmd: Command.ENTER_BOOTLOADER, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
  host.run(700);
  expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
}

/** Host side of PROTOCOL §9 with windowed ACKs; returns the ACKs seen. */
function upload(host: Host, file: Uint8Array, chunk: number, o: { corruptAt?: number } = {}): number[] {
  const statuses: number[] = [];
  host.clear();
  host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
  for (let i = 0; i < 100; i++) {
    host.run(5);
    if (host.of('fwAck', A).some((a) => a.status === FwStatus.OK)) break;
  }
  statuses.push(...host.of('fwAck', A).map((a) => a.status));
  let off = 0;
  while (off < file.length) {
    host.clear();
    let sent = 0;
    let o2 = off;
    while (sent < 16 && o2 < file.length) {
      const bytes = file.slice(o2, o2 + chunk);
      if (o.corruptAt !== undefined && o2 <= o.corruptAt && o.corruptAt < o2 + chunk) bytes[o.corruptAt - o2]! ^= 0xff;
      host.send(encodeFwData(A, { offset: o2, bytes }));
      o2 += bytes.length;
      sent++;
    }
    host.run(12); // 16 FD frames take ~5 ms of wire time
    const acks = host.of('fwAck', A);
    statuses.push(...acks.map((a) => a.status));
    if (sent === 16) {
      expect(acks).toHaveLength(1);
      expect(acks[0]!.nextOffset).toBe(o2);
    } else expect(acks).toHaveLength(0); // the short final window waits for END
    off = o2;
  }
  host.clear();
  host.send(encodeFwEnd(A));
  host.run(80);
  statuses.push(...host.of('fwAck', A).map((a) => a.status));
  return statuses;
}

describe('firmware update', () => {
  it('produces valid demo images', () => {
    const f = makeDemoFirmware(Model.CYNCODER, '1.2.3');
    const v = validateCyfw(f, { model: Model.CYNCODER, hwRev: 1 });
    expect(v.ok).toBe(true);
    expect([...makeDemoFirmware(Model.CYNCODER, '1.2.3')]).toEqual([...f]);
  });

  it('app mode answers WRONG_STATE', () => {
    const { host } = setup();
    const r = host.ask(encodeFwBegin(A, { size: 100, crc32: 0 }), 'fwAck');
    expect(r[0]!.status).toBe(FwStatus.WRONG_STATE);
  });

  it('FD update: BUSY while erasing, windowed ACKs, END ACK, new version after reboot', () => {
    const { host } = setup();
    enterBootloader(host);
    const file = makeDemoFirmware(Model.CYNCODER, '2.1.0', { size: 5000 });
    const st = upload(host, file, FW_CHUNK_FD);
    expect(st[0]).toBe(FwStatus.BUSY);
    expect(st.at(-1)).toBe(FwStatus.OK);
    host.clear();
    host.run(1000);
    const hb = host.last('heartbeat', A)!;
    expect(hb.state).toBe(DeviceState.IDLE);
    expect([hb.fwMajor, hb.fwMinor, hb.fwPatch]).toEqual([2, 1, 0]);
  });

  it('classic 5-byte chunks work too', () => {
    const { host } = setup(false);
    enterBootloader(host);
    const file = makeDemoFirmware(Model.CYNCODER, '1.0.7', { size: 700 });
    expect(upload(host, file, FW_CHUNK_CLASSIC).at(-1)).toBe(FwStatus.OK);
    host.run(800);
    expect(host.last('heartbeat', A)!.fwPatch).toBe(7);
  });

  it('BAD_OFFSET tells where to resume', () => {
    const { host } = setup();
    enterBootloader(host);
    const file = makeDemoFirmware(Model.CYNCODER, '1.1.0', { size: 2000 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.run(200);
    host.send(encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }));
    const r = host.ask(encodeFwData(A, { offset: 122, bytes: file.slice(122, 183) }), 'fwAck', 5);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe(FwStatus.BAD_OFFSET);
    expect(r[0]!.nextOffset).toBe(61);
  });

  it('a corrupted transfer fails CRC and the board stays in the bootloader', () => {
    const { host, sim } = setup();
    enterBootloader(host);
    const file = makeDemoFirmware(Model.CYNCODER, '3.0.0', { size: 1500 });
    expect(upload(host, file, FW_CHUNK_FD, { corruptAt: 700 }).at(-1)).toBe(FwStatus.BAD_CRC);
    sim.powerCycle('enc');
    host.clear();
    host.run(900);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
  });

  it('an image for another model is BAD_IMAGE', () => {
    const { host } = setup();
    enterBootloader(host);
    expect(upload(host, makeDemoFirmware(Model.GYRO, '1.0.0', { size: 800 }), FW_CHUNK_FD).at(-1)).toBe(FwStatus.BAD_IMAGE);
  });

  it('the bootloader answers only what PROTOCOL §9 lists', () => {
    const { host } = setup();
    enterBootloader(host);
    expect(host.ask(encodeParamGet(A, { pid: 0x100 }), 'paramValue')).toHaveLength(0);
    expect(host.ask(encodeFaultReq(A), 'faultRsp')).toHaveLength(0);
    expect(host.ask(encodeInfoReq(A, { page: 3 }), 'infoRsp')).toHaveLength(0);
    expect(host.ask(encodeInfoReq(A, { page: 0 }), 'infoRsp')).toHaveLength(1);
    expect(host.ask(encodeCommand(A, { cmd: Command.SAVE_PARAMS, arg: 0 }), 'commandRsp')).toHaveLength(0);
    expect(host.ask(encodeCommand(A, { cmd: Command.REBOOT, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
    host.run(800);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);
  });

  it('injected flash error reports FLASH_ERROR', () => {
    const { host, sim } = setup();
    enterBootloader(host);
    sim.inject('enc', 'flashError', true);
    const file = makeDemoFirmware(Model.CYNCODER, '1.0.1', { size: 600 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.run(200);
    expect(host.ask(encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }), 'fwAck', 5)[0]!.status).toBe(FwStatus.FLASH_ERROR);
  });
});
