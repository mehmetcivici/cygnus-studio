import { signalByKey, type ControlFrameDef, type ControlModeDef, type ModelDef } from '@cygnus/protocol';

/** Modes offered for manual driving: everything but "off" (stopping is the disarm button). */
export function driveModes(frame: ControlFrameDef): ControlModeDef[] {
  return (frame.modes ?? []).filter((m) => m.key !== 'off');
}

export interface ControlRange {
  min: number;
  max: number;
  step: number;
  digits: number;
}

/** 1-2-5 step close to span / 200. */
function niceStep(span: number): number {
  const raw = span / 200;
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * Slider range for a mode: the mode's setpoint limits narrowed to the display range of the
 * measured signal (an ESC accepts ±100000 turns, a person wants ±10). Null for modes without
 * a setpoint (brake).
 */
export function controlRange(def: ModelDef, mode: ControlModeDef): ControlRange | null {
  if (mode.min === mode.max) return null;
  let min = mode.min;
  let max = mode.max;
  const sig = mode.measured ? signalByKey(def, mode.measured) : undefined;
  if (sig) {
    min = Math.max(min, sig.range[0]);
    max = Math.min(max, sig.range[1]);
    // A current setpoint is signed even where the measured signal starts at zero.
    if (mode.min < 0 && min >= 0) min = -max;
  }
  if (!(max > min)) {
    min = mode.min;
    max = mode.max;
  }
  const step = niceStep(max - min);
  const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return { min, max, step, digits };
}
