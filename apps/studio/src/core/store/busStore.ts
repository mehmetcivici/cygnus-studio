import { create } from 'zustand';
import type { BusStats, CygnusBus, DeviceHandle, TransportState } from '@cygnus/protocol';
import { browserClock, type UiClock } from '../util/clock';
import { makeDeviceView, type DeviceView } from './deviceView';

export interface BusStoreState {
  /** Bus order (type, number, UID); lost boards included (`online: false`). */
  devices: readonly DeviceView[];
  byUid: Readonly<Record<string, DeviceView>>;
  /** UIDs of boards that are unassigned or in conflict (as `bus.unresolved`). */
  unresolved: readonly string[];
  stats: BusStats | null;
  transport: TransportState;
  selectedUid: string | null;
}

const initial: Omit<BusStoreState, 'selectedUid'> = {
  devices: [],
  byUid: {},
  unresolved: [],
  stats: null,
  transport: { phase: 'closed' },
};

export const useBusStore = create<BusStoreState>(() => ({ ...initial, selectedUid: null }));

/** Device list updates are coalesced: at most one store commit per this many ms. */
export const DEVICE_FLUSH_MS = 50;

/**
 * Wires one bus into the store. Device events only mark UIDs dirty; a single flush rebuilds
 * changed views and keeps unchanged ones reference-equal. Returns the unbind function, which
 * clears the store.
 */
export function bindBusStore(bus: CygnusBus, clock: UiClock = browserClock): () => void {
  const dirty = new Set<string>();
  let structural = true;
  let scheduled = false;
  let lastFlush = -Infinity;
  let alive = true;

  const flush = (): void => {
    scheduled = false;
    if (!alive) return;
    lastFlush = clock.now();
    const prev = useBusStore.getState();
    const handles = bus.devices;
    const byUid: Record<string, DeviceView> = {};
    let changed = structural || handles.length !== prev.devices.length;
    const devices = handles.map((h, i) => {
      const old = prev.byUid[h.uid48];
      const view = old && old.handle === h && !dirty.has(h.uid48) ? old : makeDeviceView(h);
      if (view !== prev.devices[i]) changed = true;
      byUid[h.uid48] = view;
      return view;
    });
    dirty.clear();
    structural = false;
    if (!changed) return;
    const unresolved = bus.unresolved.map((d) => d.uid48);
    const same = unresolved.length === prev.unresolved.length && unresolved.every((u, i) => u === prev.unresolved[i]);
    useBusStore.setState({ devices, byUid, unresolved: same ? prev.unresolved : unresolved });
  };

  const request = (): void => {
    if (scheduled || !alive) return;
    scheduled = true;
    clock.schedule(flush, Math.max(0, lastFlush + DEVICE_FLUSH_MS - clock.now()));
  };
  const mark = (d: DeviceHandle): void => {
    dirty.add(d.uid48);
    request();
  };
  const markStructural = (d: DeviceHandle): void => {
    structural = true;
    mark(d);
  };

  const offs = [
    bus.on('deviceAdded', markStructural),
    bus.on('deviceRemoved', markStructural),
    bus.on('deviceChanged', mark),
    bus.on('deviceLost', mark),
    bus.on('stats', (stats) => useBusStore.setState({ stats: { ...stats } })),
    bus.on('transportState', (transport) => useBusStore.setState({ transport: { ...transport } })),
  ];
  useBusStore.setState({ ...initial, transport: bus.state, stats: null });
  request();

  return () => {
    alive = false;
    for (const off of offs) off();
    useBusStore.setState({ ...initial });
  };
}

/** Device the user is working with across screens (Device, Tuner, Plot pre-select it). */
export function selectDevice(uid48: string | null): void {
  useBusStore.setState({ selectedUid: uid48 });
}
