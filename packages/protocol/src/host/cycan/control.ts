import type { ControlFrameDef, ControlModeDef } from '../../catalog/schema';
import { Timing } from '../../core/constants';
import type { TxFrame } from '../../core/frame';
import { encodeCtrlServo, encodeCtrlSet, encodeCtrlText } from '../../core/messages';
import { CyError } from '../errors';
import type { ControlFields, ControlLoop, DeviceControl } from '../types';
import type { CyCanDevice } from './device';

const DEFAULT_RATE_HZ = 50;
const MIN_PERIOD_MS = 5;

interface SessionFrame {
  def: ControlFrameDef;
  frame: TxFrame;
}

/**
 * Actuator commands. A device has at most one periodic session; it re-sends every frame it
 * holds fast enough to beat `ctrl.timeout_ms`, and `stop()` follows up with neutral frames.
 */
export class CyCanControl implements DeviceControl {
  private readonly session = new Map<string, SessionFrame>();
  private timer: unknown = undefined;
  private period = 1000 / DEFAULT_RATE_HZ;
  /** Bumped whenever the session ends, so stale ControlLoop handles go inert. */
  private generation = 0;
  private readonly tick = (): void => {
    const gen = this.generation;
    this.timer = undefined;
    for (const s of this.session.values()) this.dev.send(s.frame);
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

  set(mode: number | string, value: number): void {
    const def = this.setFrameDef();
    this.dev.send(this.encode(def, { mode, value }));
  }

  start(mode: number | string, value: number, opts: { rateHz?: number } = {}): ControlLoop {
    const def = this.setFrameDef();
    this.hold(def, this.encode(def, { mode, value }), opts.rateHz);
    const gen = this.generation;
    let curMode = mode;
    const live = (): boolean => gen === this.generation && this.session.has(def.key);
    return {
      get active() {
        return live();
      },
      update: (v: number) => {
        if (!live()) return;
        this.session.set(def.key, { def, frame: this.encode(def, { mode: curMode, value: v }) });
      },
      setMode: (m: number | string, v = 0) => {
        if (!live()) return;
        const frame = this.encode(def, { mode: m, value: v });
        curMode = m;
        this.session.set(def.key, { def, frame });
      },
      stop: () => {
        if (live()) this.stop();
      },
    };
  }

  send(controlKey: string, fields: ControlFields, opts: { repeat?: boolean; rateHz?: number } = {}): void {
    const def = this.frameDef(controlKey);
    const frame = this.encode(def, fields);
    if (opts.repeat) this.hold(def, frame, opts.rateHz);
    else this.dev.send(frame);
  }

  stop(): void {
    const frames = [...this.session.values()];
    this.halt();
    for (const s of frames) {
      const neutral = this.neutral(s.def);
      if (neutral) this.dev.send(neutral);
    }
  }

  /** Ends the session without sending anything (ESTOP, lost board, transport down). */
  halt(): void {
    if (this.timer !== undefined) this.dev.ctx.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
    this.session.clear();
    this.generation++;
  }

  private hold(def: ControlFrameDef, frame: TxFrame, rateHz?: number): void {
    this.period = this.periodFor(rateHz);
    this.session.set(def.key, { def, frame });
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
  private neutral(def: ControlFrameDef): TxFrame | null {
    const addr = this.dev.address;
    if (def.format === 'set') {
      const off = def.modes?.find((m) => m.key === 'off')?.value ?? 0;
      return encodeCtrlSet(addr, { mode: off, flags: 0, value: 0 });
    }
    if (def.format === 'servo4') return encodeCtrlServo(addr, { index: def.index, pulsesUs: [0, 0, 0, 0] });
    return null;
  }
}

function findMode(def: ControlFrameDef, mode: number | string): ControlModeDef {
  const m = def.modes?.find((x) => (typeof mode === 'number' ? x.value === mode : x.key === mode));
  if (!m) throw invalid('unknown_mode');
  return m;
}

function invalid(reason: string): CyError {
  return new CyError('INVALID', `control: ${reason}`, { reason });
}
