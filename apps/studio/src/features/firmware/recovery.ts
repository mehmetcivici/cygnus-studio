import type { DeviceHandle } from '@cygnus/protocol';

export type RecoveryStep = 'intro' | 'listening' | 'flashing' | 'finished';

/** Boards held in the bootloader by the beacon that were not flashed go back to their application. */
export async function rebootOthers(waiting: readonly Pick<DeviceHandle, 'uid48' | 'reboot'>[], flashed: ReadonlySet<string>): Promise<{ rebooted: number; failed: number }> {
  let rebooted = 0;
  let failed = 0;
  for (const d of waiting) {
    if (flashed.has(d.uid48)) continue;
    try {
      await d.reboot();
      rebooted++;
    } catch {
      failed++;
    }
  }
  return { rebooted, failed };
}

/** Where the dialog is, from what the bus reports. */
export function recoveryStep(active: boolean, waiting: number, flashing: boolean, finished: boolean): RecoveryStep {
  if (finished) return 'finished';
  if (flashing) return 'flashing';
  if (active || waiting > 0) return 'listening';
  return 'intro';
}
