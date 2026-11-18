import type { TxFrame } from '../core/frame';

/*
 * Bus time a frame occupies, for the load estimate. Bit counts follow ISO 11898-1 for
 * 29-bit identifiers; stuff bits are estimated at the average rate (≈1 per 10 bits) rather
 * than the worst case, so the figure tracks what an oscilloscope would show on typical data.
 */

const CLASSIC_EXT_OVERHEAD = 67; // SOF..IFS without data, 29-bit id, CRC15
const FD_ARB_BITS = 36; // SOF, 29-bit id, SRR, IDE, RRS, FDF, res, BRS: nominal rate
const FD_TAIL_BITS = 12; // ACK slot + delimiter, EOF, IFS: nominal rate

function stuff(bits: number): number {
  return Math.floor(bits / 10);
}

/** Microseconds a frame keeps the bus busy. Rates in bit/s. */
export function frameTimeUs(f: Pick<TxFrame, 'data' | 'fd' | 'brs'>, nominalBps: number, dataBps: number): number {
  const n = f.data.length;
  if (!f.fd) {
    const bits = CLASSIC_EXT_OVERHEAD + 8 * n;
    return ((bits + stuff(bits - 13)) * 1e6) / nominalBps;
  }
  // FD data phase: ESI, DLC, data, stuff count, CRC17/21, CRC delimiter.
  const crc = n <= 16 ? 17 : 21;
  const dataBits = 1 + 4 + 8 * n + 4 + crc + 1;
  const dataStuffed = dataBits + stuff(dataBits) + Math.ceil(crc / 4); // fixed stuff bits in the CRC field
  const arb = FD_ARB_BITS + stuff(FD_ARB_BITS);
  const dataRate = f.brs ? dataBps : nominalBps;
  return ((arb + FD_TAIL_BITS) * 1e6) / nominalBps + (dataStuffed * 1e6) / dataRate;
}

export interface BusStats {
  /** Received frames per second over the last window. */
  rxFps: number;
  txFps: number;
  /** Estimated bus load, percent of the nominal 1 Mbit/s (FD data phase at the data rate). */
  loadPct: number;
  rxTotal: number;
  txTotal: number;
  /** Known boards that missed a discovery round, plus unconfirmed ASSIGN_ID requests. */
  enumTimeouts: number;
  /** Request attempts that timed out (each retransmission counts). */
  requestTimeouts: number;
  /** Length of the window the rates were computed over, ms. */
  windowMs: number;
}

/** Accumulates counters between `snapshot` calls; the hot path is two additions. */
export class StatsCounter {
  private rx = 0;
  private tx = 0;
  private busUs = 0;
  private rxTotal = 0;
  private txTotal = 0;
  enumTimeouts = 0;
  requestTimeouts = 0;
  private windowStart: number;
  private last: BusStats;

  constructor(
    now: number,
    private readonly nominalBps: number,
    private readonly dataBps: number,
  ) {
    this.windowStart = now;
    this.last = this.empty();
  }

  countRx(f: Pick<TxFrame, 'data' | 'fd' | 'brs'>): void {
    this.rx++;
    this.busUs += frameTimeUs(f, this.nominalBps, this.dataBps);
  }

  countTx(f: Pick<TxFrame, 'data' | 'fd' | 'brs'>): void {
    this.tx++;
    this.busUs += frameTimeUs(f, this.nominalBps, this.dataBps);
  }

  /** Closes the current window and returns its rates. */
  snapshot(now: number): BusStats {
    const ms = now - this.windowStart;
    this.rxTotal += this.rx;
    this.txTotal += this.tx;
    const s: BusStats = {
      rxFps: ms > 0 ? (this.rx * 1000) / ms : 0,
      txFps: ms > 0 ? (this.tx * 1000) / ms : 0,
      loadPct: ms > 0 ? Math.min(100, (this.busUs / (ms * 1000)) * 100) : 0,
      rxTotal: this.rxTotal,
      txTotal: this.txTotal,
      enumTimeouts: this.enumTimeouts,
      requestTimeouts: this.requestTimeouts,
      windowMs: ms,
    };
    this.rx = this.tx = this.busUs = 0;
    this.windowStart = now;
    this.last = s;
    return s;
  }

  get current(): BusStats {
    return this.last;
  }

  private empty(): BusStats {
    return { rxFps: 0, txFps: 0, loadPct: 0, rxTotal: 0, txTotal: 0, enumTimeouts: 0, requestTimeouts: 0, windowMs: 0 };
  }
}
