import { signalByKey } from '../../catalog/catalog';
import { readU16 } from '../../core/bytes';
import {
  BUS_LOAD_STREAM_LIMIT,
  DataBitrate,
  STREAM_MAX_SLOTS_CLASSIC,
  STREAM_SID_CLEAR,
  STREAM_SLOTS,
  Timing,
} from '../../core/constants';
import { dlcToLength, lengthToDlc } from '../../core/fd';
import { encodeStreamConfig, encodeStreamStart, encodeStreamStop, streamDataCount, streamDataValue } from '../../core/messages';
import { CyError } from '../errors';
import { frameTimeUs } from '../stats';
import type { DeviceStream, StreamDataCallback, StreamOpenOptions, StreamSubscription } from '../types';
import type { CyCanDevice } from './device';

const TICKS_PER_MS = 10;
const WRAP = 0x10000;
/** Fraction of a positive latency excursion the clock offset follows per sample (drift tracking). */
const OFFSET_CREEP = 0.01;
/**
 * Delay between STOP and the new layout when slots are repacked. Sent together, CAN arbitration
 * would put CONFIG/START (lower INDEX) ahead of STOP and leave the board stopped.
 */
export const STREAM_REPACK_DELAY_MS = 2;
const NOMINAL_BPS = 1_000_000;
const DATA_BPS = 2_000_000;

/** Bytes an FD frame carrying `len` payload bytes actually has (DLC rounding). */
function fdLength(len: number): number {
  return dlcToLength(lengthToDlc(len));
}

/**
 * Fraction of the nominal bus a stream of `slots` signals every `periodUs` occupies
 * (PROTOCOL §8: FD packs all slots in one DATA frame, classic sends one frame per slot).
 */
export function streamLoad(slots: number, periodUs: number, classic: boolean): number {
  if (slots === 0 || periodUs <= 0) return 0;
  const perSample = classic
    ? slots * frameTimeUs({ data: new Uint8Array(8), fd: false, brs: false }, NOMINAL_BPS, DATA_BPS)
    : frameTimeUs({ data: new Uint8Array(fdLength(4 + 4 * slots)), fd: slots > 1, brs: slots > 1 }, NOMINAL_BPS, DATA_BPS);
  return perSample / periodUs;
}

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
  /** Slots the board has configured (cleared up to this many when the layout shrinks). */
  private boardCount = 0;
  /** Pending repack: DATA is dropped until the new layout is started. */
  private repackTimer: unknown = undefined;
  /** Estimated load committed to the bus budget for this stream. */
  private load = 0;
  /** Host time of the last DATA frame (or of the last (re)start). */
  private lastDataAt = 0;
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
    const need = this.slots.length + added.length;
    const classic = this.classic;
    if (classic && need > STREAM_MAX_SLOTS_CLASSIC) {
      throw new CyError('NO_SLOTS', `classic CAN streams at most ${STREAM_MAX_SLOTS_CLASSIC} signals, ${need} requested`, {
        reason: 'classic_limit',
      });
    }
    if (need > STREAM_SLOTS) {
      throw new CyError('NO_SLOTS', `stream needs ${need} slots, board has ${STREAM_SLOTS}`);
    }
    const period = Math.max(Math.min(opts.periodUs, this.subs.size > 0 ? this.periodUs : Infinity), def.stream.minPeriodUs);
    const load = streamLoad(need, period, classic);
    const projected = dev.ctx.estimatedLoad() + load - this.load;
    if (load > this.load && projected > BUS_LOAD_STREAM_LIMIT) {
      throw new CyError(
        'NO_BANDWIDTH',
        `stream would raise the estimated bus load to ${Math.round(projected * 100)} % (limit ${Math.round(BUS_LOAD_STREAM_LIMIT * 100)} %)`,
        { reason: 'bus_load' },
      );
    }
    const sub = new Subscription(this, keys, sids, opts.periodUs);
    const wasIdle = this.slots.length === 0;
    this.subs.add(sub);
    const oldPeriod = this.periodUs;
    this.periodUs = this.targetPeriod();
    if (wasIdle) {
      this.resetAssembly();
      this.lastDataAt = dev.ctx.scheduler.now();
    }
    // New slots are appended, so running consumers keep their slot numbers.
    const first = this.slots.length;
    this.slots.push(...added);
    this.mapSlots();
    this.commitLoad();
    // A pending repack lays out every slot when it fires.
    if (this.repackTimer === undefined) {
      for (let i = 0; i < added.length; i++) dev.send(encodeStreamConfig(dev.address, { slot: first + i, sid: added[i] ?? 0 }));
      this.boardCount = Math.max(this.boardCount, this.slots.length);
      if (wasIdle || added.length > 0 || oldPeriod !== this.periodUs) this.sendStart();
    }
    if (this.keepalive === undefined) this.armKeepalive();
    return sub;
  }

  /** The board streams one frame per slot: the link or the board runs classic CAN. */
  private get classic(): boolean {
    return !this.dev.ctx.transportFd || this.dev.cachedParam('can.data_bitrate') === DataBitrate.CLASSIC;
  }

  private commitLoad(): void {
    const load = streamLoad(this.slots.length, this.periodUs, this.classic);
    if (load !== this.load) this.dev.ctx.commitStreamLoad(load - this.load);
    this.load = load;
  }

  remove(sub: Subscription): void {
    if (!this.subs.delete(sub)) return;
    const dev = this.dev;
    if (this.subs.size === 0) {
      this.slots = [];
      this.periodUs = 0;
      this.boardCount = 0;
      this.cancelKeepalive();
      this.cancelRepack();
      this.commitLoad();
      if (dev.online && dev.ctx.isOpen()) dev.send(encodeStreamStop(dev.address));
      return;
    }
    const needed = new Set<number>();
    for (const s of this.subs) for (const sid of s.sids) needed.add(sid);
    const oldPeriod = this.periodUs;
    this.periodUs = this.targetPeriod();
    if (needed.size === this.slots.length) {
      this.commitLoad();
      if (oldPeriod !== this.periodUs && this.repackTimer === undefined) this.sendStart();
      return;
    }
    // Slots must stay packed from 0: stop now, write the new layout and restart a moment later
    // (see STREAM_REPACK_DELAY_MS). Samples in between carry the old layout and are dropped.
    this.slots = this.slots.filter((sid) => needed.has(sid));
    this.mapSlots();
    this.commitLoad();
    if (this.repackTimer !== undefined) return;
    dev.send(encodeStreamStop(dev.address));
    this.repackTimer = dev.ctx.scheduler.setTimeout(() => {
      this.repackTimer = undefined;
      if (this.slots.length === 0 || !dev.ctx.isOpen()) return;
      this.restore();
    }, STREAM_REPACK_DELAY_MS);
  }

  /** The board lost its layout (came back after being lost, restarted, renumbered): rewrite it. */
  deviceBack(): void {
    if (this.slots.length === 0 || this.repackTimer !== undefined) return;
    this.restore();
  }

  /** Writes the whole layout, clears the stale tail and starts sampling. */
  private restore(): void {
    this.configureAll(this.boardCount);
    this.boardCount = this.slots.length;
    this.resetAssembly();
    this.lastDataAt = this.dev.ctx.scheduler.now();
    this.sendStart();
  }

  /** Transport down / device removed: close every consumer without sending anything. */
  halt(): void {
    this.cancelKeepalive();
    this.cancelRepack();
    const subs = [...this.subs];
    this.subs.clear();
    this.slots = [];
    this.periodUs = 0;
    this.boardCount = 0;
    this.commitLoad();
    for (const s of subs) {
      s.closed = true;
      s.callbacks.clear();
    }
  }

  handleData(d: Uint8Array, now: number): void {
    const n = this.slots.length;
    if (n === 0 || this.repackTimer !== undefined) return;
    const count = streamDataCount(d);
    if (count === 0) return;
    // FD packs exactly the configured slots into the smallest frame (PROTOCOL §8); a longer one
    // still carries a previous, larger layout.
    if (d.length > 8 && count > n && d.length !== fdLength(4 + 4 * n)) return;
    const seq = d[0] ?? 0;
    const t = readU16(d, 2);
    if (seq !== this.curSeq) {
      if (this.curSeq >= 0) {
        const missed = this.missedSince(seq, t, now);
        if (missed < 0) return;
        if (this.filled !== 0 && !this.emitted) this.emit(n);
        if (missed > 0) for (const s of this.subs) s.lost += missed;
      }
      this.curSeq = seq;
      this.filled = 0;
      this.emitted = false;
      this.curT = t;
      this.curHost = now;
    } else if (this.emitted) {
      return;
    }
    this.lastDataAt = now;
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

  /**
   * Samples missed between the current one and a frame with `seq`/`t`, or -1 for a late or
   * repeated frame. `seq` gives the count modulo 256; the board clock decides how many whole
   * turns of `seq` passed (a long outage), the host clock how many turns of the 16-bit clock.
   */
  private missedSince(seq: number, t: number, now: number): number {
    let dt = (t - this.curT) & 0xffff;
    const hostTicks = (now - this.curHost) * TICKS_PER_MS;
    if (hostTicks > WRAP / 2) {
      const wraps = Math.round((hostTicks - dt) / WRAP);
      if (wraps > 0) dt += wraps * WRAP;
    } else if (dt === 0 || dt >= WRAP / 2) {
      // The board clock did not move forward: an older sample arriving late, or a duplicate.
      return -1;
    }
    const bySeq = (seq - this.curSeq - 1) & 0xff;
    const periodTicks = Math.max(1, this.periodUs / 100);
    const byTime = Math.max(0, Math.round(dt / periodTicks) - 1);
    return bySeq + 256 * Math.max(0, Math.round((byTime - bySeq) / 256));
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

  /**
   * START once a second keeps the board streaming (PROTOCOL §8). A board that sent nothing for
   * a whole keepalive period lost its layout (a restart whose BOOT heartbeat went missing, a
   * reordered STOP): the keepalive then rewrites the layout too.
   */
  private armKeepalive(): void {
    const s = this.dev.ctx.scheduler;
    this.keepalive = s.setTimeout(() => {
      this.keepalive = undefined;
      if (this.slots.length === 0) return;
      if (this.repackTimer === undefined) {
        const silentFor = Math.max(Timing.STREAM_KEEPALIVE_MS, (2 * this.periodUs) / 1000);
        if (this.dev.online && s.now() - this.lastDataAt >= silentFor) this.restore();
        else this.sendStart();
      }
      this.armKeepalive();
    }, Timing.STREAM_KEEPALIVE_MS);
  }

  private cancelKeepalive(): void {
    if (this.keepalive !== undefined) this.dev.ctx.scheduler.clearTimeout(this.keepalive);
    this.keepalive = undefined;
  }

  private cancelRepack(): void {
    if (this.repackTimer !== undefined) this.dev.ctx.scheduler.clearTimeout(this.repackTimer);
    this.repackTimer = undefined;
  }
}
