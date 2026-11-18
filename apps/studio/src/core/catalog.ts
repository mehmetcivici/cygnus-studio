import { signalByKey, type ModelDef, type SignalDef } from '@cygnus/protocol';
import { fmtNumber, tl, type Lang } from '../i18n';
import type { Tone } from '../ui';
import { toDisplayUnit, type Settings } from './settings';

/** The 2–3 signals that best summarise a board (Bus screen cards, device headers). */
const PRIMARY: Record<string, readonly string[]> = {
  esc20a: ['velocity', 'bus.current', 'temp.fet'],
  esc80a: ['velocity', 'bus.current', 'temp.fet'],
  cyncoder: ['position', 'velocity', 'magnet.status'],
  cyncoder_v3: ['position', 'velocity', 'magnet.health'],
  gyro: ['yaw', 'pitch', 'roll'],
  servo16: ['rail.voltage', 'rail.current', 'temp'],
  sealed_servo: ['position', 'current', 'temp'],
  pdh_small: ['input.voltage', 'total.current', 'rail12.voltage'],
  pdh_large: ['input.voltage', 'total.current', 'power'],
  soc_reg: ['output.voltage', 'output.current', 'temp'],
  oled: [],
  usbcan: ['bus.load', 'bus.devices', 'bus.error_frames'],
};

const cache = new WeakMap<ModelDef, readonly string[]>();

/** Stable array (safe as a hook dependency). */
export function primarySignals(def: ModelDef | undefined, max = 3): readonly string[] {
  if (!def) return [];
  let keys = cache.get(def);
  if (!keys) {
    keys = (PRIMARY[def.key] ?? def.signals.filter((s) => !s.options && !s.bits).map((s) => s.key)).filter((k) => signalByKey(def, k)).slice(0, max);
    cache.set(def, keys);
  }
  return keys;
}

export function isDiscrete(sig: SignalDef): boolean {
  return !!sig.options || !!sig.bits;
}

/** Signal value for text: option label, set bits, or the number in display units. */
export function formatSignal(sig: SignalDef | undefined, v: number, lang: Lang, s?: Pick<Settings, 'angleUnit' | 'tempUnit'>): { text: string; unit: string } {
  if (!Number.isFinite(v)) return { text: '—', unit: sig?.unit ?? '' };
  if (!sig) return { text: fmtNumber(v, 2, { lang }), unit: '' };
  if (sig.options) {
    const o = sig.options.find((x) => x.value === v);
    return { text: o ? tl(o.label, lang) : String(v), unit: '' };
  }
  if (sig.bits) {
    const on = sig.bits.filter((_, i) => (v & (1 << i)) !== 0).map((b) => tl(b, lang));
    return { text: on.length ? on.join(', ') : '—', unit: '' };
  }
  const d = toDisplayUnit(v, sig.unit, s);
  const digits = d.unit === sig.unit ? sig.digits : Math.max(0, sig.digits - 1);
  return { text: fmtNumber(d.value, digits, { lang }), unit: d.unit };
}

/** Tone for a value near the edge of its catalog display range (temperatures, currents). */
export function rangeTone(sig: SignalDef | undefined, v: number): Tone {
  if (!sig || !Number.isFinite(v) || isDiscrete(sig)) return 'neutral';
  const [lo, hi] = sig.range;
  if (lo >= 0 && hi > 0 && (sig.unit === '°C' || sig.unit === 'A')) {
    const f = v / hi;
    if (f > 0.9) return 'danger';
    if (f > 0.75) return 'caution';
  }
  return 'neutral';
}
