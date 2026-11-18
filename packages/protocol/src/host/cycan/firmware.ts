import { Command, DataBitrate, DeviceState, FW_CHUNK_CLASSIC, FW_CHUNK_FD, FW_WINDOW_DEFAULT, FwStatus } from '../../core/constants';
import { CYFW_HEADER_SIZE } from '../../core/cyfw';
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
  /** ENTER_BOOTLOADER that drew no answer: wait this long for the bootloader before sending it again. */
  ENTER_RETRY_MS: 1000,
  /** ENTER_BOOTLOADER attempts. */
  ENTER_ATTEMPTS: 3,
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
      const chunk = await this.chunkSize(opts.chunk);
      this.checkAbort();
      if (!dev.bootloader) {
        progress.phase('enterBootloader', 0);
        await this.enterBootloader();
      }
      progress.phase('erase', W_ENTER);
      let rewinds: number;
      try {
        rewinds = await this.transfer(image, v.fileCrc32, chunk, progress);
      } catch (e) {
        // BAD_IMAGE comes before anything is erased: restart the untouched application.
        if (isCyError(e, 'REJECTED') && e.statusKind === 'fw' && e.status === FwStatus.BAD_IMAGE) {
          dev.commandRaw(Command.REBOOT, 0, { attempts: 1 }).catch(() => undefined);
        }
        throw e;
      }
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

  /**
   * ENTER_BOOTLOADER with its intent argument (PROTOCOL §4.5). An unanswered request is sent
   * again: the command or its answer may be lost, and a board that did reboot shows up as a
   * bootloader heartbeat soon after. DENIED (driven, ESTOP) and other refusals end the update.
   */
  private async enterBootloader(): Promise<void> {
    const dev = this.dev;
    const inBootloader = (): boolean => dev.online && dev.state === DeviceState.BOOTLOADER;
    for (let attempt = 1; ; attempt++) {
      let answered = true;
      try {
        await dev.commandRaw(Command.ENTER_BOOTLOADER, dev.enterBootloaderArg, { attempts: 1 });
      } catch (e) {
        if (!isCyError(e, 'TIMEOUT')) throw e;
        answered = false;
      }
      this.checkAbort();
      const last = answered || attempt >= FirmwareTiming.ENTER_ATTEMPTS;
      try {
        await this.waitState(inBootloader, last ? FirmwareTiming.ENTER_MS : FirmwareTiming.ENTER_RETRY_MS, 'bootloader');
        return;
      } catch (e) {
        if (last || !isCyError(e, 'TIMEOUT')) throw e;
      }
    }
  }

  /**
   * DATA chunk: every frame but the last carries a full chunk whose length + 3 is a valid frame
   * length (classic 8, FD 64; PROTOCOL §9). The bootloader runs at the board's saved
   * `can.data_bitrate`; when that is unknown the classic chunk is used, which every board accepts.
   */
  private async chunkSize(pref: FirmwareUpdateOptions['chunk'] = 'auto'): Promise<number> {
    if (pref === 'fd') return FW_CHUNK_FD;
    if (pref === 'classic') return FW_CHUNK_CLASSIC;
    const dev = this.dev;
    if (!dev.ctx.transportFd) return FW_CHUNK_CLASSIC;
    let rate = dev.cachedParam('can.data_bitrate');
    if (rate === undefined && !dev.bootloader && dev.capabilities.params) {
      rate = await dev.getParam('can.data_bitrate').catch(() => undefined);
    }
    return rate !== undefined && rate !== DataBitrate.CLASSIC ? FW_CHUNK_FD : FW_CHUNK_CLASSIC;
  }

  private async transfer(image: Uint8Array, crc: number, chunk: number, progress: ProgressReporter): Promise<number> {
    const dev = this.dev;
    const size = image.length;
    let window = FW_WINDOW_DEFAULT;
    let offset = 0; // next byte to send
    let confirmed = 0; // acknowledged by the board
    let rewinds = 0;
    let timeouts = 0;
    const sendData = (): void => {
      const n = Math.min(chunk, size - offset);
      dev.send(encodeFwData(dev.address, { offset, bytes: image.subarray(offset, offset + n) }));
      offset += n;
    };
    /** Follows the board to `to` after an ACK that is not an error (erase done, BUSY over). */
    const resume = (ack: FwAck): void => {
      if (ack.window > 0) window = ack.window;
      offset = confirmed = Math.min(ack.nextOffset, size);
      progress.update(confirmed, rewinds);
    };

    // BEGIN: the board answers OK without erasing (an older bootloader erases first: BUSY, then OK).
    this.acks.length = 0;
    dev.send(encodeFwBegin(dev.address, { size, crc32: crc }));
    const begun = await this.ackAfterBusy(FirmwareTiming.ERASE_MS);
    if (!begun) throw new CyError('TIMEOUT', 'bootloader did not answer BEGIN');
    this.throwIfBad(begun, [FwStatus.OK]);
    if (begun.window > 0) window = begun.window;

    // Header: the board checks it before erasing and answers BUSY while it erases, then OK with
    // the offset to continue from; BAD_IMAGE leaves the installed application untouched.
    const headerFrames = Math.min(window, Math.ceil(Math.min(CYFW_HEADER_SIZE, size) / chunk));
    for (let i = 0; i < headerFrames; i++) sendData();
    const erased = await this.nextAck(FirmwareTiming.ACK_MS);
    this.checkAbort();
    // No answer: a bootloader that erased at BEGIN only acknowledges full windows, and the
    // header frames count towards its first one.
    let carried = erased ? 0 : headerFrames;
    if (erased) {
      const ready = erased.status === FwStatus.BUSY ? await this.ackAfterBusy(FirmwareTiming.ERASE_MS) : erased;
      if (!ready) throw new CyError('TIMEOUT', 'bootloader did not finish erasing');
      this.throwIfBad(ready, [FwStatus.OK, FwStatus.BAD_OFFSET]);
      if (ready.status === FwStatus.OK) resume(ready);
      else {
        offset = confirmed = Math.min(ready.nextOffset, size);
        rewinds++;
      }
    }
    progress.phase('transfer', W_ENTER + W_ERASE);

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
      if (offset >= size) {
        // Everything is on the wire; END's ACK also closes the last, short window.
        progress.phase('finish', W_ENTER + W_ERASE + W_TRANSFER);
        const missing = await this.end();
        if (missing === null) return rewinds;
        await rewind(missing);
        continue;
      }
      let frames = carried;
      carried = 0;
      while (frames < window && offset < size) {
        sendData();
        frames++;
      }
      // A short window gets no ACK of its own; END follows right away.
      if (frames < window) continue;
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
        // Flash work in the middle of the transfer: frames sent meanwhile were dropped; the
        // board says where to continue once it is ready.
        const ready = await this.ackAfterBusy(FirmwareTiming.ERASE_MS);
        if (!ready) throw new CyError('TIMEOUT', 'bootloader stayed busy');
        this.throwIfBad(ready, [FwStatus.OK, FwStatus.BAD_OFFSET]);
        this.acks.length = 0;
        resume(ready);
        continue;
      }
      this.throwIfBad(ack, [FwStatus.OK]);
      confirmed = Math.min(ack.nextOffset, size);
      if (confirmed !== offset) {
        // The board counted fewer bytes than we sent without flagging BAD_OFFSET; follow it.
        await rewind(confirmed);
        continue;
      }
      progress.update(confirmed, rewinds);
    }
  }

  /**
   * Sends END until it is acknowledged. Returns null when the image is complete — the ACK said
   * OK, or the board is already verifying (BUSY) or has left the transfer (WRONG_STATE), or END
   * kept going unanswered; the application heartbeat's version decides in all those cases
   * (PROTOCOL §9). Returns the offset to resend from on BAD_OFFSET.
   */
  private async end(): Promise<number | null> {
    const dev = this.dev;
    for (let attempt = 0; attempt <= FirmwareTiming.ACK_RETRIES; attempt++) {
      dev.send(encodeFwEnd(dev.address));
      const ack = await this.nextAck(FirmwareTiming.ACK_MS * 4);
      this.checkAbort();
      if (!ack) {
        dev.ctx.countRequestTimeout();
        continue;
      }
      if (ack.status === FwStatus.BAD_OFFSET) return ack.nextOffset;
      if (ack.status === FwStatus.BUSY || ack.status === FwStatus.WRONG_STATE) return null;
      this.throwIfBad(ack, [FwStatus.OK]);
      return null;
    }
    return null;
  }

  /** Next ACK that is not BUSY, waiting at most `timeoutMs` in total. */
  private async ackAfterBusy(timeoutMs: number): Promise<FwAck | null> {
    const s = this.dev.ctx.scheduler;
    const deadline = s.now() + timeoutMs;
    for (;;) {
      const ack = await this.nextAck(Math.max(1, deadline - s.now()));
      this.checkAbort();
      if (!ack || ack.status !== FwStatus.BUSY) return ack;
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
  private last = 0;

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
    // Never backwards: the header may be confirmed before the transfer phase starts.
    this.last = Math.max(this.last, this.base, fraction);
    this.cb?.({ phase: this.current, sent, total: this.total, fraction: this.last, rewinds: this.rewinds });
  }
}
