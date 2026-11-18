import { Cls, CommandStatus, ParamStatus, SysReq, decodeId, decodeMessage, isToDeviceClass } from '@cygnus/protocol';
import { FLAG_ERROR, FLAG_UNANSWERED } from './filter';
import { frameKind } from './ids';

/** What the annotator needs from a frame source (`FrameTrace` satisfies it). */
export interface FrameSource {
  readonly length: number;
  readonly totalSeen: number;
  get(i: number): { seq: number; t: number; dir: 'rx' | 'tx'; id: number; data: Uint8Array } | undefined;
}

/** Host request → the response class (and index) that answers it; null when none is expected. */
export function expectedResponse(id: number): { cls: number; index: number } | null {
  const f = decodeId(id);
  if (frameKind(id) !== 'cycan') return null;
  if (f.cls === Cls.SYS_REQ) {
    switch (f.index) {
      case SysReq.ENUM_REQ:
      case SysReq.ASSIGN_ID:
        return { cls: Cls.ENUM_RSP, index: -1 };
      case SysReq.INFO_REQ:
        return { cls: Cls.SYS_RSP, index: 3 };
      case SysReq.COMMAND:
        return { cls: Cls.SYS_RSP, index: 5 };
      case SysReq.FAULT_REQ:
        return { cls: Cls.SYS_RSP, index: 6 };
      default:
        return null;
    }
  }
  if (f.cls === Cls.PARAM_REQ) return { cls: Cls.PARAM_RSP, index: 0 };
  return null;
}

/** True when a received frame reports a problem (fault, rejected parameter or command). */
export function isErrorFrame(id: number, data: Uint8Array): boolean {
  const f = decodeId(id);
  if (frameKind(id) !== 'cycan') return false;
  if (f.cls !== Cls.SYS_RSP && f.cls !== Cls.PARAM_RSP) return false;
  const m = decodeMessage(id, data);
  if (!m) return false;
  switch (m.kind) {
    case 'heartbeat':
      return m.fault !== 0;
    case 'faultRsp':
      return m.active !== 0;
    case 'commandRsp':
      return m.status !== CommandStatus.OK && m.status !== CommandStatus.IN_PROGRESS;
    case 'paramValue':
      return m.status !== ParamStatus.OK;
    default:
      return false;
  }
}

interface Pending {
  seq: number;
  t: number;
  devType: number;
  num: number;
  cls: number;
  index: number;
}

/** A request not answered within this time is flagged (ms of bus time). */
export const RESPONSE_TIMEOUT_MS = 250;

/**
 * Walks new frames once and keeps one flag byte per frame: error responses, and host requests
 * that no board answered in time. Flags live in a ring parallel to the trace, indexed by
 * sequence number, so they survive filtering and need no per-frame objects.
 */
export class FrameAnnotator {
  private readonly flags: Uint8Array;
  private processed = 0;
  private pending: Pending[] = [];
  private latestT = 0;

  constructor(private readonly capacity: number) {
    this.flags = new Uint8Array(capacity);
  }

  reset(): void {
    this.flags.fill(0);
    this.processed = 0;
    this.pending = [];
    this.latestT = 0;
  }

  flagsOf(seq: number): number {
    return this.flags[seq % this.capacity] ?? 0;
  }

  update(src: FrameSource): void {
    if (src.totalSeen < this.processed) this.reset();
    const oldest = src.totalSeen - src.length;
    // The trace wrapped past frames we never saw: their requests can no longer be flagged.
    if (this.processed < oldest) {
      this.processed = oldest;
      this.pending = [];
    }
    for (let seq = this.processed; seq < src.totalSeen; seq++) {
      const f = src.get(seq - oldest);
      if (f) this.ingest(f);
    }
    this.processed = src.totalSeen;
    this.expire(oldest);
  }

  private ingest(f: { seq: number; t: number; dir: 'rx' | 'tx'; id: number; data: Uint8Array }): void {
    this.flags[f.seq % this.capacity] = 0;
    if (f.t > this.latestT) this.latestT = f.t;
    if (frameKind(f.id) !== 'cycan') return;
    const id = decodeId(f.id);
    if (f.dir === 'tx') {
      const exp = expectedResponse(f.id);
      if (exp) this.pending.push({ seq: f.seq, t: f.t, devType: id.devType, num: id.num, cls: exp.cls, index: exp.index });
      return;
    }
    if (isToDeviceClass(id.cls)) return;
    if (isErrorFrame(f.id, f.data)) this.flags[f.seq % this.capacity] = FLAG_ERROR;
    const hit = this.pending.findIndex(
      (p) =>
        p.cls === id.cls &&
        (p.index < 0 || p.index === id.index) &&
        // ENUM_RSP carries a hash in the low bits, so only the device type is comparable.
        (p.devType === 0 || p.devType === id.devType) &&
        (id.cls === Cls.ENUM_RSP || p.num === 0 || p.num === id.num),
    );
    if (hit >= 0) this.pending.splice(hit, 1);
  }

  private expire(oldestSeq: number): void {
    const keep: Pending[] = [];
    for (const p of this.pending) {
      if (this.latestT - p.t <= RESPONSE_TIMEOUT_MS) keep.push(p);
      else if (p.seq >= oldestSeq) this.flags[p.seq % this.capacity] = (this.flags[p.seq % this.capacity] ?? 0) | FLAG_UNANSWERED;
    }
    this.pending = keep;
  }
}
