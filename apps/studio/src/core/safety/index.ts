import { useEffect, useState } from 'react';
import { DeviceState, type DeviceHandle } from '@cygnus/protocol';
import { onEstop } from '../../app/estop';
import { navigate, setNavGuard, useNav } from '../../app/nav';
import { toast } from '../../ui';
import { t } from '../../i18n';
import { DEMO_SCENARIO_ID } from '../connection/sources';
import { confirmLeave, isBusy } from './busy';
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
  recoveryActive: () => connection.current?.recovery.active ?? false,
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

/**
 * The link or the page is going away while a board is armed: neutral to that board first (the
 * session stop), then an E-STOP broadcast so nothing keeps moving on its last command until the
 * board's own timeout. Latches E-STOP locally, the user clears it after reconnecting.
 * Returns true when something was armed.
 */
export function stopForTeardown(reason: 'disconnected' | 'hidden', bus = connection.current): boolean {
  if (!drive.state().session?.armed) return false;
  drive.cut(reason);
  try {
    bus?.estop();
  } finally {
    useDrive.setState({ estopLatched: true });
  }
  return true;
}

/** Demo motion (a hand-turned flywheel) must never look like a motor ignoring E-STOP. */
function syncAmbient(): void {
  const { estopLatched, session } = drive.state();
  const conn = useConnection.getState();
  const quiet = estopLatched || session?.armed === true;
  if (quiet && conn.ambient) connection.setAmbient(false);
  else if (!quiet && !conn.ambient && conn.phase === 'connected' && conn.sim && conn.source?.kind === 'sim' && conn.source.scenarioId === DEMO_SCENARIO_ID && ambientWanted) {
    connection.setAmbient(true);
  }
}
// The demo turns ambient on by itself; once the user switched it off explicitly we keep it off.
let ambientWanted = true;
export function setAmbientWanted(on: boolean): void {
  ambientWanted = on;
  if (on) syncAmbient();
  else connection.setAmbient(false);
}

/** Installs the automatic cut-offs. Call once at startup. */
export function installSafety(): () => void {
  const offs: Array<() => void> = [];
  const cut = (r: DriveStopReason) => () => drive.cut(r);
  offs.push(
    setNavGuard((screen, params) => {
      if (!isBusy()) return true;
      void confirmLeave('navigate').then((ok) => {
        if (ok) navigate(screen, params, { force: true });
      });
      return false;
    }),
    connection.onBeforeTeardown((bus) => {
      if (stopForTeardown('disconnected', bus)) toast.warn(t('core.drive.disconnectEstop'), { id: 'drive.teardown' });
    }),
    useDrive.subscribe((s, prev) => {
      if (s.estopLatched !== prev.estopLatched || s.session?.armed !== prev.session?.armed) syncAmbient();
    }),
    useConnection.subscribe((s, prev) => {
      // ambient was just switched on by the connection (demo start) while latched/armed
      if (s.ambient && !prev.ambient) syncAmbient();
    }),
  );
  if (typeof window !== 'undefined') {
    // The page dies (reload, close, navigation away): stop while frames can still go out.
    const onPageHide = (): void => {
      stopForTeardown('hidden');
    };
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (isBusy() || drive.state().session?.armed) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    offs.push(() => window.removeEventListener('pagehide', onPageHide), () => window.removeEventListener('beforeunload', onBeforeUnload));
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
  /**
   * Increments on every arming of this screen's session (0 before the first). Reset command state
   * when it changes (`useEffect(() => setTarget(0), [armGeneration])`) so re-arming never resumes
   * the previous target.
   */
  armGeneration: number;
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
    armGeneration: mine && info ? info.armGeneration : 0,
    busyOwner: !mine && info?.armed ? info.owner : null,
  };
}
