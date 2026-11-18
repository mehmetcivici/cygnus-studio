import type { ControlFrameDef, ControlModeDef } from '../../catalog/schema';
import { Timing } from '../../core/constants';
import type { Address, TxFrame } from '../../core/frame';
import { encodeCtrlServo, encodeCtrlSet, encodeCtrlText } from '../../core/messages';
import { CyError } from '../errors';
import type { ControlFields, ControlLoop, ControlStopCallback, ControlStopReason, DeviceControl } from '../types';
import type { CyCanDevice } from './device';

const DEFAULT_RATE_HZ = 50;
const MIN_PERIOD_MS = 5;

interface SessionFrame {
  def: ControlFrameDef;
  /** Validated fields; the frame is encoded on every send so a number change is honoured. */
  fields: ControlFields;
}

/** Reasons where nothing can (lost, link down) or should (host ESTOP: only ESTOP frames now) be sent. */
const SILENT: ReadonlySet<ControlStopReason> = new Set<ControlStopReason>(['estop', 'lost', 'disconnected']);

/**
 * Actuator commands. A device has at most one periodic session; it re-sends every frame it
 * holds fast enough to beat `ctrl.timeout_ms`. A frame joining the session is preceded by its
 * neutral command (PROTOCOL §7 neutral-first rule), and ending the session sends neutral again.
 */
export class CyCanControl implements DeviceControl {
  private readonly session = new Map<string, SessionFrame>();
  private timer: unknown = undefined;
  private period = 1000 / DEFAULT_RATE_HZ;
  /** Bumped whenever the session ends, so stale ControlLoop handles go inert. */
  private generation = 0;
  private listeners = new Set<ControlStopCallback>();
  /** Reason the session of each ended generation stopped (only the latest few are looked up). */
  private readonly reasons = new Map<number, ControlStopReason>();
  /** Host time the last session ended; the heartbeat ENABLED bit lags by up to one beat. */
  endedAt = -Infinity;
  private readonly tick = (): void => {
    const gen = this.generation;
    this.timer = undefined;
    for (const s of this.session.values()) this.dev.send(this.encode(s.def, s.fields));
    // A send may synchronously take the link down and halt the session.
    if (gen !== this.generation || this.session.size === 0) return;
    this.timer = this.dev.ctx.scheduler.setTimeout(this.tick, this.period);
  };

  constructor(private readonly dev: CyCanDevice) {}

  get active(): boolean {
    return this.timer !== undefined;
  }

  get periodMs(): number {
    return this.period;
  }

  /** True while the session holds at least one non-neutral command. */
  get driving(): boolean {
    for (const s of this.session.values()) if (!isNeutral(s.def, s.fields)) return true;
    return false;
  }

  set(mode: number | string, value: number): void {
    const def = this.setFrameDef();
    this.oneShot(def, { mode, value });
  }

  start(mode: number | string, value: number, opts: { rateHz?: number; onStopped?: ControlStopCallback } = {}): ControlLoop {
    const def = this.setFrameDef();
    this.hold(def, { mode, value }, opts.rateHz);
    const gen = this.generation;
    let curMode = mode;
    const live = (): boolean => gen === this.generation && this.session.has(def.key);
    const onStopped = (cb: ControlStopCallback): (() => void) => {
      if (gen !== this.generation) {
        cb(this.reasons.get(gen) ?? 'stopped');
        return () => undefined;
      }
      this.listeners.add(cb);
      return () => {
        this.listeners.delete(cb);
      };
    };
    if (opts.onStopped) onStopped(opts.onStopped);
    const reason = (): ControlStopReason | null => (gen === this.generation ? null : (this.reasons.get(gen) ?? 'stopped'));
    return {
      get active() {
        return live();
      },
      get stopReason() {
        return reason();
      },
      update: (v: number) => {
        if (!live()) return;
        const fields = { mode: curMode, value: v };
        this.encode(def, fields);
        this.session.set(def.key, { def, fields });
      },
      setMode: (m: number | string, v = 0) => {
        if (!live()) return;
        const fields = { mode: m, value: v };
        this.encode(def, fields);
        curMode = m;
        this.session.set(def.key, { def, fields });
      },
      stop: () => {
        if (live()) this.stop();
      },
      onStopped,
    };
  }

  send(controlKey: string, fields: ControlFields, opts: { repeat?: boolean; rateHz?: number } = {}): void {
    const def = this.frameDef(controlKey);
    if (opts.repeat) this.hold(def, fields, opts.rateHz);
    else this.oneShot(def, fields);
  }

  stop(): void {
    this.end('stopped');
  }

  /**
   * Ends the session for `reason`. A neutral command follows unless the reason makes sending
   * pointless; `neutralTo` overrides the address (the old one after a number change).
   */
  halt(reason: ControlStopReason, neutralTo?: Address): void {
    this.end(reason, neutralTo);
  }

  private end(reason: ControlStopReason, neutralTo?: Address): void {
    if (this.timer === undefined && this.session.size === 0) return;
    const frames = [...this.session.values()];
    if (this.timer !== undefined) this.dev.ctx.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
    this.session.clear();
    this.reasons.set(this.generation, reason);
    this.reasons.delete(this.generation - 8);
    this.generation++;
    this.endedAt = this.dev.ctx.scheduler.now();
    if (!SILENT.has(reason) && this.dev.ctx.isOpen()) {
      const addr = neutralTo ?? this.dev.address;
      for (const s of frames) {
        const n = this.neutral(s.def, addr);
        if (n) this.dev.send(n);
      }
    }
    const cbs = [...this.listeners];
    this.listeners = new Set();
    for (const cb of cbs) cb(reason);
    this.dev.emitControlStopped(reason);
  }

  private oneShot(def: ControlFrameDef, fields: ControlFields): void {
    const frame = this.encode(def, fields);
    if (!this.session.has(def.key) && !isNeutral(def, fields)) {
      const n = this.neutral(def, this.dev.address);
      if (n) this.dev.send(n);
    }
    this.dev.send(frame);
  }

  private hold(def: ControlFrameDef, fields: ControlFields, rateHz?: number): void {
    this.encode(def, fields);
    this.period = this.periodFor(rateHz);
    if (!this.session.has(def.key)) {
      // The board only accepts a target after a neutral command (PROTOCOL §7).
      const n = this.neutral(def, this.dev.address);
      if (n) this.dev.send(n);
    }
    this.session.set(def.key, { def, fields });
    if (this.timer === undefined) this.tick();
  }

  private periodFor(rateHz = DEFAULT_RATE_HZ): number {
    if (!Number.isFinite(rateHz) || rateHz <= 0) throw new CyError('INVALID', 'control rate', { reason: 'out_of_range' });
    const timeout = this.dev.cachedParam('ctrl.timeout_ms') ?? Timing.CTRL_TIMEOUT_DEFAULT_MS;
    // Four repeats per board timeout tolerate a few lost frames before the board goes neutral.
    return Math.max(MIN_PERIOD_MS, Math.min(1000 / rateHz, timeout / 4));
  }

  private setFrameDef(): ControlFrameDef {
    this.check();
    const def = this.dev.def?.controls.find((c) => c.format === 'set');
    if (!def) throw new CyError('NOT_SUPPORTED', 'model has no set-format control', { reason: 'control' });
    return def;
  }

  private frameDef(key: string): ControlFrameDef {
    this.check();
    const def = this.dev.def?.controls.find((c) => c.key === key);
    if (!def) throw new CyError('INVALID', `unknown control ${key}`, { reason: 'unknown_control' });
    return def;
  }

  private check(): void {
    this.dev.require('control');
    this.dev.requireResolved();
  }

  /** Validates `fields` and encodes them for the board's current address. */
  private encode(def: ControlFrameDef, fields: ControlFields): TxFrame {
    const addr = this.dev.address;
    switch (def.format) {
      case 'set': {
        if (!('mode' in fields)) throw invalid('fields');
        const mode = findMode(def, fields.mode);
        if (!Number.isFinite(fields.value) || fields.value < mode.min || fields.value > mode.max) throw invalid('out_of_range');
        return encodeCtrlSet(addr, { mode: mode.value, flags: 0, value: fields.value });
      }
      case 'servo4': {
        if (!('pulsesUs' in fields) || fields.pulsesUs.length > 4) throw invalid('fields');
        const p: [number, number, number, number] = [0, 0, 0, 0];
        for (let i = 0; i < 4; i++) {
          const v = fields.pulsesUs[i] ?? 0;
          if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw invalid('out_of_range');
          p[i] = v;
        }
        return encodeCtrlServo(addr, { index: def.index, pulsesUs: p });
      }
      case 'text':
        if (!('text' in fields)) throw invalid('fields');
        return encodeCtrlText(addr, { line: fields.line, col: fields.col, text: fields.text });
    }
  }

  /** Neutral command per frame format; text frames have none. */
  private neutral(def: ControlFrameDef, addr: Address): TxFrame | null {
    if (def.format === 'set') return encodeCtrlSet(addr, { mode: offMode(def), flags: 0, value: 0 });
    if (def.format === 'servo4') return encodeCtrlServo(addr, { index: def.index, pulsesUs: [0, 0, 0, 0] });
    return null;
  }
}

function offMode(def: ControlFrameDef): number {
  return def.modes?.find((m) => m.key === 'off')?.value ?? 0;
}

/** Whether `fields` already is the neutral command of its frame (text frames never drive). */
function isNeutral(def: ControlFrameDef, fields: ControlFields): boolean {
  if (def.format === 'set' && 'mode' in fields) {
    const m = typeof fields.mode === 'number' ? fields.mode : def.modes?.find((x) => x.key === fields.mode)?.value;
    return m === offMode(def) && fields.value === 0;
  }
  if (def.format === 'servo4' && 'pulsesUs' in fields) return fields.pulsesUs.every((p) => p === 0);
  return def.format === 'text';
}

function findMode(def: ControlFrameDef, mode: number | string): ControlModeDef {
  const m = def.modes?.find((x) => (typeof mode === 'number' ? x.value === mode : x.key === mode));
  if (!m) throw invalid('unknown_mode');
  return m;
}

function invalid(reason: string): CyError {
  return new CyError('INVALID', `control: ${reason}`, { reason });
}
