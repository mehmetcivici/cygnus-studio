/// <reference types="w3c-web-serial" />
import { type ByteStream, SlcanTransport, type SlcanTransportOptions, realScheduler } from '@cygnus/protocol';

/** Whether this browser exposes the Web Serial API (Chromium-based browsers, secure contexts only). */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

function serial(): Serial {
  if (!isWebSerialSupported()) throw new Error('Web Serial is not supported in this browser');
  return navigator.serial;
}

/** Shows the browser's port chooser; must run inside a user gesture (click). Rejects if the user cancels. */
export function requestSerialPort(filters: SerialPortFilter[] = []): Promise<SerialPort> {
  return serial().requestPort({ filters });
}

/** Ports the user granted earlier; they can be reopened without a prompt. */
export function listGrantedSerialPorts(): Promise<SerialPort[]> {
  return serial().getPorts();
}

/** Short label such as `USB 16d0:117e`, or `Serial port` for non-USB ports. */
export function describeSerialPort(port: SerialPort): string {
  const { usbVendorId, usbProductId } = port.getInfo();
  if (usbVendorId === undefined) return 'Serial port';
  const hex = (n: number): string => n.toString(16).padStart(4, '0');
  return `USB ${hex(usbVendorId)}:${hex(usbProductId ?? 0)}`;
}

export interface WebSerialOptions {
  /** Ignored by USB CDC adapters (CANable), required by the API. Default 115200. */
  baudRate?: number;
  /** Browser-side receive buffer, bytes. Default 8192: a busy 1 Mbit/s bus bursts quickly. */
  bufferSize?: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `ByteStream` over a Web Serial port: `open()` first, then hand it to a transport. */
export class WebSerialStream implements ByteStream {
  private readonly dataCbs = new Set<(chunk: Uint8Array) => void>();
  private readonly closeCbs = new Set<(error?: string) => void>();
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;
  private opened = false;
  private closing = false;
  private closeNotified = false;

  constructor(
    readonly port: SerialPort,
    private readonly opts: WebSerialOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.opened && !this.closing;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    await this.port.open({ baudRate: this.opts.baudRate ?? 115200, bufferSize: this.opts.bufferSize ?? 8192 });
    const writable = this.port.writable;
    if (!writable) {
      await this.port.close().catch(() => undefined);
      throw new Error('serial port has no writable stream');
    }
    this.writer = writable.getWriter();
    this.opened = true;
    this.closing = false;
    this.closeNotified = false;
    this.port.addEventListener('disconnect', this.onDisconnect);
    this.readLoop = this.pump();
  }

  /** Writes are queued by the underlying stream, so ordering is preserved. */
  write(bytes: Uint8Array): Promise<void> {
    const w = this.writer;
    if (!w || this.closing) return Promise.reject(new Error('serial port is closed'));
    return w.write(bytes);
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCbs.add(cb);
  }

  onClose(cb: (error?: string) => void): void {
    this.closeCbs.add(cb);
  }

  async close(): Promise<void> {
    if (!this.opened || this.closing) return;
    this.closing = true;
    this.port.removeEventListener('disconnect', this.onDisconnect);
    try {
      // Let queued writes (the adapter's channel-close command) go out first.
      await this.writer?.close();
    } catch {
      // The port may already be gone.
    }
    this.writer?.releaseLock();
    this.writer = null;
    try {
      await this.reader?.cancel();
    } catch {
      // Same: nothing left to cancel.
    }
    await this.readLoop;
    try {
      await this.port.close();
    } catch {
      // Unplugged ports cannot be closed; they are gone anyway.
    }
    this.opened = false;
  }

  private readonly onDisconnect = (): void => {
    this.notifyClosed('serial port disconnected');
  };

  private notifyClosed(error: string): void {
    if (this.closing || this.closeNotified) return;
    this.closeNotified = true;
    for (const cb of this.closeCbs) cb(error);
  }

  /** Reads until the port closes. Recoverable errors (overrun, framing) just start a new reader. */
  private async pump(): Promise<void> {
    while (this.port.readable && !this.closing) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length > 0) for (const cb of this.dataCbs) cb(value);
        }
      } catch (e) {
        // A fatal error nulls `port.readable`; the loop condition then ends the pump.
        if (!this.port.readable) this.notifyClosed(errText(e));
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
    }
    if (!this.closing) this.notifyClosed('serial port closed');
  }
}

export interface SlcanOverWebSerialOptions extends Partial<SlcanTransportOptions> {
  serial?: WebSerialOptions;
}

export interface SlcanOverWebSerial {
  transport: SlcanTransport;
  stream: WebSerialStream;
}

/**
 * Opens the port and wraps it in an `SlcanTransport` (the transport's own `open()` then runs the
 * adapter's setup commands). A transport is single-use: after it closes, call this again.
 */
export async function createSlcanOverWebSerial(port: SerialPort, opts: SlcanOverWebSerialOptions = {}): Promise<SlcanOverWebSerial> {
  const stream = new WebSerialStream(port, opts.serial);
  await stream.open();
  const { serial: _serial, ...rest } = opts;
  const transport = new SlcanTransport(stream, {
    ...rest,
    scheduler: rest.scheduler ?? realScheduler,
    label: rest.label ?? describeSerialPort(port),
  });
  return { transport, stream };
}
