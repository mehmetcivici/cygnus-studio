import type { CygnusBus } from '@cygnus/protocol';
import { connection } from './connection/manager';
import { frameTrace } from './recorder/frames';
import { signalHistory } from './recorder/history';
import { sessionRecorder } from './recorder/session';
import { installSafety } from './safety';
import { bindStore } from './store/hooks';
import { bindRecovery } from './connection/recovery';
import { useBusStore } from './store/busStore';
import { displayName } from './store/deviceView';
import { useConnection } from './connection/manager';
import { useDrive } from './safety/drive';
import { AlertTracker, publishAlerts, simFeedMap } from './alerts';
import { currentLang } from '../i18n';

const ALERT_PERIOD_MS = 500;

/** Feeds the alert center from the live services (cheap: a few hundred boards at most, 2 Hz). */
function installAlerts(): () => void {
  const tracker = new AlertTracker();
  let connectedAt = 0;
  let gen = -1;
  const tick = (): void => {
    const conn = useConnection.getState();
    if (conn.generation !== gen) {
      gen = conn.generation;
      tracker.reset();
    }
    const now = Date.now();
    if (conn.phase !== 'connected') connectedAt = 0;
    else if (!connectedAt) connectedAt = now;
    const store = useBusStore.getState();
    const lang = currentLang();
    const sim = conn.sim;
    publishAlerts(
      tracker.update({
        now,
        phase: conn.phase,
        connectedFor: connectedAt ? now - connectedAt : 0,
        stats: store.stats,
        estopLatched: useDrive.getState().estopLatched,
        recovery: conn.bus?.recovery.active ?? false,
        devices: store.devices.map((d) => ({ ...d, label: displayName(d, lang), signals: d.handle.signals })),
        ...(sim ? { simShorted: sim.bus.shorted, feedOf: simFeedMap(sim) } : {}),
      }),
    );
  };
  const h = setInterval(tick, ALERT_PERIOD_MS);
  return () => clearInterval(h);
}

function bindServices(bus: CygnusBus): () => void {
  const unbindStore = bindStore(bus);
  const unbindRecovery = bindRecovery(bus);
  const resolve = (uid: string) => bus.deviceByUid(uid);
  signalHistory.setResolver(resolve);
  sessionRecorder.setResolver(resolve);
  frameTrace.setBus(bus);
  const off = bus.on('deviceAdded', (d) => signalHistory.deviceAvailable(d.uid48));
  const off2 = bus.on('deviceChanged', (d) => signalHistory.deviceAvailable(d.uid48));
  return () => {
    off();
    off2();
    frameTrace.setBus(null);
    sessionRecorder.setResolver(null);
    signalHistory.setResolver(null);
    unbindRecovery();
    unbindStore();
  };
}

let started = false;

/**
 * Starts the core once: binds store/recorders to whichever bus is active, installs the safety
 * cut-offs and E-STOP handler, and auto-starts the demo scenario (see `connection.autoStart`).
 */
export function initCore(opts: { autoConnect?: boolean } = {}): void {
  if (started) return;
  started = true;
  let unbind: (() => void) | null = null;
  connection.onBusChange((bus) => {
    unbind?.();
    unbind = bus ? bindServices(bus) : null;
  });
  installSafety();
  installAlerts();
  if (opts.autoConnect !== false) connection.autoStart();
}
