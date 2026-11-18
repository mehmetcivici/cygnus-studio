import { buildCyfw, getModel } from '@cygnus/protocol';
import { Prng } from './prng';
import type { FirmwareVersion } from './node';

export interface DemoFirmwareOptions {
  /** Payload size in bytes (default 6144). */
  size?: number;
  hwRevMin?: number;
  hwRevMax?: number;
}

/**
 * A valid `.cyfw` image for `model` (deterministic contents per model + version), for the
 * Firmware screen and tests. The simulated bootloader accepts it and reboots into `version`.
 */
export function makeDemoFirmware(model: number, version: FirmwareVersion | string, o: DemoFirmwareOptions = {}): Uint8Array {
  const def = getModel(model);
  if (!def) throw new Error(`unknown model ${model}`);
  const v = typeof version === 'string' ? parseVersion(version) : version;
  const seed = (model << 24) ^ (v.major << 16) ^ (v.minor << 8) ^ v.patch;
  const payload = new Prng(seed || 1).bytes(o.size ?? 6144);
  return buildCyfw(
    {
      model,
      hwRevMin: o.hwRevMin ?? 1,
      hwRevMax: o.hwRevMax ?? 3,
      fwMajor: v.major,
      fwMinor: v.minor,
      fwPatch: v.patch,
      catalogRev: def.catalogRev,
      gitHash: (Math.imul(seed, 2654435761) >>> 0),
      buildDay: 320,
      name: `${def.key}-${v.major}.${v.minor}.${v.patch}`.slice(0, 24),
    },
    payload,
  );
}

function parseVersion(s: string): FirmwareVersion {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) throw new Error(`bad version ${s}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
