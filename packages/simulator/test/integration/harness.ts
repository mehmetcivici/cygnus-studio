import { CygnusBus, ManualScheduler, type BusDriver, type DeviceHandle } from '@cygnus/protocol';
import { LegacyCyncoderNode } from '../../src/devices/legacy-cyncoder';
import type { SimNode } from '../../src/node';
import type { Simulation } from '../../src/simulation';
import type { SimTransport } from '../../src/transport';

/**
 * Host client and simulation on one clock. Each millisecond the scheduler (host timers) runs
 * first, then the simulation steps and delivers frames, then pending promises settle. No real
 * waiting anywhere.
 */
export interface Rig {
  sim: Simulation;
  sched: ManualScheduler;
  transport: SimTransport;
  bus: CygnusBus;
  runFor(ms: number): Promise<void>;
  /** Runs until the promise settles (or `maxMs` passes) and returns its outcome. */
  settle<T>(p: Promise<T>, maxMs?: number): Promise<T>;
  /** Runs until `cond` holds; throws after `maxMs`. */
  until(cond: () => boolean, maxMs?: number, what?: string): Promise<void>;
  /** Discovery until `count` online boards (default: every board some driver speaks to) are known and every resolved one has its INFO pages. */
  discover(count?: number, maxMs?: number): Promise<DeviceHandle[]>;
  /** Handle of a simulation node (by node id). */
  dev(nodeId: string): DeviceHandle;
  /** Records rejections so a test can assert on them. */
  caught(p: Promise<unknown>, maxMs?: number): Promise<unknown>;
}

/** Boards speaking CyCAN (everything except legacy Cyncoder v3 boards). */
export function cycanNodes(sim: Simulation): SimNode[] {
  return sim.nodes.filter((n) => !(n instanceof LegacyCyncoderNode));
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export async function connect(sim: Simulation, opts: { drivers?: BusDriver[] } = {}): Promise<Rig> {
  const sched = new ManualScheduler(sim.timeMs);
  sim.hostTimeOffset = 0;
  const transport = sim.createTransport('integration');
  const bus = new CygnusBus(transport, sched, { drivers: opts.drivers ?? [] });
  await bus.start();

  const step = async (): Promise<void> => {
    sched.advance(1);
    sim.advance(1);
    await flush();
  };
  const runFor = async (ms: number): Promise<void> => {
    for (let t = 0; t < ms; t++) await step();
  };
  const settle = async <T>(p: Promise<T>, maxMs = 30_000): Promise<T> => {
    let done = false;
    const tracked = p.then(
      (v) => {
        done = true;
        return v;
      },
      (e: unknown) => {
        done = true;
        throw e;
      },
    );
    tracked.catch(() => undefined);
    await flush();
    for (let t = 0; t < maxMs && !done; t++) await step();
    if (!done) throw new Error(`promise did not settle within ${maxMs} ms`);
    return tracked;
  };
  const until = async (cond: () => boolean, maxMs = 5000, what = 'condition'): Promise<void> => {
    for (let t = 0; t < maxMs; t++) {
      if (cond()) return;
      await step();
    }
    if (!cond()) throw new Error(`${what} not reached within ${maxMs} ms`);
  };
  const rig: Rig = {
    sim,
    sched,
    transport,
    bus,
    runFor,
    settle,
    until,
    async discover(count = opts.drivers?.some((d) => d.id === 'cyncoder-v3') ? sim.nodes.length : cycanNodes(sim).length, maxMs = 5000) {
      await until(
        () => {
          const online = bus.devices.filter((d) => d.online);
          return online.length >= count && online.every((d) => d.driver !== 'cycan' || d.unassigned || d.conflict || (d.infoLoaded && d.fw !== null));
        },
        maxMs,
        `discovery of ${count} boards`,
      );
      return bus.devices;
    },
    dev(nodeId) {
      const n = sim.node(nodeId);
      const d = bus.deviceByUid(n instanceof LegacyCyncoderNode ? n.uid32 : n.uid48);
      if (!d) throw new Error(`no handle for ${nodeId}`);
      return d;
    },
    async caught(p, maxMs = 5000) {
      try {
        await settle(p, maxMs);
      } catch (e) {
        return e;
      }
      throw new Error('expected rejection');
    },
  };
  return rig;
}
