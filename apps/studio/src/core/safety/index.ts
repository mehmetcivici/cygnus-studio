import { useEffect, useState } from 'react';
import { DeviceState, type DeviceHandle } from '@cygnus/protocol';
import { onEstop } from '../../app/estop';
import { useNav } from '../../app/nav';
import { connection, useConnection } from '../connection/manager';
import { useBusStore } from '../store/busStore';
import { DriveController, useDrive, type DriveSession, type DriveStopReason } from './drive';

export { DriveController, DriveSession, useDrive } from './drive';
export type { ArmBlock, DriveEnv, DriveInfo, DriveState, DriveStopReason } from './drive';

export const drive = new DriveController({
  resolve: (uid) => connection.current?.deviceByUid(uid),
  isConnected: () => useConnection.getState().phase === 'connected',
  statusOf: (uid) => useBusStore.getState().byUid[uid]?.status,
  now: () => Date.now(),
});

/** Starts a drive session for `owner` on a board; null while another owner is armed. */
export function requestDrive(owner: string, device: DeviceHandle | string): DriveSession | null {
  return drive.requestDrive(owner, device);
}

/**
 * Clears the E-STOP latch: boards that latched ESTOP get CLEAR_ESTOP, then arming is allowed
 * again. Returns the boards that refused (still latched on the board).
 */
export async function clearEstop(): Promise<DeviceHandle[]> {
  const bus = connection.current;
  const failed: DeviceHandle[] = [];
  if (bus) {
    const latched = bus.devices.filter((d) => d.online && (d.state === DeviceState.ESTOP || (d.faults.active & (1 << 9)) !== 0));
    const results = await Promise.allSettled(latched.map((d) => d.clearEstop()));
    results.forEach((r, i) => {
      const d = latched[i];
      if (r.status === 'rejected' && d && d.capabilities.commands) failed.push(d);
    });
  }
  drive.clearLatch();
  return failed;
}

/** Installs the automatic cut-offs. Call once at startup. */
export function installSafety(): () => void {
  const offs: Array<() => void> = [];
  const cut = (r: DriveStopReason) => () => drive.cut(r);
  if (typeof window !== 'undefined') {
    const onBlur = cut('blur');
    const onVis = (): void => {
      if (document.visibilityState === 'hidden') drive.cut('hidden');
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVis);
    offs.push(() => window.removeEventListener('blur', onBlur), () => document.removeEventListener('visibilitychange', onVis));
  }
  offs.push(
    useNav.subscribe((s, prev) => {
      if (s.screen !== prev.screen || s.params !== prev.params) drive.cut('navigation');
    }),
    useConnection.subscribe((s, prev) => {
      if (s.phase !== 'connected' && prev.phase === 'connected') drive.cut('disconnected');
      if (s.bus !== prev.bus) drive.cut('disconnected');
    }),
    useBusStore.subscribe((s, prev) => {
      if (s.byUid !== prev.byUid) drive.checkDevice();
    }),
    onEstop(() => {
      // Broadcast first: it reaches every board even if the session bookkeeping throws.
      try {
        connection.current?.estop();
      } finally {
        drive.estop();
      }
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}

export interface UseDriveSession {
  session: DriveSession | null;
  armed: boolean;
  /** Another screen is armed and holds the actuators. */
  busyOwner: string | null;
}

/**
 * Owns a drive session for the lifetime of the component (or until `uid48` changes).
 * ```tsx
 * const { session, armed } = useDriveSession('tuner', device?.uid48);
 * useEffect(() => session?.onStop(() => generator.stop()), [session]);
 * <ArmButton session={session} />
 * ```
 */
export function useDriveSession(owner: string, uid48: string | null | undefined): UseDriveSession {
  const [session, setSession] = useState<DriveSession | null>(null);
  const [retry, setRetry] = useState(0);
  const [refused, setRefused] = useState(false);
  const info = useDrive((s) => s.session);
  useEffect(() => {
    if (!uid48) return;
    const s = drive.requestDrive(owner, uid48);
    setSession(s);
    setRefused(s === null);
    return () => {
      s?.release();
      setSession(null);
    };
  }, [owner, uid48, retry]);
  // Refused because another screen was armed: try again once it lets go.
  const waiting = refused && info?.armed !== true;
  useEffect(() => {
    if (waiting) setRetry((r) => r + 1);
  }, [waiting]);
  const mine = session !== null && info?.id === session.id;
  return {
    session: mine ? session : null,
    armed: mine && info?.armed === true,
    busyOwner: !mine && info?.armed ? info.owner : null,
  };
}
