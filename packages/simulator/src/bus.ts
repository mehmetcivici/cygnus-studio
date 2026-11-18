import { FD_MAX_LEN } from '@cygnus/protocol';
import type { Prng } from './prng';

/** A frame travelling on the virtual bus. Pooled: receivers must copy what they keep. */
export interface BusFrame {
  id: number;
  /** Always 64 bytes; only the first `len` are payload. */
  readonly data: Uint8Array;
  len: number;
  fd: boolean;
  brs: boolean;
  /** Data-phase bit rate for BRS frames (bit/s). */
  dataBitrate: number;
  /** Delivery time, ms (simulation clock, sub-ms resolution). */
  timestamp: number;
  sender: BusEndpoint | null;
}

export interface BusEndpoint {
  /** Called for every frame another endpoint put on the bus. */
  receive(f: BusFrame): void;
  /** The frame could not be sent (lost arbitration on an identical id, bus short). */
  txError?(f: BusFrame): void;
}

export interface BusStats {
  /** Utilisation 0..1 (≈1 s moving average). */
  load: number;
  framesPerSec: number;
  totalFrames: number;
  errorFrames: number;
  lostFrames: number;
  /** Frames dropped because an endpoint's transmit queue overflowed. */
  txOverflow: number;
  shorted: boolean;
  terminations: number;
}

/**
 * Transmit queue of one endpoint (a board's software queue + mailboxes, the adapter's buffer).
 * Each endpoint overflows on its own, like real nodes: a busy board cannot crowd out the
 * host's frames, and within one queue a higher-priority frame displaces a lower one.
 */
const QUEUE_MAX = 256;
const LOAD_ALPHA = 1 / 500;

/**
 * Wire time of one frame in µs: bits including average stuffing and the 3-bit interframe
 * space; with BRS the data phase runs at `dataBitrate`.
 */
export function frameTimeUs(len: number, fd: boolean, brs: boolean, nominalBitrate: number, dataBitrate: number): number {
  if (!fd) {
    const core = 54 + 8 * len; // SOF..CRC of an extended frame, the part that is stuffed
    return ((core + Math.floor(core / 10) + 13) * 1e6) / nominalBitrate;
  }
  const dataBits = 5 + 8 * len + (len <= 16 ? 21 : 25);
  const stuffed = dataBits + Math.floor(dataBits / 10);
  const arbitration = 36 + 13;
  if (brs) return (arbitration * 1e6) / nominalBitrate + (stuffed * 1e6) / dataBitrate;
  return ((arbitration + stuffed) * 1e6) / nominalBitrate;
}

/**
 * Virtual CAN bus. Frames sent during one simulation step are arbitrated at the next
 * `step`: lowest id first, limited by the wire time available in the step (the rest waits),
 * each stamped with the time its transmission ends.
 */
export class SimBus {
  readonly nominalBitrate: number;
  /** Whether the bus (and the host adapter) carries CAN-FD frames. */
  readonly fd: boolean;
  private readonly endpoints: BusEndpoint[] = [];
  private readonly connected: boolean[] = [];
  private incoming: BusFrame[] = [];
  private pending: BusFrame[] = [];
  private readonly pool: BusFrame[] = [];
  private readonly queuedBy = new Map<BusEndpoint, number>();
  private busyUs = 0;
  /** Fraction (0..1) of frames destroyed on the wire. */
  lossRate = 0;
  shorted = false;
  /** Termination resistors on the bus; set by the simulation from board settings. */
  terminations = 2;
  readonly stats: BusStats = {
    load: 0,
    framesPerSec: 0,
    totalFrames: 0,
    errorFrames: 0,
    lostFrames: 0,
    txOverflow: 0,
    shorted: false,
    terminations: 2,
  };
  private framesThisStep = 0;

  constructor(
    private readonly rng: Prng,
    opts: { fd?: boolean; nominalBitrate?: number } = {},
  ) {
    this.fd = opts.fd ?? true;
    this.nominalBitrate = opts.nominalBitrate ?? 1_000_000;
  }

  attach(ep: BusEndpoint, connected = true): void {
    if (this.endpoints.includes(ep)) return;
    this.endpoints.push(ep);
    this.connected.push(connected);
  }

  detach(ep: BusEndpoint): void {
    const i = this.endpoints.indexOf(ep);
    if (i < 0) return;
    this.endpoints.splice(i, 1);
    this.connected.splice(i, 1);
  }

  /** Plugs or pulls the CAN cable of an endpoint (it keeps running, but hears and says nothing). */
  setConnected(ep: BusEndpoint, on: boolean): void {
    const i = this.endpoints.indexOf(ep);
    if (i >= 0) this.connected[i] = on;
  }

  isConnected(ep: BusEndpoint): boolean {
    const i = this.endpoints.indexOf(ep);
    return i >= 0 && this.connected[i] === true;
  }

  /**
   * Queues a frame (payload copied). Returns false if the endpoint is unplugged, or its queue is
   * full of frames that all outrank this one; otherwise its lowest-priority frame is dropped.
   */
  transmit(sender: BusEndpoint, id: number, data: Uint8Array, len: number, fd: boolean, brs: boolean, dataBitrate = 2_000_000): boolean {
    if (!this.isConnectedFast(sender)) return false;
    const queued = this.queuedBy.get(sender) ?? 0;
    if (queued >= QUEUE_MAX) {
      this.stats.txOverflow++;
      if (!this.evictBelow(sender, id >>> 0)) return false;
    }
    this.queuedBy.set(sender, (this.queuedBy.get(sender) ?? 0) + 1);
    const f = this.pool.pop() ?? newFrame();
    f.id = id >>> 0;
    const n = Math.min(len, FD_MAX_LEN);
    for (let i = 0; i < n; i++) f.data[i] = data[i] ?? 0;
    f.len = n;
    f.fd = fd;
    f.brs = fd && brs;
    f.dataBitrate = dataBitrate;
    f.sender = sender;
    f.timestamp = 0;
    this.incoming.push(f);
    return true;
  }

  /** Drops the sender's lowest-priority queued frame if it ranks below `id`. */
  private evictBelow(sender: BusEndpoint, id: number): boolean {
    let list: BusFrame[] | null = null;
    let at = -1;
    for (const l of [this.incoming, this.pending]) {
      for (let k = 0; k < l.length; k++) {
        const f = l[k]!;
        if (f.sender === sender && f.id > id && (at < 0 || f.id > list![at]!.id)) {
          list = l;
          at = k;
        }
      }
    }
    if (!list) return false;
    const [victim] = list.splice(at, 1);
    this.release(victim!);
    return true;
  }

  private isConnectedFast(ep: BusEndpoint): boolean {
    const eps = this.endpoints;
    for (let i = 0; i < eps.length; i++) if (eps[i] === ep) return this.connected[i] === true;
    return false;
  }

  get queued(): number {
    return this.incoming.length + this.pending.length;
  }

  /** Arbitrates and delivers frames queued before this step. */
  step(startMs: number, dtMs: number): void {
    const p = this.pending;
    // Merge newly queued frames behind the ones that waited; then order by priority.
    for (let i = 0; i < this.incoming.length; i++) p.push(this.incoming[i]!);
    this.incoming.length = 0;
    insertionSortById(p);

    const budgetUs = dtMs * 1000;
    let usedUs = 0;
    let delivered = 0;
    let i = 0;
    const quality = this.wireQuality();
    for (; i < p.length; i++) {
      const f = p[i]!;
      const us = frameTimeUs(f.len, f.fd, f.brs, this.nominalBitrate, f.dataBitrate);
      if (usedUs > 0 && usedUs + us > budgetUs) break;
      usedUs += us;
      f.timestamp = startMs + usedUs / 1000;
      if (this.shorted) {
        this.stats.errorFrames++;
        f.sender?.txError?.(f);
        this.release(f);
        continue;
      }
      // Two boards sending the same id at once: arbitration cannot separate them and the one
      // that sends a recessive data bit first sees a bit error (one-shot transmit).
      const next = p[i + 1];
      if (next && next.id === f.id && next.sender !== f.sender && !samePayload(f, next)) {
        const loser = comparePayload(f, next) < 0 ? next : f;
        const winner = loser === f ? next : f;
        this.stats.errorFrames++;
        loser.sender?.txError?.(loser);
        this.release(loser);
        i++;
        winner.timestamp = startMs + usedUs / 1000;
        this.deliver(winner, quality);
        delivered++;
        continue;
      }
      if (!f.fd || this.fd) {
        this.deliver(f, quality);
        delivered++;
      } else {
        // An FD frame on a classic-only bus is destroyed by error frames.
        this.stats.errorFrames++;
        f.sender?.txError?.(f);
        this.release(f);
      }
    }
    // Frames that did not fit wait for the next step.
    let w = 0;
    for (; i < p.length; i++) p[w++] = p[i]!;
    p.length = w;

    this.busyUs = usedUs;
    const util = Math.min(1, usedUs / budgetUs);
    this.stats.load += (util - this.stats.load) * LOAD_ALPHA * dtMs;
    this.framesThisStep = delivered;
    this.stats.framesPerSec += ((delivered * 1000) / dtMs - this.stats.framesPerSec) * LOAD_ALPHA * dtMs;
    this.stats.shorted = this.shorted;
    this.stats.terminations = this.terminations;
  }

  /** Probability that a frame survives the wire, from injected loss and termination. */
  private wireQuality(): number {
    let q = 1 - this.lossRate;
    if (this.terminations === 0) q *= 0.6;
    else if (this.terminations >= 4) q *= 0.97;
    return q;
  }

  private deliver(f: BusFrame, quality: number): void {
    if (quality < 1 && this.rng.next() >= quality) {
      this.stats.lostFrames++;
      this.stats.errorFrames++;
      this.release(f);
      return;
    }
    this.stats.totalFrames++;
    const eps = this.endpoints;
    for (let k = 0; k < eps.length; k++) {
      const ep = eps[k]!;
      if (ep !== f.sender && this.connected[k]) ep.receive(f);
    }
    this.release(f);
  }

  private release(f: BusFrame): void {
    const s = f.sender;
    if (s) {
      const n = (this.queuedBy.get(s) ?? 1) - 1;
      if (n > 0) this.queuedBy.set(s, n);
      else this.queuedBy.delete(s);
    }
    f.sender = null;
    this.pool.push(f);
  }

  /** Wire time used in the last step, µs. */
  get lastBusyUs(): number {
    return this.busyUs;
  }

  get lastFrameCount(): number {
    return this.framesThisStep;
  }
}

function newFrame(): BusFrame {
  return { id: 0, data: new Uint8Array(FD_MAX_LEN), len: 0, fd: false, brs: false, dataBitrate: 0, timestamp: 0, sender: null };
}

function insertionSortById(a: BusFrame[]): void {
  for (let i = 1; i < a.length; i++) {
    const x = a[i]!;
    let j = i - 1;
    while (j >= 0 && a[j]!.id > x.id) {
      a[j + 1] = a[j]!;
      j--;
    }
    a[j + 1] = x;
  }
}

function samePayload(a: BusFrame, b: BusFrame): boolean {
  if (a.len !== b.len) return false;
  for (let i = 0; i < a.len; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

/** Dominant (0) bits win, so the numerically smaller payload byte wins arbitration. */
function comparePayload(a: BusFrame, b: BusFrame): number {
  const n = Math.min(a.len, b.len);
  for (let i = 0; i < n; i++) {
    const d = (a.data[i] ?? 0) - (b.data[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.len - b.len;
}
