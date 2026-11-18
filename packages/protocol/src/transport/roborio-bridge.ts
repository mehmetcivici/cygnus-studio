import type { CanFrame } from '../core/frame';
import { ID_MASK, idClass, idDevType, idMfr } from '../core/id';
import { V3Class, V3_DEVICE_TYPE, V3_MANUFACTURER } from '../legacy/protocol';
import type { ByteStream } from './slcan-transport';
import type { Scheduler, Transport, TransportInfo, TransportState } from './types';

/*
 * roboRIO bridge wire format (CyncoderBridge.java header; the standalone daemon speaks the same).
 *   bridge -> host, once per session:  [0x03] "CYGB" (in-program bridge) | "CYGD" (daemon)
 *   bridge -> host, CAN frame:         [0x01][id u32 BE][size u8 0..8][timestamp u32 BE][payload]
 *   host -> bridge, send CAN frame:    [0x02][id u32 BE][size u8 0..8][payload]
 */
const MSG_CAN_FRAME = 0x01;
const MSG_SEND_CAN_FRAME = 0x02;
const MSG_HELLO = 0x03;
const HELLO_LEN = 5;
const FRAME_HEADER_LEN = 10;
const MAX_PAYLOAD = 8;

export type BridgePeer = 'bridge' | 'daemon';

export interface RoboRioBridgeOptions {
  scheduler: Scheduler;
  label?: string;
  /** How long `open()` waits for the hello message. Default 2000 ms. */
  helloTimeoutMs?: number;
}

/**
 * The bridge only puts Cyncoder v3 commands on the robot's CAN bus and refuses everything else
 * (with a Driver Station warning), so the transport never sends anything but those.
 */
export function isBridgeAllowedId(id: number): boolean {
  return (
    id >= 0 &&
    id <= ID_MASK &&
    idDevType(id) === V3_DEVICE_TYPE &&
    idMfr(id) === V3_MANUFACTURER &&
    idClass(id) === V3Class.COMMAND
  );
}

/**
 * Transport over the roboRIO's TCP bridge (port 5800). The socket itself lives behind a
 * `ByteStream` supplied by the app; this class only frames the bytes. Classic CAN only.
 *
 * Single use after a framing error: a TCP byte stream that lost its framing cannot be
 * resynchronised, so the transport closes its stream and `open()` keeps failing. Reconnect
 * with a new socket and a new RoboRioBridgeTransport.
 */
export class RoboRioBridgeTransport implements Transport {
  readonly info: TransportInfo;
  private readonly frameListeners = new Set<(f: CanFrame) => void>();
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private state: TransportState = { phase: 'closed' };
  private buf = new Uint8Array(256);
  private len = 0;
  private peerKind: BridgePeer | null = null;
  private broken = false;
  private openWait: { resolve: () => void; reject: (e: Error) => void; timer: unknown } | null = null;
  private readonly helloTimeoutMs: number;

  constructor(
    private readonly stream: ByteStream,
    private readonly opts: RoboRioBridgeOptions,
  ) {
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 2000;
    this.info = { kind: 'roborio-bridge', label: opts.label ?? 'roboRIO', fd: false };
    stream.onData((chunk) => this.push(chunk));
    stream.onClose?.((error) => {
      if (this.state.phase === 'closed') return;
      this.fail(error ?? 'bridge connection closed');
    });
  }

  get currentState(): TransportState {
    return this.state;
  }

  /** Which program answered: the in-program bridge (`CYGB`) or the standalone daemon (`CYGD`). */
  get peer(): BridgePeer | null {
    return this.peerKind;
  }

  /** Resolves when the bridge's hello message has arrived (it may already have, before `open`). */
  open(): Promise<void> {
    if (this.state.phase === 'open') return Promise.resolve();
    if (this.openWait) return Promise.reject(new Error('roborio-bridge: open already in progress'));
    if (this.broken) {
      return Promise.reject(new Error(`roborio-bridge: ${this.state.error ?? 'stream is broken'}; create a new transport to reconnect`));
    }
    this.setState({ phase: 'opening' });
    if (this.peerKind) {
      this.setState({ phase: 'open' });
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = this.opts.scheduler.setTimeout(() => this.fail('bridge did not send its hello message'), this.helloTimeoutMs);
      this.openWait = { resolve, reject, timer };
    });
  }

  async close(): Promise<void> {
    if (this.state.phase === 'closed') return;
    this.settleOpen(new Error('roborio-bridge: closed while opening'));
    this.setState({ phase: 'closed' });
    await this.stream.close();
  }

  /** Frames that are not Cyncoder v3 commands, and FD frames, are dropped (the bridge would refuse them). */
  send(frame: Omit<CanFrame, 'timestamp'>): void {
    if (this.state.phase !== 'open') return;
    if (frame.fd || frame.data.length > MAX_PAYLOAD || !isBridgeAllowedId(frame.id)) return;
    const out = new Uint8Array(6 + frame.data.length);
    out[0] = MSG_SEND_CAN_FRAME;
    writeU32BE(out, 1, frame.id);
    out[5] = frame.data.length;
    out.set(frame.data, 6);
    try {
      const r = this.stream.write(out);
      if (r) r.catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)));
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  onFrame(cb: (f: CanFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onState(cb: (s: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  // ---------------------------------------------------------------------------------------
  // Receive path: a resumable parser; messages may arrive split or glued at any byte.

  private push(chunk: Uint8Array): void {
    // Also parsed while closed: the hello may arrive before `open()` is called.
    if (this.broken) return;
    if (this.len + chunk.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    let pos = 0;
    while (!this.broken && pos < this.len) {
      const used = this.parseOne(pos);
      if (used === 0) break;
      pos += used;
    }
    if (pos > 0) {
      this.buf.copyWithin(0, pos, this.len);
      this.len -= pos;
    }
  }

  /** Parses the message at `pos`; returns its length, or 0 when more bytes are needed. */
  private parseOne(pos: number): number {
    const b = this.buf;
    const type = b[pos] ?? 0;
    const avail = this.len - pos;
    if (type === MSG_HELLO) {
      if (avail < HELLO_LEN) return 0;
      const magic = String.fromCharCode(b[pos + 1] ?? 0, b[pos + 2] ?? 0, b[pos + 3] ?? 0, b[pos + 4] ?? 0);
      if (magic !== 'CYGB' && magic !== 'CYGD') {
        this.fail(`unknown hello id ${JSON.stringify(magic)}`);
        return 0;
      }
      this.onHello(magic === 'CYGB' ? 'bridge' : 'daemon');
      return HELLO_LEN;
    }
    if (type === MSG_CAN_FRAME) {
      if (avail < FRAME_HEADER_LEN) return 0;
      const size = b[pos + 5] ?? 0;
      if (size > MAX_PAYLOAD) {
        this.fail(`bogus data size ${size} from bridge`);
        return 0;
      }
      if (avail < FRAME_HEADER_LEN + size) return 0;
      const id = readU32BE(b, pos + 1);
      // Remote-frame / 11-bit flags sit above bit 28: such frames are never Cyncoder traffic.
      if (id <= ID_MASK && this.state.phase === 'open') {
        const frame: CanFrame = {
          id,
          data: b.slice(pos + FRAME_HEADER_LEN, pos + FRAME_HEADER_LEN + size),
          fd: false,
          brs: false,
          timestamp: this.opts.scheduler.now(),
        };
        for (const cb of this.frameListeners) cb(frame);
      }
      return FRAME_HEADER_LEN + size;
    }
    this.fail(`unknown message type 0x${type.toString(16)} from bridge`);
    return 0;
  }

  private onHello(peer: BridgePeer): void {
    this.peerKind = peer;
    if (this.state.phase === 'opening') {
      this.setState({ phase: 'open' });
      this.settleOpen(null);
    }
  }

  private fail(error: string): void {
    const wasBroken = this.broken;
    this.broken = true;
    this.len = 0;
    this.setState({ phase: 'error', error });
    this.settleOpen(new Error(`roborio-bridge: ${error}`));
    // Release the socket: nothing more can be read from it reliably.
    if (!wasBroken) {
      try {
        const r = this.stream.close();
        if (r) r.catch(() => undefined);
      } catch {
        // already closed
      }
    }
  }

  private settleOpen(err: Error | null): void {
    const w = this.openWait;
    if (!w) return;
    this.openWait = null;
    this.opts.scheduler.clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve();
  }

  private setState(s: TransportState): void {
    this.state = s;
    for (const cb of this.stateListeners) cb(s);
  }
}

function readU32BE(b: Uint8Array, o: number): number {
  return (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;
}

function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}
