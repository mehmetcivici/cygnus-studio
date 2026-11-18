import type { CanFrame } from '../core/frame';
import { SlcanParser, type SlcanDataBitrate, encodeSlcanCommand, encodeSlcanFrame, slcanSetupCommands } from './slcan';
import type { Scheduler, Transport, TransportInfo, TransportState } from './types';

/** Raw byte pipe to the adapter (WebSerial, Tauri serial port, test double). */
export interface ByteStream {
  write(bytes: Uint8Array): void | Promise<void>;
  onData(cb: (chunk: Uint8Array) => void): void;
  close(): void | Promise<void>;
  /** Optional: notified when the port disappears (unplugged). */
  onClose?(cb: (error?: string) => void): void;
}

export interface SlcanTransportOptions {
  scheduler: Scheduler;
  label?: string;
  /** CAN-FD data bitrate in Mbit/s; 0 = classic CAN only. Default 2. */
  dataBitrate?: SlcanDataBitrate;
  /** How long to wait for the adapter to acknowledge the setup commands. Default 1000 ms. */
  openTimeoutMs?: number;
}

interface PendingCommand {
  cmd: string;
  /** A rejected 'C' only means the channel was already closed. */
  mustSucceed: boolean;
}

export class SlcanTransport implements Transport {
  readonly info: TransportInfo;
  private readonly parser: SlcanParser;
  private readonly frameListeners = new Set<(f: CanFrame) => void>();
  private readonly stateListeners = new Set<(s: TransportState) => void>();
  private state: TransportState = { phase: 'closed' };
  private pending: PendingCommand[] = [];
  private openWait: { resolve: () => void; reject: (e: Error) => void; timer: unknown } | null = null;
  private readonly dataBitrate: SlcanDataBitrate;
  private readonly openTimeoutMs: number;

  constructor(
    private readonly stream: ByteStream,
    private readonly opts: SlcanTransportOptions,
  ) {
    this.dataBitrate = opts.dataBitrate ?? 2;
    this.openTimeoutMs = opts.openTimeoutMs ?? 1000;
    this.info = { kind: 'slcan', label: opts.label ?? 'slcan', fd: this.dataBitrate !== 0 };
    this.parser = new SlcanParser({
      frame: (f) => {
        if (this.state.phase !== 'open') return;
        for (const cb of this.frameListeners) cb(f);
      },
      ack: () => this.reply(true),
      nack: () => this.reply(false),
    });
    stream.onData((chunk) => this.parser.push(chunk, this.opts.scheduler.now()));
    stream.onClose?.((error) => {
      if (this.state.phase === 'closed') return;
      this.fail(error ?? 'serial port closed');
    });
  }

  get currentState(): TransportState {
    return this.state;
  }

  open(): Promise<void> {
    if (this.state.phase === 'open') return Promise.resolve();
    if (this.openWait) return Promise.reject(new Error('slcan: open already in progress'));
    this.parser.reset();
    this.setState({ phase: 'opening' });
    return new Promise<void>((resolve, reject) => {
      const timer = this.opts.scheduler.setTimeout(() => this.fail('adapter did not answer setup commands'), this.openTimeoutMs);
      this.openWait = { resolve, reject, timer };
      const cmds = slcanSetupCommands(this.dataBitrate);
      // Replies may arrive synchronously while writing, so iterate a copy of the command list.
      this.pending = cmds.map((cmd) => ({ cmd, mustSucceed: cmd !== 'C' }));
      for (const cmd of cmds) this.write(encodeSlcanCommand(cmd));
    });
  }

  async close(): Promise<void> {
    if (this.state.phase === 'closed') return;
    this.settleOpen(new Error('slcan: closed while opening'));
    this.pending = [];
    this.write(encodeSlcanCommand('C'));
    this.setState({ phase: 'closed' });
    await this.stream.close();
  }

  /** Frames sent while the link is not open are dropped. */
  send(frame: Omit<CanFrame, 'timestamp'>): void {
    if (this.state.phase !== 'open') return;
    if (frame.fd && !this.info.fd) return;
    this.write(encodeSlcanFrame(frame));
  }

  onFrame(cb: (f: CanFrame) => void): () => void {
    this.frameListeners.add(cb);
    return () => this.frameListeners.delete(cb);
  }

  onState(cb: (s: TransportState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  private reply(ok: boolean): void {
    const p = this.pending.shift();
    if (!p || this.state.phase !== 'opening') return;
    if (!ok && p.mustSucceed) {
      this.fail(`adapter rejected '${p.cmd}'`);
      return;
    }
    if (this.pending.length === 0) {
      this.setState({ phase: 'open' });
      this.settleOpen(null);
    }
  }

  private write(bytes: Uint8Array): void {
    try {
      const r = this.stream.write(bytes);
      if (r) r.catch((e: unknown) => this.fail(e instanceof Error ? e.message : String(e)));
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(error: string): void {
    this.pending = [];
    this.setState({ phase: 'error', error });
    this.settleOpen(new Error(`slcan: ${error}`));
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
