import { useCallback, useRef, useSyncExternalStore } from 'react';
import { paramByKey, type BusStats, type CygnusBus, type ParamDef, type TransportState } from '@cygnus/protocol';
import { useConnection, type ConnectionPhase } from '../connection/manager';
import { bindBusStore, selectDevice, useBusStore } from './busStore';
import type { DeviceView } from './deviceView';
import { ParamCache, type ParamSnapshot } from './paramCache';
import { SignalHub } from './signalHub';

export const signalHub = new SignalHub();
export const paramCache = new ParamCache();

/** Connects store, signal hub and parameter cache to a bus; returns the unbind function. */
export function bindStore(bus: CygnusBus): () => void {
  const unbindStore = bindBusStore(bus);
  const resolve = (uid: string) => bus.deviceByUid(uid);
  signalHub.setResolver(resolve);
  paramCache.setResolver(resolve);
  const avail = (d: { uid48: string }): void => {
    signalHub.deviceAvailable(d.uid48);
    paramCache.deviceAvailable(d.uid48);
  };
  const offs = [bus.on('deviceAdded', avail), bus.on('deviceChanged', avail)];
  return () => {
    for (const off of offs) off();
    signalHub.setResolver(null);
    paramCache.setResolver(null);
    unbindStore();
  };
}

// ---- devices -------------------------------------------------------------------------------

/** All boards in bus order (lost ones included, `online: false`). */
export function useDevices(): readonly DeviceView[] {
  return useBusStore((s) => s.devices);
}

export function useDevice(uid48: string | null | undefined): DeviceView | undefined {
  return useBusStore((s) => (uid48 ? s.byUid[uid48] : undefined));
}

/** Boards that are unassigned (number 63) or share a number with another board. */
export function useUnresolved(): DeviceView[] {
  const unresolved = useBusStore((s) => s.unresolved);
  const byUid = useBusStore((s) => s.byUid);
  return unresolved.map((u) => byUid[u]).filter((d): d is DeviceView => d !== undefined);
}

export function useBusStats(): BusStats | null {
  return useBusStore((s) => s.stats);
}

export interface LinkState {
  phase: ConnectionPhase;
  transport: TransportState;
  label: string;
  error: string | null;
  isSim: boolean;
}

export function useLinkState(): LinkState {
  const phase = useConnection((s) => s.phase);
  const label = useConnection((s) => s.label);
  const error = useConnection((s) => s.error);
  const isSim = useConnection((s) => s.sim !== null);
  const transport = useBusStore((s) => s.transport);
  return { phase, transport, label, error, isSim };
}

export function useSelectedDevice(): [DeviceView | undefined, (uid48: string | null) => void] {
  const uid = useBusStore((s) => s.selectedUid);
  const view = useBusStore((s) => (uid ? s.byUid[uid] : undefined));
  return [view, selectDevice];
}

// ---- live signals ------------------------------------------------------------------------

/** Latest value of one STATUS signal (NaN until seen). Re-renders ≤ 20 Hz, only on change. */
export function useSignal(uid48: string | null | undefined, key: string): number {
  const subscribe = useCallback((cb: () => void) => (uid48 ? signalHub.subscribe(uid48, key, cb) : () => undefined), [uid48, key]);
  const get = useCallback(() => (uid48 ? signalHub.read(uid48, key) : NaN), [uid48, key]);
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * Several signals of one board as `{ key: value }`. The returned object is stable until one of
 * the values changes. Pass a stable `keys` array (module constant or useMemo).
 */
export function useSignals(uid48: string | null | undefined, keys: readonly string[]): Readonly<Record<string, number>> {
  const cache = useRef<Record<string, number>>({});
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!uid48) return () => undefined;
      const offs = keys.map((k) => signalHub.subscribe(uid48, k, cb));
      return () => {
        for (const off of offs) off();
      };
    },
    [uid48, keys],
  );
  const get = useCallback(() => {
    const prev = cache.current;
    let same = Object.keys(prev).length === keys.length;
    for (const k of keys) {
      const v = uid48 ? signalHub.read(uid48, k) : NaN;
      if (!same || !Object.is(prev[k], v)) same = false;
    }
    if (same) return prev;
    const next: Record<string, number> = {};
    for (const k of keys) next[k] = uid48 ? signalHub.read(uid48, k) : NaN;
    cache.current = next;
    return next;
  }, [uid48, keys]);
  return useSyncExternalStore(subscribe, get, get);
}

// ---- parameters ----------------------------------------------------------------------------

export interface ParamState extends ParamSnapshot {
  def: ParamDef | undefined;
  /** Writes through the board; resolves with the value it holds afterwards. Throws CyError. */
  set: (value: number) => Promise<number>;
}

const NOOP_UNSUB = (): void => undefined;
const EMPTY_SNAP: ParamSnapshot = { value: undefined, loading: false, error: null };

/** One board parameter: cached value, read on first use, kept current by `paramChanged`. */
export function useParam(uid48: string | null | undefined, key: string): ParamState {
  const subscribe = useCallback((cb: () => void) => (uid48 ? paramCache.subscribe(uid48, key, cb) : NOOP_UNSUB), [uid48, key]);
  const get = useCallback(() => (uid48 ? paramCache.read(uid48, key) : EMPTY_SNAP), [uid48, key]);
  const snap = useSyncExternalStore(subscribe, get, get);
  const view = useDevice(uid48);
  const def = view?.def ? paramByKey(view.def, key) : undefined;
  const set = useCallback(
    (value: number) => {
      const h = view?.handle;
      if (!h) return Promise.reject(new Error('device not available'));
      return h.setParam(key, value);
    },
    [view?.handle, key],
  );
  return { ...snap, def, set };
}
