import { signalByKey } from '../../catalog/catalog';
import { readU16 } from '../../core/bytes';
import { STREAM_SID_CLEAR, STREAM_SLOTS, Timing } from '../../core/constants';
import { encodeStreamConfig, encodeStreamStart, encodeStreamStop, streamDataCount, streamDataValue } from '../../core/messages';
import { CyError } from '../errors';
import type { DeviceStream, StreamDataCallback, StreamOpenOptions, StreamSubscription } from '../types';
import type { CyCanDevice } from './device';

const TICKS_PER_MS = 10;
const WRAP = 0x10000;
/** Fraction of a positive latency excursion the clock offset follows per sample (drift tracking). */
const OFFSET_CREEP = 0.01;

class Subscription implements StreamSubscription {
  readonly signals: readonly string[];
  readonly sids: readonly number[];
  /** Board slot of each of this consumer's signals. */
  slotOf: Int8Array;
  readonly values: Float32Array;
  readonly callbacks = new Set<StreamDataCallback>();
  lost = 0;
  samples = 0;
  closed = false;

  constructor(
    private readonly mux: CyCanStream,
    signals: readonly string[],
    sids: readonly number[],
    readonly requestedUs: number,
  ) {
    this.signals = signals;
    this.sids = sids;
    this.slotOf = new Int8Array(sids.length);
    this.values = new Float32Array(sids.length);
  }

  get periodUs(): number {
    return this.mux.periodUs;
  }

  onData(cb: StreamDataCallback): () => void {
    this.callbacks.add(cb);
    return () => {
      this.callbacks.delete(cb);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.clear();
    this.mux.remove(this);
  }
}

/**
 * High-rate streaming (PROTOCOL §8) with a per-device multiplexer: consumers share the 15
 * board slots, the board runs at the fastest requested period, and each sample is fanned
 * out to every consumer as a reused Float32Array in that consumer's signal order.
 */
export class CyCanStream implements DeviceStream {
  private readonly subs = new Set<Subscription>();
  /** sid per board slot, slots 0..n-1 packed. */
  private slots: number[] = [];
  periodUs = 0;
  private keepalive: unknown = undefined;
  // Sample assembly (classic mode sends one frame per slot under the same seq).
  private readonly sample = new Float32Array(STREAM_SLOTS);
  private filled = 0;
  private curSeq = -1;
  private curT = 0;
  private curHost = 0;
  private emitted = false;
  // Board clock → host clock.
  private lastRaw = -1;
  private lastHost = 0;
  private ticks = 0;
  private offset = 0;

  constructor(private readonly dev: CyCanDevice) {}

  get active(): boolean {
    return this.slots.length > 0;
  }

  get slotsUsed(): number {
    return this.slots.length;
  }

  open(opts: StreamOpenOptions): StreamSubscription {
    const dev = this.dev;
    dev.require('stream');
    dev.requireResolved();
    const def = dev.def;
    if (!def) throw new CyError('NOT_SUPPORTED', 'unknown model', { reason: 'stream' });
    const keys = [...new Set(opts.signals)];
    if (keys.length === 0) throw new CyError('INVALID', 'no signals', { reason: 'no_signals' });
    const sids = keys.map((k) => {
      const s = signalByKey(def, k);
      if (!s) throw new CyError('INVALID', `unknown signal ${k}`, { reason: 'unknown_signal' });
      return s.sid;
    });
    if (!Number.isFinite(opts.periodUs) || opts.periodUs <= 0) throw new CyError('INVALID', 'period', { reason: 'out_of_range' });
    const added = sids.filter((sid) => !this.slots.includes(sid));
    if (this.slots.length + added.length > STREAM_SLOTS) {
      throw new CyError('NO_SLOTS', `stream needs ${this.slots.length + added.length} slots, board has ${STREAM_SLOTS}`);
    }
    const sub = new Subscription(this, keys, sids, opts.periodUs);
    const wasIdle = this.slots.length === 0;
    this.subs.add(sub);
    const oldPeriod = this.periodUs;
    this.periodUs = this.targetPeriod();
    if (wasIdle) this.resetAssembly();
    // New slots are appended, so running consumers keep their slot numbers.
    const first = this.slots.length;
    this.slots.push(...added);
    for (let i = 0; i < added.length; i++) dev.send(encodeStreamConfig(dev.address, { slot: first + i, sid: added[i] ?? 0 }));
    this.mapSlots();
    if (wasIdle || added.length > 0 || oldPeriod !== this.periodUs) this.sendStart();
    if (this.keepalive === undefined) this.armKeepalive();
    return sub;
  }

  remove(sub: Subscription): void {
    if (!this.subs.delete(sub)) return;
    const dev = this.dev;
    if (this.subs.size === 0) {
      this.slots = [];
      this.periodUs = 0;
      this.cancelKeepalive();
      if (dev.online && dev.ctx.isOpen()) dev.send(encodeStreamStop(dev.address));
      return;
    }
    const needed = new Set<number>();
    for (const s of this.subs) for (const sid of s.sids) needed.add(sid);
    const oldPeriod = this.periodUs;
    this.periodUs = this.targetPeriod();
    if (needed.size === this.slots.length) {
      if (oldPeriod !== this.periodUs) this.sendStart();
      return;
    }
    // Slots must stay packed from 0: stop, rewrite the layout, clear the tail, restart.
    const old = this.slots.length;
    this.slots = this.slots.filter((sid) => needed.has(sid));
    this.mapSlots();
    dev.send(encodeStreamStop(dev.address));
    this.configureAll(old);
    this.resetAssembly();
    this.sendStart();
  }

  /** Board came back after being lost (it may have rebooted): rewrite the whole layout. */
  deviceBack(): void {
    if (this.slots.length === 0) return;
    this.configureAll(0);
    this.resetAssembly();
    this.sendStart();
  }

  /** Transport down / device removed: close every consumer without sending anything. */
  halt(): void {
    this.cancelKeepalive();
    const subs = [...this.subs];
    this.subs.clear();
    this.slots = [];
    this.periodUs = 0;
    for (const s of subs) {
      s.closed = true;
      s.callbacks.clear();
    }
  }

  handleData(d: Uint8Array, now: number): void {
    const n = this.slots.length;
    if (n === 0) return;
    const count = streamDataCount(d);
    if (count === 0) return;
    const seq = d[0] ?? 0;
    if (seq !== this.curSeq) {
      if (this.curSeq >= 0) {
        const gap = (seq - this.curSeq - 1) & 0xff;
        // A huge gap is a late or duplicated frame rather than 200+ lost samples.
        if (gap >= 128) return;
        if (this.filled !== 0 && !this.emitted) this.emit(n);
        if (gap > 0) for (const s of this.subs) s.lost += gap;
      }
      this.curSeq = seq;
      this.filled = 0;
      this.emitted = false;
      this.curT = readU16(d, 2);
      this.curHost = now;
    } else if (this.emitted) {
      return;
    }
    const first = d[1] ?? 0;
    // FD padding may add values past the configured slots; those are dropped here.
    for (let i = 0; i < count; i++) {
      const slot = first + i;
      if (slot >= n) break;
      this.sample[slot] = streamDataValue(d, i);
      this.filled |= 1 << slot;
    }
    if (this.filled === (1 << n) - 1) this.emit(n);
  }

  private emit(n: number): void {
    this.emitted = true;
    const t = this.hostTime(this.curT, this.curHost);
    const full = this.filled === (1 << n) - 1;
    for (const s of this.subs) {
      const v = s.values;
      for (let j = 0; j < v.length; j++) {
        const slot = s.slotOf[j] ?? 0;
        v[j] = full || (this.filled >> slot) & 1 ? (this.sample[slot] ?? NaN) : NaN;
      }
      s.samples++;
      for (const cb of s.callbacks) cb(t, v);
    }
  }

  /**
   * Unwraps the 16-bit 100 µs board counter and maps it onto host time. The offset follows
   * the smallest observed latency immediately and creeps up slowly, which absorbs jitter and
   * clock drift. After a long silence the host clock decides how many wraps were missed.
   */
  private hostTime(raw: number, now: number): number {
    if (this.lastRaw < 0) {
      this.ticks = 0;
      this.offset = now;
    } else {
      let delta = (raw - this.lastRaw) & 0xffff;
      const hostTicks = (now - this.lastHost) * TICKS_PER_MS;
      if (hostTicks > WRAP / 2) {
        const wraps = Math.round((hostTicks - delta) / WRAP);
        if (wraps > 0) delta += wraps * WRAP;
      }
      this.ticks += delta;
    }
    this.lastRaw = raw;
    this.lastHost = now;
    const boardMs = this.ticks / TICKS_PER_MS;
    const candidate = now - boardMs;
    if (candidate < this.offset) this.offset = candidate;
    else this.offset += (candidate - this.offset) * OFFSET_CREEP;
    return this.offset + boardMs;
  }

  private resetAssembly(): void {
    this.curSeq = -1;
    this.filled = 0;
    this.emitted = false;
    this.lastRaw = -1;
  }

  private targetPeriod(): number {
    let p = Infinity;
    for (const s of this.subs) p = Math.min(p, s.requestedUs);
    return Math.max(p, this.dev.def?.stream.minPeriodUs ?? 0);
  }

  private mapSlots(): void {
    for (const s of this.subs) {
      for (let j = 0; j < s.sids.length; j++) s.slotOf[j] = this.slots.indexOf(s.sids[j] ?? -1);
    }
  }

  private configureAll(previousCount: number): void {
    const dev = this.dev;
    for (let i = 0; i < this.slots.length; i++) dev.send(encodeStreamConfig(dev.address, { slot: i, sid: this.slots[i] ?? 0 }));
    for (let i = this.slots.length; i < previousCount; i++) dev.send(encodeStreamConfig(dev.address, { slot: i, sid: STREAM_SID_CLEAR }));
  }

  private sendStart(): void {
    const period100us = Math.max(1, Math.min(0xffff, Math.round(this.periodUs / 100)));
    this.dev.send(encodeStreamStart(this.dev.address, { period100us }));
  }

  private armKeepalive(): void {
    this.keepalive = this.dev.ctx.scheduler.setTimeout(() => {
      this.keepalive = undefined;
      if (this.slots.length === 0) return;
      this.sendStart();
      this.armKeepalive();
    }, Timing.STREAM_KEEPALIVE_MS);
  }

  private cancelKeepalive(): void {
    if (this.keepalive !== undefined) this.dev.ctx.scheduler.clearTimeout(this.keepalive);
    this.keepalive = undefined;
  }
}
