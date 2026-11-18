import { create } from 'zustand';
import { DeviceState, type DeviceHandle } from '@cygnus/protocol';
import { describeError, paramCache } from '../../core';
import { toast } from '../../ui';
import { markSaved } from './logic/baseline';
import { tDevice } from './messages';

/** All parameter values of a board, read in one sweep (cached values are refreshed). */
export async function readValues(h: DeviceHandle): Promise<Record<string, number>> {
  await paramCache.loadAll(h.uid48);
  return Object.fromEntries(h.params);
}

export async function saveDevice(h: DeviceHandle, quiet = false): Promise<boolean> {
  try {
    await h.save();
    markSaved(h);
    if (!quiet) toast.success(tDevice('ops.saved'), { id: `save-${h.uid48}` });
    return true;
  } catch (e) {
    toast.error(tDevice('ops.saveFailed'), { description: describeError(e) });
    return false;
  }
}

/** Boards rebooted from this screen that have not come back yet (uid48 set). */
export const useRebooting = create<{ uids: ReadonlySet<string> }>(() => ({ uids: new Set() }));

function setRebooting(uid48: string, on: boolean): void {
  const next = new Set(useRebooting.getState().uids);
  if (on) next.add(uid48);
  else next.delete(uid48);
  useRebooting.setState({ uids: next });
}

const BACK_TIMEOUT_MS = 10_000;

/** Resolves when the board answers again after a reboot (heartbeat back, INFO re-read). */
function whenBack(h: DeviceHandle): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = h.on('changed', () => {
      if (h.online && h.infoLoaded && h.state !== DeviceState.BOOT) done();
    });
    const timer = setTimeout(done, BACK_TIMEOUT_MS);
  });
}

/**
 * Reboots a board. The screen hides its parameter views first: they would re-read every
 * watched value the moment the cache is invalidated, while the board is still silent.
 */
export async function rebootDevice(h: DeviceHandle): Promise<boolean> {
  setRebooting(h.uid48, true);
  await new Promise((r) => setTimeout(r, 0));
  try {
    await h.reboot();
    toast.info(tDevice('ops.rebooting'), { id: `reboot-${h.uid48}` });
    await whenBack(h);
    return true;
  } catch (e) {
    toast.error(tDevice('ops.rebootFailed'), { description: describeError(e) });
    return false;
  } finally {
    setRebooting(h.uid48, false);
  }
}

/**
 * Writes values one by one (boards answer one parameter request at a time and limits can
 * depend on order). Returns the keys that failed with readable reasons.
 */
export async function writeValues(
  h: DeviceHandle,
  writes: ReadonlyArray<{ key: string; value: number }>,
  onProgress?: (done: number, total: number) => void,
): Promise<Array<{ key: string; error: string }>> {
  const failed: Array<{ key: string; error: string }> = [];
  let done = 0;
  for (const w of writes) {
    try {
      await h.setParam(w.key, w.value);
    } catch (e) {
      failed.push({ key: w.key, error: describeError(e) });
    }
    onProgress?.(++done, writes.length);
  }
  return failed;
}
