import type { BusFrameEvent, CanFrame, CygnusBus } from '@cygnus/protocol';

export const FRAME_TRACE_CAPACITY = 50_000;
const MAX_DATA = 64;

export interface TracedFrame {
  /** Sequence number since the trace was created (survives ring wrap-around). */
  seq: number;
  /** Host time, ms. */
  t: number;
  dir: 'rx' | 'tx';
  id: number;
  fd: boolean;
  brs: boolean;
  data: Uint8Array;
}

/**
 * Ring of the last N frames in struct-of-arrays form: one copy of the payload into a
 * preallocated slab per frame, no per-frame objects. The bus `frame` event (which costs the
 * host a little per frame) is only subscribed while someone holds the trace.
 */
export class FrameTrace {
  readonly capacity: number;
  private readonly t: Float64Array;
  private readonly id: Uint32Array;
  private readonly meta: Uint8Array; // bit0 tx, bit1 fd, bit2 brs
  private readonly len: Uint8Array;
  private readonly data: Uint8Array;
  private head = 0;
  private count = 0;
  private total = 0;
  private _version = 0;
  private users = 0;
  private bus: CygnusBus | null = null;
  private off: (() => void) | null = null;
  private paused = false;

  constructor(capacity = FRAME_TRACE_CAPACITY) {
    this.capacity = capacity;
    this.t = new Float64Array(capacity);
    this.id = new Uint32Array(capacity);
    this.meta = new Uint8Array(capacity);
    this.len = new Uint8Array(capacity);
    this.data = new Uint8Array(capacity * MAX_DATA);
  }

  get length(): number {
    return this.count;
  }

  /** Frames seen since creation/clear (also those already overwritten). */
  get totalSeen(): number {
    return this.total;
  }

  /** Increments on every change; poll it from a timer/rAF to refresh views. */
  get version(): number {
    return this._version;
  }

  get active(): boolean {
    return this.off !== null;
  }

  /** While paused frames are not recorded (the bus listener stays attached). */
  setPaused(p: boolean): void {
    this.paused = p;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Points the trace at a bus; called by the core when the connection changes. */
  setBus(bus: CygnusBus | null): void {
    this.detach();
    this.bus = bus;
    if (this.users > 0) this.attach();
  }

  /** Takes a reference; frames are captured while at least one is held. */
  subscribe(): () => void {
    this.users++;
    if (this.users === 1) this.attach();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.users === 0) this.detach();
    };
  }

  push(dir: 'rx' | 'tx', f: CanFrame): void {
    const i = this.head;
    const n = Math.min(f.data.length, MAX_DATA);
    this.t[i] = f.timestamp;
    this.id[i] = f.id >>> 0;
    this.meta[i] = (dir === 'tx' ? 1 : 0) | (f.fd ? 2 : 0) | (f.brs ? 4 : 0);
    this.len[i] = n;
    this.data.set(n === f.data.length ? f.data : f.data.subarray(0, n), i * MAX_DATA);
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.total++;
    this._version++;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.total = 0;
    this._version++;
  }

  private phys(i: number): number {
    return (this.head - this.count + i + this.capacity) % this.capacity;
  }

  /** i = 0 is the oldest kept frame. The returned payload is a copy. */
  get(i: number): TracedFrame | undefined {
    if (i < 0 || i >= this.count) return undefined;
    const p = this.phys(i);
    const m = this.meta[p] ?? 0;
    const n = this.len[p] ?? 0;
    return {
      seq: this.total - this.count + i,
      t: this.t[p] ?? 0,
      dir: m & 1 ? 'tx' : 'rx',
      id: this.id[p] ?? 0,
      fd: (m & 2) !== 0,
      brs: (m & 4) !== 0,
      data: this.data.slice(p * MAX_DATA, p * MAX_DATA + n),
    };
  }

  /** Raw id of frame i without allocating (filters). */
  idAt(i: number): number {
    return this.id[this.phys(i)] ?? 0;
  }

  dirAt(i: number): 'rx' | 'tx' {
    return (this.meta[this.phys(i)] ?? 0) & 1 ? 'tx' : 'rx';
  }

  /** As a CanFrame for `bus.describeFrame` (payload copied). */
  frameAt(i: number): CanFrame | undefined {
    const f = this.get(i);
    return f && { id: f.id, data: f.data, fd: f.fd, brs: f.brs, timestamp: f.t };
  }

  private attach(): void {
    if (!this.bus || this.off) return;
    this.off = this.bus.on('frame', (e: BusFrameEvent) => {
      if (!this.paused) this.push(e.dir, e.frame);
    });
  }

  private detach(): void {
    this.off?.();
    this.off = null;
  }
}

/** The app-wide trace (CAN monitor). `const off = frameTrace.subscribe()` while visible. */
export const frameTrace = new FrameTrace();
