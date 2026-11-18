import { dlcToLength, lengthToDlc } from '../core/fd';
import type { CanFrame, TxFrame } from '../core/frame';
import { ID_MASK } from '../core/id';

/*
 * slcan (Lawicel ASCII) with the CANable 2.0 CAN-FD extensions:
 *   T iiiiiiii L dd…  classic, 29-bit id      t iii L dd…  classic, 11-bit id
 *   D / d             FD without bit-rate switch (29-bit / 11-bit)
 *   B / b             FD with bit-rate switch
 *   R / r             remote frames
 * L is one hex digit (FD DLC code 0..F). Adapter replies: '\r' OK, '\x07' error,
 * 'z'/'Z' transmit acknowledged (Lawicel). An optional 4-hex-digit timestamp may follow the data.
 * CyCAN only uses 29-bit data frames, so 11-bit and remote frames are reported as ignored.
 */

const CR = 0x0d;
const LF = 0x0a;
const BEL = 0x07;
const MAX_LINE = 160;

export type SlcanDataBitrate = 0 | 2 | 5 | 8;

/** Setup sequence for 1 Mbit/s nominal; `dataBitrate` 0 keeps the adapter in classic mode. */
export function slcanSetupCommands(dataBitrate: SlcanDataBitrate): string[] {
  const cmds = ['C', 'S8'];
  if (dataBitrate !== 0) cmds.push(`Y${dataBitrate}`);
  cmds.push('O');
  return cmds;
}

export function encodeSlcanCommand(cmd: string): Uint8Array {
  const out = new Uint8Array(cmd.length + 1);
  for (let i = 0; i < cmd.length; i++) out[i] = cmd.charCodeAt(i) & 0x7f;
  out[cmd.length] = CR;
  return out;
}

const HEX_UPPER = '0123456789ABCDEF';

/**
 * Encodes an extended-id frame. Classic frames must be ≤ 8 bytes; FD payloads that are not
 * a valid FD length are zero padded to the next one.
 */
export function encodeSlcanFrame(f: TxFrame): Uint8Array {
  if (f.id < 0 || f.id > ID_MASK) throw new RangeError('slcan: id exceeds 29 bits');
  let len = f.data.length;
  let dlc: number;
  if (f.fd) {
    dlc = lengthToDlc(len);
    if (dlc < 0) throw new RangeError('slcan: FD payload exceeds 64 bytes');
    len = dlcToLength(dlc);
  } else {
    if (len > 8) throw new RangeError('slcan: classic payload exceeds 8 bytes');
    dlc = len;
  }
  const out = new Uint8Array(1 + 8 + 1 + 2 * len + 1);
  out[0] = (f.fd ? (f.brs ? 'B' : 'D') : 'T').charCodeAt(0);
  for (let i = 0; i < 8; i++) out[1 + i] = HEX_UPPER.charCodeAt((f.id >>> (28 - 4 * i)) & 15);
  out[9] = HEX_UPPER.charCodeAt(dlc);
  for (let i = 0; i < len; i++) {
    const b = f.data[i] ?? 0;
    out[10 + 2 * i] = HEX_UPPER.charCodeAt(b >> 4);
    out[11 + 2 * i] = HEX_UPPER.charCodeAt(b & 15);
  }
  out[out.length - 1] = CR;
  return out;
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

export interface SlcanEvents {
  frame?(f: CanFrame): void;
  /** Empty line: previous command accepted. */
  ack?(): void;
  /** BEL: previous command rejected. */
  nack?(): void;
  /** 'z' / 'Z': transmit accepted (Lawicel adapters). */
  txAck?(): void;
  /** Well-formed 11-bit or remote frame, which CyCAN ignores. */
  ignored?(): void;
  /** Malformed or overlong line, or an unrecognised reply (e.g. version strings). */
  other?(line: string): void;
}

/**
 * Incremental slcan line parser. Bytes may arrive split anywhere; frames are emitted as soon
 * as their terminating CR arrives. The line buffer is reused, so steady-state parsing only
 * allocates each frame's payload.
 */
export class SlcanParser {
  private readonly buf = new Uint8Array(MAX_LINE);
  private len = 0;
  private overflow = false;

  constructor(private readonly events: SlcanEvents) {}

  reset(): void {
    this.len = 0;
    this.overflow = false;
  }

  push(chunk: Uint8Array, timestamp: number): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i] ?? 0;
      if (c === BEL) {
        this.reset();
        this.events.nack?.();
      } else if (c === CR) {
        if (this.overflow) this.events.other?.('<overlong line>');
        else this.line(timestamp);
        this.reset();
      } else if (c === LF) {
        // Some adapters send CRLF; LF carries no meaning.
      } else if (this.len < MAX_LINE) {
        this.buf[this.len++] = c;
      } else {
        this.overflow = true;
      }
    }
  }

  private line(timestamp: number): void {
    const b = this.buf;
    const n = this.len;
    if (n === 0) {
      this.events.ack?.();
      return;
    }
    const t = b[0] ?? 0;
    if (n === 1 && (t === 0x7a || t === 0x5a)) {
      this.events.txAck?.();
      return;
    }
    let ext: boolean;
    let fd = false;
    let brs = false;
    let remote = false;
    switch (String.fromCharCode(t)) {
      case 'T':
        ext = true;
        break;
      case 't':
        ext = false;
        break;
      case 'R':
        ext = true;
        remote = true;
        break;
      case 'r':
        ext = false;
        remote = true;
        break;
      case 'D':
        ext = true;
        fd = true;
        break;
      case 'd':
        ext = false;
        fd = true;
        break;
      case 'B':
        ext = true;
        fd = brs = true;
        break;
      case 'b':
        ext = false;
        fd = brs = true;
        break;
      default:
        this.events.other?.(this.text());
        return;
    }
    const idLen = ext ? 8 : 3;
    if (n < 1 + idLen + 1) return this.bad();
    let id = 0;
    for (let i = 1; i <= idLen; i++) {
      const v = hexVal(b[i] ?? 0);
      if (v < 0) return this.bad();
      id = id * 16 + v;
    }
    const dlc = hexVal(b[1 + idLen] ?? 0);
    if (dlc < 0 || (!fd && dlc > 8)) return this.bad();
    const dataLen = fd ? dlcToLength(dlc) : dlc;
    const dataStart = 2 + idLen;
    const hexLen = remote ? 0 : 2 * dataLen;
    const rest = n - dataStart - hexLen;
    // Optional 4-digit timestamp after the payload.
    if (rest !== 0 && rest !== 4) return this.bad();
    if ((ext && id > ID_MASK) || (!ext && id > 0x7ff)) return this.bad();
    if (!ext || remote) {
      this.events.ignored?.();
      return;
    }
    const data = new Uint8Array(dataLen);
    for (let i = 0; i < dataLen; i++) {
      const hi = hexVal(b[dataStart + 2 * i] ?? 0);
      const lo = hexVal(b[dataStart + 2 * i + 1] ?? 0);
      if (hi < 0 || lo < 0) return this.bad();
      data[i] = (hi << 4) | lo;
    }
    this.events.frame?.({ id, data, fd, brs, timestamp });
  }

  private bad(): void {
    this.events.other?.(this.text());
  }

  private text(): string {
    let s = '';
    for (let i = 0; i < this.len; i++) s += String.fromCharCode(this.buf[i] ?? 0);
    return s;
  }
}
