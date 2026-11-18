import {
  BROADCAST_ALL,
  Cls,
  Command,
  CommandStatus,
  DeviceState,
  DevType,
  ENTER_BOOTLOADER_INTENT,
  FW_CHUNK_CLASSIC,
  FW_CHUNK_FD,
  FwReq,
  FwStatus,
  Model,
  RECOVERY_BEACON_PERIOD_MS,
  RECOVERY_STAY_MAGIC,
  crc32,
  encodeCommand,
  encodeFwBegin,
  encodeFwData,
  encodeFwEnd,
  encodeInfoReq,
  encodeParamGet,
  encodeParamSet,
  encodeFaultReq,
  messageId,
  validateCyfw,
  PType,
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

function intent(enc: CyncoderNode): number {
  return (ENTER_BOOTLOADER_INTENT | enc.uid16) >>> 0;
}

function enterBootloader(host: Host, enc: CyncoderNode): void {
  expect(host.ask(encodeCommand(A, { cmd: Command.ENTER_BOOTLOADER, arg: intent(enc) }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
  host.run(700);
  expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
}

/**
 * Host side of PROTOCOL §9: BEGIN, header, BUSY while erasing, then windows of 16 DATA frames
 * resumed from every ACK's next_offset; returns every ACK status seen, in order.
 */
function upload(host: Host, file: Uint8Array, chunk: number, o: { corruptAt?: number; end?: boolean } = {}): number[] {
  const statuses: number[] = [];
  host.clear();
  host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
  host.run(5);
  statuses.push(...host.of('fwAck', A).map((a) => a.status));
  if (statuses.at(-1) !== FwStatus.OK) return statuses;
  let off = 0;
  for (let guard = 0; guard < 5000 && off < file.length; guard++) {
    host.clear();
    let o2 = off;
    for (let sent = 0; sent < 16 && o2 < file.length; sent++) {
      const bytes = file.slice(o2, o2 + chunk);
      if (o.corruptAt !== undefined && o2 <= o.corruptAt && o.corruptAt < o2 + chunk) bytes[o.corruptAt - o2]! ^= 0xff;
      host.send(encodeFwData(A, { offset: o2, bytes }));
      o2 += bytes.length;
    }
    host.run(12); // 16 FD frames take ~5 ms of wire time
    let acks = host.of('fwAck', A);
    statuses.push(...acks.map((a) => a.status));
    if (acks.at(-1)?.status === FwStatus.BUSY) {
      // Header accepted: wait for the erase to finish; its OK says where to resume.
      for (let t = 0; t < 400 && !host.of('fwAck', A).some((a) => a.status !== FwStatus.BUSY); t += 5) host.run(5);
      acks = host.of('fwAck', A).filter((a) => a.status !== FwStatus.BUSY);
      statuses.push(...acks.map((a) => a.status));
    }
    const last = acks.at(-1);
    if (!last) off = o2; // short final window: END's ACK closes it
    else if (last.status === FwStatus.OK || last.status === FwStatus.BAD_OFFSET) off = last.nextOffset;
    else return statuses;
  }
  if (o.end === false) return statuses;
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

  it('ENTER_BOOTLOADER needs the intent value 0xB0070000 | uid16', () => {
    const { host, enc } = setup();
    for (const arg of [0, ENTER_BOOTLOADER_INTENT, (intent(enc) ^ 1) >>> 0]) {
      expect(host.ask(encodeCommand(A, { cmd: Command.ENTER_BOOTLOADER, arg }), 'commandRsp')[0]!.status).toBe(CommandStatus.INVALID_ARG);
    }
    expect(enc.mode).toBe(2);
    enterBootloader(host, enc);
  });

  it('FD update: BEGIN OK, header, BUSY while erasing, OK at 64, windowed ACKs, new version after END', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '2.1.0', { size: 5000 });
    const st = upload(host, file, FW_CHUNK_FD);
    expect(st.slice(0, 3)).toEqual([FwStatus.OK, FwStatus.BUSY, FwStatus.OK]);
    expect(st.at(-1)).toBe(FwStatus.OK);
    host.run(1000);
    const hbs = host.of('heartbeat', A);
    // PROTOCOL §4.1: the application's first heartbeat says BOOT.
    expect(hbs[0]!.state).toBe(DeviceState.BOOT);
    expect(hbs.at(-1)!.state).toBe(DeviceState.IDLE);
    expect([hbs.at(-1)!.fwMajor, hbs.at(-1)!.fwMinor, hbs.at(-1)!.fwPatch]).toEqual([2, 1, 0]);
  });

  it('the erase OK resumes at next_offset 64 even when the window ran past the header', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '2.2.0', { size: 3000 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.run(5);
    host.clear();
    for (let o = 0; o < 16 * 61; o += 61) host.send(encodeFwData(A, { offset: o, bytes: file.slice(o, o + 61) }));
    host.run(300);
    const acks = host.of('fwAck', A);
    expect(acks.map((a) => a.status)).toEqual([FwStatus.BUSY, FwStatus.OK]);
    expect(acks[1]!.nextOffset).toBe(64);
  });

  it('classic 5-byte chunks work too', () => {
    const { host, enc } = setup(false);
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.0.7', { size: 700 });
    expect(upload(host, file, FW_CHUNK_CLASSIC).at(-1)).toBe(FwStatus.OK);
    host.run(800);
    expect(host.last('heartbeat', A)!.fwPatch).toBe(7);
  });

  it('BAD_OFFSET tells where to resume, once per window of stray frames', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.1.0', { size: 2000 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.run(5);
    host.send(encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }));
    const r = host.ask(encodeFwData(A, { offset: 122, bytes: file.slice(122, 183) }), 'fwAck', 5);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe(FwStatus.BAD_OFFSET);
    expect(r[0]!.nextOffset).toBe(61);
    // 15 more stray frames complete that window silently; the 17th stray frame opens another.
    host.clear();
    for (let i = 0; i < 16; i++) host.send(encodeFwData(A, { offset: 183 + 61 * i, bytes: file.slice(0, 61) }));
    host.run(10);
    const again = host.of('fwAck', A);
    expect(again.map((a) => a.status)).toEqual([FwStatus.BAD_OFFSET]);
    expect(again[0]!.nextOffset).toBe(61);
  });

  it('DATA whose length is not a whole frame length is ignored (padding is never data)', () => {
    const { host, sim, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.1.1', { size: 1000 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.run(5);
    const d = new Uint8Array(10); // 3 + 7: not a CAN(-FD) length
    d.set(file.slice(0, 7), 3);
    host.send({ id: messageId(A, Cls.FW_REQ, FwReq.DATA), data: d, fd: true, brs: true });
    host.run(5);
    expect(sim.node('enc').fwProgress.received).toBe(0);
  });

  it('BEGIN during a transfer starts over; after END every FW request is BUSY until the app starts', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.3.0', { size: 400 });
    host.send(encodeFwBegin(A, { size: 4000, crc32: 1 }));
    host.run(5);
    host.send(encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }));
    host.run(5);
    expect(enc.fwProgress.received).toBe(61);
    // upload() sends a new BEGIN: the transfer restarts from offset 0 and completes.
    expect(upload(host, file, FW_CHUNK_FD, { end: false }).at(-1)).not.toBe(FwStatus.BAD_OFFSET);
    host.clear();
    host.send(encodeFwEnd(A));
    host.run(3);
    for (const f of [encodeFwBegin(A, { size: file.length, crc32: crc32(file) }), encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }), encodeFwEnd(A)]) {
      expect(host.ask(f, 'fwAck', 2).map((a) => a.status)).toEqual([FwStatus.BUSY]);
    }
    host.run(600);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);
    expect(enc.firmware).toEqual({ major: 1, minor: 3, patch: 0 });
  });

  it('a corrupted transfer fails CRC and the board stays in the bootloader', () => {
    const { host, sim, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '3.0.0', { size: 1500 });
    expect(upload(host, file, FW_CHUNK_FD, { corruptAt: 700 }).at(-1)).toBe(FwStatus.BAD_CRC);
    sim.powerCycle('enc');
    host.clear();
    host.run(900);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
    expect(host.last('heartbeat', A)!.fwMajor).toBe(0); // no valid image: 0.0.0
  });

  it('an image for another model is BAD_IMAGE at the header; the installed app is untouched', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const st = upload(host, makeDemoFirmware(Model.GYRO, '1.0.0', { size: 800 }), FW_CHUNK_FD);
    // Frames of that window that follow the header find no transfer any more.
    expect(st.slice(0, 2)).toEqual([FwStatus.OK, FwStatus.BAD_IMAGE]);
    expect(new Set(st.slice(2))).toEqual(new Set([FwStatus.WRONG_STATE]));
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', A)!.fwMajor).toBe(1); // still reports the installed 1.0.0
    expect(host.ask(encodeCommand(A, { cmd: Command.REBOOT, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
    host.run(800);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);
    expect(enc.firmware.major).toBe(1);
  });

  it('the bootloader answers only what PROTOCOL §9 lists; REBOOT fails without a valid image', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    expect(host.ask(encodeParamGet(A, { pid: 0x100 }), 'paramValue')).toHaveLength(0);
    expect(host.ask(encodeFaultReq(A), 'faultRsp')).toHaveLength(0);
    expect(host.ask(encodeInfoReq(A, { page: 3 }), 'infoRsp')).toHaveLength(0);
    expect(host.ask(encodeInfoReq(A, { page: 0 }), 'infoRsp')).toHaveLength(1);
    expect(host.ask(encodeCommand(A, { cmd: Command.SAVE_PARAMS, arg: 0 }), 'commandRsp')).toHaveLength(0);
    expect(host.ask(encodeCommand(A, { cmd: Command.REBOOT, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.OK);
    host.run(800);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);

    // Erase the image (valid header, then stop), so REBOOT has nothing to start.
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.4.0', { size: 2000 });
    host.send(encodeFwBegin(A, { size: file.length, crc32: crc32(file) }));
    host.send(encodeFwData(A, { offset: 0, bytes: file.slice(0, 61) }));
    host.send(encodeFwData(A, { offset: 61, bytes: file.slice(61, 122) }));
    host.run(300);
    expect(host.ask(encodeCommand(A, { cmd: Command.REBOOT, arg: 0 }), 'commandRsp')[0]!.status).toBe(CommandStatus.FAILED);
    host.run(600);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
  });

  it('the bootloader ignores broadcast FW frames', () => {
    const { host, enc } = setup();
    enterBootloader(host, enc);
    const file = makeDemoFirmware(Model.CYNCODER, '1.5.0', { size: 400 });
    expect(host.ask(encodeFwBegin({ devType: DevType.ENCODER, num: 0 }, { size: file.length, crc32: crc32(file) }), 'fwAck')).toHaveLength(0);
    expect(host.ask(encodeFwBegin(BROADCAST_ALL, { size: file.length, crc32: crc32(file) }), 'fwAck')).toHaveLength(0);
    expect(enc.fwProgress.phase).toBe('idle');
  });

  it('injected flash error reports FLASH_ERROR', () => {
    const { host, sim, enc } = setup();
    enterBootloader(host, enc);
    sim.inject('enc', 'flashError', true);
    const file = makeDemoFirmware(Model.CYNCODER, '1.0.1', { size: 600 });
    const st = upload(host, file, FW_CHUNK_FD);
    expect(st.slice(0, 4)).toEqual([FwStatus.OK, FwStatus.BUSY, FwStatus.OK, FwStatus.FLASH_ERROR]);
  });

  it('the bootloader runs on the stored can.data_bitrate; a corrupt store means classic', () => {
    const { host, sim, enc } = setup();
    // RAM change without SAVE: the bootloader keeps the stored FD rate.
    host.send(encodeParamSet(A, { pid: 0x0001, ptype: PType.ENUM, value: 0 }));
    host.run(5);
    enterBootloader(host, enc);
    expect(enc.fdMode).toBe(true);
    sim.inject('enc', 'paramCrc');
    enc.reboot(true);
    host.run(50);
    expect(enc.mode).toBe(3);
    expect(enc.fdMode).toBe(false);
  });
});

describe('recovery window (PROTOCOL §9.0)', () => {
  const beacon = encodeCommand(BROADCAST_ALL, { cmd: Command.ENTER_BOOTLOADER, arg: RECOVERY_STAY_MAGIC });

  it('a CRC-valid but broken application is silent; the boot-time beacon keeps the bootloader', () => {
    const { host, sim, enc } = setup();
    sim.inject('enc', 'brokenApp');
    sim.powerCycle('enc');
    host.clear();
    host.run(2000);
    expect(host.of('heartbeat', A)).toHaveLength(0);
    expect(enc.hangs).toBe(true);
    // Studio's recovery mode: beacon every 20 ms while the user power-cycles the board.
    sim.setPower('enc', false);
    host.run(50);
    sim.setPower('enc', true);
    for (let t = 0; t < 300; t += RECOVERY_BEACON_PERIOD_MS) {
      host.send(beacon);
      host.run(RECOVERY_BEACON_PERIOD_MS);
    }
    host.run(600);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.BOOTLOADER);
    expect(host.last('heartbeat', A)!.fwMajor).toBe(1); // the broken image is still installed
    const file = makeDemoFirmware(Model.CYNCODER, '1.0.2', { size: 900 });
    expect(upload(host, file, FW_CHUNK_FD).at(-1)).toBe(FwStatus.OK);
    host.clear();
    host.run(600);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);
    expect(host.last('heartbeat', A)!.fwPatch).toBe(2);
  });

  it('the beacon only counts during the first 150 ms; a running application ignores it silently', () => {
    const { host, sim, enc } = setup();
    expect(host.ask(beacon, 'commandRsp', 20)).toHaveLength(0);
    expect(enc.mode).toBe(2);
    sim.powerCycle('enc');
    host.run(200); // window over: the app is up
    host.send(beacon);
    host.run(600);
    expect(host.last('heartbeat', A)!.state).toBe(DeviceState.IDLE);
  });
});
