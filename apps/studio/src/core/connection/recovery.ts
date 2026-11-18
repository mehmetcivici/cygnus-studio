import { create } from 'zustand';
import type { CygnusBus } from '@cygnus/protocol';
import { connection } from './manager';

/**
 * Recovery mode (PROTOCOL §9.0) for the screens: the bus broadcasts the recovery beacon while the
 * user power-cycles the vehicle; boards that boot meanwhile stay in their bootloader and can be
 * reflashed (`d.firmware.update`). Actuation cannot be armed while it runs.
 */
interface RecoveryState {
  active: boolean;
  /** uid48 of online boards waiting in their bootloader. */
  waiting: readonly string[];
}

export const useRecovery = create<RecoveryState>(() => ({ active: false, waiting: [] }));

export const recovery = {
  /** Starts the beacon on the current bus. False when not connected. */
  start(): boolean {
    const bus = connection.current;
    if (!bus) return false;
    bus.recovery.start();
    return bus.recovery.active;
  },
  stop(): void {
    connection.current?.recovery.stop();
  },
  get active(): boolean {
    return connection.current?.recovery.active ?? false;
  },
};

/** @internal Mirrors the bus' recovery state into the store (called by initCore per bus). */
export function bindRecovery(bus: CygnusBus): () => void {
  const sync = (): void => {
    const waiting = bus.recovery.devices.map((d) => d.uid48);
    const cur = useRecovery.getState();
    const active = bus.recovery.active;
    if (cur.active !== active || cur.waiting.length !== waiting.length || cur.waiting.some((u, i) => u !== waiting[i])) {
      useRecovery.setState({ active, waiting });
    }
  };
  sync();
  const offs = [bus.on('recovery', sync), bus.on('deviceAdded', sync), bus.on('deviceChanged', sync), bus.on('deviceLost', sync)];
  return () => {
    for (const off of offs) off();
    useRecovery.setState({ active: false, waiting: [] });
  };
}
