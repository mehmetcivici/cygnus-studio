import type { CygnusBus } from '@cygnus/protocol';
import { connection } from './connection/manager';
import { frameTrace } from './recorder/frames';
import { signalHistory } from './recorder/history';
import { sessionRecorder } from './recorder/session';
import { installSafety } from './safety';
import { bindStore } from './store/hooks';

function bindServices(bus: CygnusBus): () => void {
  const unbindStore = bindStore(bus);
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
  if (opts.autoConnect !== false) connection.autoStart();
}
