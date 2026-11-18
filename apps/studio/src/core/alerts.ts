import { create } from 'zustand';
import type { BusStats } from '@cygnus/protocol';
import type { Simulation } from '@cygnus/simulator';
import type { ConnectionPhase } from './connection/manager';

/**
 * Bus health alerts for the top bar's alert center: link loss, a silent/shorted bus, saturation,
 * lost boards (correlated with blown fuses), faults and the E-STOP latch. Pure tracker + store;
 * `installAlerts` feeds it from the live services.
 */
export type AlertSeverity = 'danger' | 'warn';

export interface Alert {
  /** Stable while the condition lasts (React key, dedupe). */
  id: string;
  severity: AlertSeverity;
  /** Global i18n key; `params` are raw values, numbers formatted by the view. */
  messageKey: string;
  params?: Readonly<Record<string, string | number>>;
  /** Second line, e.g. the probable cause of a lost board. */
  detailKey?: string;
  detailParams?: Readonly<Record<string, string | number>>;
  /** Where "Show" goes. */
  target?: { screen: string; params?: Readonly<Record<string, string>> };
  /** When the condition started (host ms). */
  since: number;
}

/** Minimal board info the tracker needs (DeviceView satisfies it). */
export interface AlertDevice {
  uid48: string;
  name: string;
  num: number;
  online: boolean;
  status: string;
  faults: { list: readonly { key: string }[] };
  /** Live signal values (`handle.signals`). */
  signals?: Readonly<Record<string, number>>;
  /** Display name already resolved by the caller. */
  label: string;
}

export interface AlertInput {
  now: number;
  phase: ConnectionPhase;
  /** ms since the bus reached `connected`. */
  connectedFor: number;
  stats: BusStats | null;
  devices: readonly AlertDevice[];
  estopLatched: boolean;
  /** Recovery beacon is running. */
  recovery?: boolean;
  /** Simulator only: the bus is shorted. */
  simShorted?: boolean;
  /** Simulator only: board → the distribution board channel feeding it. */
  feedOf?: (uid48: string) => { pdh: string; ch: number } | null;
}

export const LOAD_ALERT_PCT = 80;
/** A fuse and a lost board this close in time are reported together (hardware: no wiring info). */
export const FUSE_CORRELATION_MS = 2000;
/** The bus must be silent this long before it is called silent (boards boot, enumeration). */
const SILENT_AFTER_MS = 1500;
const TIMEOUT_WINDOW_MS = 5000;
const TIMEOUT_ALERT = 5;

const bitsOf = (mask: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) if (mask & (1 << i)) out.push(i + 1);
  return out;
};

export class AlertTracker {
  private lostAt = new Map<string, number>();
  private seenOnline = new Set<string>();
  /** `${pdh}:${ch}` → first time seen blown. */
  private fuseAt = new Map<string, number>();
  private timeoutSamples: Array<{ t: number; v: number }> = [];
  private since = new Map<string, number>();

  reset(): void {
    this.lostAt.clear();
    this.seenOnline.clear();
    this.fuseAt.clear();
    this.timeoutSamples = [];
    this.since.clear();
  }

  update(i: AlertInput): Alert[] {
    const out: Array<Omit<Alert, 'since'>> = [];

    if (i.estopLatched) out.push({ id: 'estop', severity: 'danger', messageKey: 'core.alerts.estop' });
    if (i.recovery) out.push({ id: 'recovery', severity: 'warn', messageKey: 'core.alerts.recovery', target: { screen: 'firmware' } });
    if (i.phase === 'lost') out.push({ id: 'link', severity: 'danger', messageKey: 'core.alerts.linkLost', target: { screen: 'bus' } });

    // Fuses: from the distribution board's mask signal, falling back to its fault bit.
    const blown: Array<{ pdh: AlertDevice; ch: number; at: number }> = [];
    const liveFuses = new Set<string>();
    for (const d of i.devices) {
      const mask = d.signals?.['fuse.mask'];
      const chans = mask !== undefined && mask > 0 ? bitsOf(mask) : d.faults.list.some((f) => f.key === 'fuse_blown') ? [0] : [];
      for (const ch of chans) {
        const key = `${d.uid48}:${ch}`;
        liveFuses.add(key);
        if (!this.fuseAt.has(key)) this.fuseAt.set(key, i.now);
        blown.push({ pdh: d, ch, at: this.fuseAt.get(key) ?? i.now });
      }
    }
    for (const k of [...this.fuseAt.keys()]) if (!liveFuses.has(k)) this.fuseAt.delete(k);

    const connected = i.phase === 'connected';
    let silent = false;
    if (connected && i.simShorted) {
      out.push({ id: 'bus.short', severity: 'danger', messageKey: 'core.alerts.shorted', target: { screen: 'bus' } });
      silent = true;
    } else if (connected && i.stats && i.connectedFor > SILENT_AFTER_MS && i.stats.rxFps < 1 && this.seenOnline.size > 0 && i.devices.every((d) => !d.online)) {
      out.push({ id: 'bus.silent', severity: 'danger', messageKey: 'core.alerts.silent', target: { screen: 'bus' } });
      silent = true;
    }
    if (connected && i.stats && i.stats.loadPct >= LOAD_ALERT_PCT) {
      out.push({ id: 'bus.load', severity: 'warn', messageKey: 'core.alerts.load', params: { pct: i.stats.loadPct }, target: { screen: 'bus' } });
    }
    if (connected && i.stats) {
      this.timeoutSamples.push({ t: i.now, v: i.stats.requestTimeouts });
      while (this.timeoutSamples.length > 1 && i.now - (this.timeoutSamples[0]?.t ?? i.now) > TIMEOUT_WINDOW_MS) this.timeoutSamples.shift();
      const first = this.timeoutSamples[0];
      const delta = first ? i.stats.requestTimeouts - first.v : 0;
      if (delta >= TIMEOUT_ALERT) out.push({ id: 'bus.timeouts', severity: 'warn', messageKey: 'core.alerts.timeouts', params: { count: delta }, target: { screen: 'bus' } });
    } else this.timeoutSamples = [];

    for (const b of blown) {
      out.push({
        id: `fuse.${b.pdh.uid48}.${b.ch}`,
        severity: 'warn',
        messageKey: 'core.alerts.fuse',
        params: { name: b.pdh.label, ch: b.ch || '?' },
        target: { screen: 'device', params: { device: b.pdh.uid48 } },
      });
    }

    for (const d of i.devices) {
      if (d.online) {
        this.seenOnline.add(d.uid48);
        this.lostAt.delete(d.uid48);
        if (d.status === 'fault' && !d.faults.list.some((f) => f.key === 'fuse_blown') && !i.estopLatched) {
          out.push({ id: `fault.${d.uid48}`, severity: 'warn', messageKey: 'core.alerts.fault', params: { name: d.label }, target: { screen: 'device', params: { device: d.uid48 } } });
        }
        continue;
      }
      if (!this.seenOnline.has(d.uid48) || !connected) continue;
      if (!this.lostAt.has(d.uid48)) this.lostAt.set(d.uid48, i.now);
      if (silent) continue;
      const lostAt = this.lostAt.get(d.uid48) ?? i.now;
      const alert: Omit<Alert, 'since'> = {
        id: `lost.${d.uid48}`,
        severity: 'warn',
        messageKey: 'core.alerts.lost',
        params: { name: d.label },
        target: { screen: 'bus', params: { device: d.uid48 } },
      };
      const feed = i.feedOf?.(d.uid48);
      const fed = feed ? blown.find((b) => b.pdh.uid48 === feed.pdh && (b.ch === feed.ch || b.ch === 0)) : undefined;
      if (fed) {
        alert.detailKey = 'core.alerts.lostByFuse';
        alert.detailParams = { pdh: fed.pdh.label, ch: feed?.ch ?? fed.ch };
      } else if (!feed) {
        const near = blown.find((b) => Math.abs(b.at - lostAt) <= FUSE_CORRELATION_MS && b.pdh.uid48 !== d.uid48);
        if (near) {
          alert.detailKey = 'core.alerts.lostNearFuse';
          alert.detailParams = { pdh: near.pdh.label, ch: near.ch || '?' };
        }
      }
      out.push(alert);
    }

    const ids = new Set(out.map((a) => a.id));
    for (const k of [...this.since.keys()]) if (!ids.has(k)) this.since.delete(k);
    const order: Record<AlertSeverity, number> = { danger: 0, warn: 1 };
    return out
      .map((a) => {
        if (!this.since.has(a.id)) this.since.set(a.id, i.now);
        return { ...a, since: this.since.get(a.id) ?? i.now };
      })
      .sort((a, b) => order[a.severity] - order[b.severity] || a.since - b.since);
  }
}

/** Simulator wiring: which distribution board channel feeds each board (by uid48). */
export function simFeedMap(sim: Simulation): (uid48: string) => { pdh: string; ch: number } | null {
  const hex = (n: number): string => n.toString(16).padStart(12, '0');
  return (uid48) => {
    const node = sim.nodes.find((n) => hex(n.uid48) === uid48);
    const feed = node?.feed;
    const owner = feed?.owner as { uid48?: unknown } | null | undefined;
    if (!feed || !owner || typeof owner.uid48 !== 'number') return null;
    const m = /\.ch(\d+)$/.exec(feed.label);
    return m ? { pdh: hex(owner.uid48), ch: Number(m[1]) } : null;
  };
}

interface AlertsState {
  alerts: readonly Alert[];
}

export const useAlerts = create<AlertsState>(() => ({ alerts: [] }));

function sameAlerts(a: readonly Alert[], b: readonly Alert[]): boolean {
  return a.length === b.length && a.every((x, k) => {
    const y = b[k];
    return !!y && x.id === y.id && JSON.stringify(x.params) === JSON.stringify(y.params) && x.detailKey === y.detailKey;
  });
}

export function publishAlerts(alerts: Alert[]): void {
  if (!sameAlerts(useAlerts.getState().alerts, alerts)) useAlerts.setState({ alerts });
}
