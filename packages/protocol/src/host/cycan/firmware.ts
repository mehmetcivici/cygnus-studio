import { Command, DataBitrate, DeviceState, FW_CHUNK_CLASSIC, FW_CHUNK_FD, FW_WINDOW_DEFAULT, FwStatus } from '../../core/constants';
import { type CyfwHeader, validateCyfw } from '../../core/cyfw';
import { type FwAck, encodeFwBegin, encodeFwData, encodeFwEnd } from '../../core/messages';
import { CyError, isCyError } from '../errors';
import type {
  DeviceFirmware,
  FirmwarePhase,
  FirmwareProgress,
  FirmwareResult,
  FirmwareUpdateOptions,
  FwVersion,
} from '../types';
import type { CyCanDevice } from './device';

/** Timings for the update flow; the bootloader contract only fixes the message shapes. */
export const FirmwareTiming = {
  /** Reboot into the bootloader until its first heartbeat. */
  ENTER_MS: 5000,
  /** BEGIN until an OK ACK (flash erase may answer BUSY meanwhile). */
  ERASE_MS: 15000,
  /** A window of DATA frames (or END) until its ACK. */
  ACK_MS: 500,
  /** Quiet time after BAD_OFFSET so ACKs for frames already in flight are absorbed. */
  DRAIN_MS: 20,
  /** Image verification + application start until the first application heartbeat. */
  START_MS: 8000,
  /** Consecutive ACK timeouts before giving up. */
  ACK_RETRIES: 3,
  /** Rewinds (BAD_OFFSET or timeout) before giving up. */
  MAX_REWINDS: 64,
} as const;

// Progress weights of the phases (sum 1).
const W_ENTER = 0.04;
const W_ERASE = 0.04;
const W_TRANSFER = 0.88;

type Waiter = { resolve: (ack: FwAck | null) => void; timer: unknown };

/** Firmware update over FW_REQ/FW_RSP (PROTOCOL §9) with windowed DATA and rewind on BAD_OFFSET. */
export class CyCanFirmware implements DeviceFirmware {
  private running = false;
  private readonly acks: FwAck[] = [];
  private waiter: Waiter | null = null;
  private stateWaiter: { check: () => void; fail: (e: CyError) => void } | null = null;
  private abortError: CyError | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly dev: CyCanDevice) {}

  get busy(): boolean {
    return this.running;
  }

  handleAck(ack: FwAck): void {
    if (!this.running) return;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      this.dev.ctx.scheduler.clearTimeout(w.timer);
      w.resolve(ack);
    } else {
      this.acks.push(ack);
    }
  }

  /** Called on every device change while waiting for a state (bootloader / application). */
  deviceChanged(): void {
    this.stateWaiter?.check();
  }

  abortAll(error: CyError): void {
    if (!this.running) return;
    this.abort(error);
  }

  async update(image: Uint8Array, opts: FirmwareUpdateOptions = {}): Promise<FirmwareResult> {
    const dev = this.dev;
    dev.require('firmware');
    if (this.running) throw new CyError('BUSY', 'firmware update already running');
    dev.requireResolved();
    const v = validateCyfw(image, { model: dev.model, hwRev: dev.hwRev ?? undefined });
    if (!v.ok) throw new CyError('INVALID', `firmware image: ${v.error}`, { reason: v.error });
    if (opts.signal?.aborted) throw new CyError('ABORTED', 'aborted');

    this.running = true;
    this.abortError = null;
    this.acks.length = 0;
    const started = dev.ctx.scheduler.now();
    const previous = dev.fw;
    const onAbort = (): void => this.abort(new CyError('ABORTED', 'aborted'));
    opts.signal?.addEventListener('abort', onAbort);
    const unsub = dev.on('changed', () => this.deviceChanged());
    const progress = new ProgressReporter(image.length, opts.onProgress);
    try {
      progress.phase('validate', 0);
      if (!dev.bootloader) {
        progress.phase('enterBootloader', 0);
        try {
          await dev.commandRaw(Command.ENTER_BOOTLOADER, 0, { attempts: 1 });
        } catch (e) {
          // The board may reboot before its answer leaves; the heartbeat below is the real check.
          if (!isCyError(e, 'TIMEOUT')) throw e;
        }
        this.checkAbort();
        await this.waitState(() => dev.online && dev.state === DeviceState.BOOTLOADER, FirmwareTiming.ENTER_MS, 'bootloader');
      }
      progress.phase('erase', W_ENTER);
      const rewinds = await this.transfer(image, v.fileCrc32, this.chunkSize(opts.chunk), progress);
      progress.phase('verify', W_ENTER + W_ERASE + W_TRANSFER);
      await this.waitState(
        () => dev.online && dev.state !== DeviceState.BOOTLOADER && dev.state !== DeviceState.BOOT && dev.fw !== null,
        FirmwareTiming.START_MS,
        'application start',
      );
      const version = dev.fw ?? { major: 0, minor: 0, patch: 0 };
      if (!sameVersion(version, v.header)) {
        throw new CyError('REJECTED', 'board runs a different version after update', { reason: 'version_mismatch' });
      }
      progress.done(rewinds);
      return { version, previous, bytes: image.length, rewinds, durationMs: dev.ctx.scheduler.now() - started };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      unsub();
      this.running = false;
      this.stateWaiter = null;
      this.acks.length = 0;
      if (this.waiter) {
        dev.ctx.scheduler.clearTimeout(this.waiter.timer);
        this.waiter = null;
      }
    }
  }

  private chunkSize(pref: FirmwareUpdateOptions['chunk'] = 'auto'): number {
    if (pref === 'fd') return FW_CHUNK_FD;
    if (pref === 'classic') return FW_CHUNK_CLASSIC;
    const fd = this.dev.ctx.transportFd && this.dev.cachedParam('can.data_bitrate') !== DataBitrate.CLASSIC;
    return fd ? FW_CHUNK_FD : FW_CHUNK_CLASSIC;
  }

  private async transfer(image: Uint8Array, crc: number, chunk: number, progress: ProgressReporter): Promise<number> {
    const dev = this.dev;
    const size = image.length;
    // BEGIN: BUSY answers while the flash erases, OK when ready.
    let window = FW_WINDOW_DEFAULT;
    this.acks.length = 0;
    dev.send(encodeFwBegin(dev.address, { size, crc32: crc }));
    const eraseDeadline = dev.ctx.scheduler.now() + FirmwareTiming.ERASE_MS;
    for (;;) {
      const ack = await this.nextAck(Math.max(1, eraseDeadline - dev.ctx.scheduler.now()));
      if (!ack) throw new CyError('TIMEOUT', 'bootloader did not answer BEGIN');
      if (ack.status === FwStatus.BUSY) continue;
      this.throwIfBad(ack, [FwStatus.OK]);
      if (ack.window > 0) window = ack.window;
      break;
    }

    progress.phase('transfer', W_ENTER + W_ERASE);
    let offset = 0; // next byte to send
    let confirmed = 0; // acknowledged by the board
    let rewinds = 0;
    let timeouts = 0;
    const rewind = async (to: number): Promise<void> => {
      if (++rewinds > FirmwareTiming.MAX_REWINDS) throw new CyError('TIMEOUT', 'too many retransmissions');
      // Let ACKs for frames already on the wire arrive, then trust the newest target.
      await this.sleep(FirmwareTiming.DRAIN_MS);
      for (const a of this.acks) {
        if (a.status === FwStatus.BAD_OFFSET || a.status === FwStatus.OK) to = a.nextOffset;
        else this.throwIfBad(a, [FwStatus.BUSY]);
      }
      this.acks.length = 0;
      offset = confirmed = Math.min(to, size);
      progress.update(confirmed, rewinds);
    };

    for (;;) {
      this.checkAbort();
      // One window of DATA frames; the last window may be short and is closed by END.
      let frames = 0;
      while (frames < window && offset < size) {
        const n = Math.min(chunk, size - offset);
        dev.send(encodeFwData(dev.address, { offset, bytes: image.subarray(offset, offset + n) }));
        offset += n;
        frames++;
      }
      const ending = offset >= size && frames < window;
      if (ending) dev.send(encodeFwEnd(dev.address));
      const ack = await this.nextAck(FirmwareTiming.ACK_MS);
      this.checkAbort();
      if (!ack) {
        if (++timeouts > FirmwareTiming.ACK_RETRIES) throw new CyError('TIMEOUT', 'bootloader stopped answering');
        dev.ctx.countRequestTimeout();
        await rewind(confirmed);
        continue;
      }
      timeouts = 0;
      if (ack.status === FwStatus.BAD_OFFSET) {
        await rewind(ack.nextOffset);
        continue;
      }
      if (ack.status === FwStatus.BUSY) {
        await rewind(confirmed);
        continue;
      }
      this.throwIfBad(ack, [FwStatus.OK]);
      if (ending) {
        progress.update(size, rewinds);
        return rewinds;
      }
      confirmed = Math.min(ack.nextOffset, size);
      if (confirmed !== offset) {
        // The board counted fewer bytes than we sent without flagging BAD_OFFSET; follow it.
        await rewind(confirmed);
        continue;
      }
      progress.update(confirmed, rewinds);
      if (offset >= size) {
        // The image ended exactly on a window boundary: END gets its own ACK.
        progress.phase('finish', W_ENTER + W_ERASE + W_TRANSFER);
        dev.send(encodeFwEnd(dev.address));
        const end = await this.nextAck(FirmwareTiming.ACK_MS * 4);
        if (!end) throw new CyError('TIMEOUT', 'bootloader did not answer END');
        if (end.status === FwStatus.BAD_OFFSET) {
          await rewind(end.nextOffset);
          continue;
        }
        this.throwIfBad(end, [FwStatus.OK]);
        return rewinds;
      }
    }
  }

  private throwIfBad(ack: FwAck, ok: number[]): void {
    if (ok.includes(ack.status)) return;
    throw new CyError('REJECTED', `bootloader status ${ack.status}`, { status: ack.status, statusKind: 'fw' });
  }

  private nextAck(timeoutMs: number): Promise<FwAck | null> {
    const queued = this.acks.shift();
    if (queued) return Promise.resolve(queued);
    if (this.abortError) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = this.dev.ctx.scheduler.setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = { resolve, timer };
    });
  }

  /** ACKs arriving meanwhile queue up in `acks`; an abort ends the sleep early. */
  private sleep(ms: number): Promise<void> {
    const s = this.dev.ctx.scheduler;
    return new Promise((resolve) => {
      const done = (): void => {
        s.clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = s.setTimeout(done, ms);
      this.wake = done;
    });
  }

  private waitState(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    if (pred()) return Promise.resolve();
    const s = this.dev.ctx.scheduler;
    return new Promise<void>((resolve, reject) => {
      const timer = s.setTimeout(() => {
        this.stateWaiter = null;
        reject(new CyError('TIMEOUT', `waiting for ${what}`));
      }, timeoutMs);
      this.stateWaiter = {
        check: () => {
          if (!pred()) return;
          s.clearTimeout(timer);
          this.stateWaiter = null;
          resolve();
        },
        fail: (e) => {
          s.clearTimeout(timer);
          this.stateWaiter = null;
          reject(e);
        },
      };
    });
  }

  private abort(error: CyError): void {
    if (this.abortError) return;
    this.abortError = error;
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      this.dev.ctx.scheduler.clearTimeout(w.timer);
      w.resolve(null);
    }
    this.stateWaiter?.fail(error);
    this.wake?.();
  }

  private checkAbort(): void {
    if (this.abortError) throw this.abortError;
  }
}

function sameVersion(v: FwVersion, h: CyfwHeader): boolean {
  return v.major === h.fwMajor && v.minor === h.fwMinor && v.patch === h.fwPatch;
}

class ProgressReporter {
  private current: FirmwarePhase = 'validate';
  private base = 0;
  private rewinds = 0;

  constructor(
    private readonly total: number,
    private readonly cb: ((p: FirmwareProgress) => void) | undefined,
  ) {}

  phase(p: FirmwarePhase, fraction: number): void {
    this.current = p;
    this.base = fraction;
    this.emit(0, fraction);
  }

  update(sent: number, rewinds: number): void {
    this.rewinds = rewinds;
    this.emit(sent, W_ENTER + W_ERASE + (W_TRANSFER * sent) / Math.max(1, this.total));
  }

  done(rewinds: number): void {
    this.rewinds = rewinds;
    this.current = 'verify';
    this.emit(this.total, 1);
  }

  private emit(sent: number, fraction: number): void {
    this.cb?.({ phase: this.current, sent, total: this.total, fraction: Math.max(this.base, fraction), rewinds: this.rewinds });
  }
}
