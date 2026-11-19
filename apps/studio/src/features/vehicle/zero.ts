import type { DeviceHandle } from '@cygnus/protocol';

export type ZeroDevice = Pick<DeviceHandle, 'command' | 'save' | 'def'>;

export interface ZeroResult {
  ok: string[];
  failed: Array<{ slotId: string; error: unknown }>;
}

/**
 * "Zero here" on each steer encoder, then save so the offset survives a power cycle. Boards are
 * done one after another: a module that fails does not stop the others, and the caller lists it.
 */
export async function zeroEncoders(
  targets: ReadonlyArray<{ slotId: string; device: ZeroDevice | undefined; model: string }>,
  onProgress?: (slotId: string) => void,
): Promise<ZeroResult> {
  const out: ZeroResult = { ok: [], failed: [] };
  for (const t of targets) {
    try {
      if (!t.device) throw new Error('offline');
      // The uid48 of the binding may now belong to a card of another model: never command it.
      if (t.device.def?.key !== t.model) throw new Error(`model ${t.device.def?.key ?? '?'} ≠ ${t.model}`);
      await t.device.command('zero_here');
      await t.device.save();
      out.ok.push(t.slotId);
    } catch (error) {
      out.failed.push({ slotId: t.slotId, error });
    }
    onProgress?.(t.slotId);
  }
  return out;
}

/** Absolute position (rotations) as a signed angle in degrees, (-180, 180]. */
export function rotToSignedDeg(rot: number): number {
  if (!Number.isFinite(rot)) return NaN;
  let d = (rot * 360) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Within this many degrees of zero a module counts as aligned. */
export const ALIGNED_DEG = 2;
