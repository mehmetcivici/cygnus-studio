import { CygnusBus } from '../../src/host/bus';
import type { DeviceHandle } from '../../src/host/types';
import { ManualScheduler } from '../../src/transport/scheduler';
import { FakeBus, run } from './fake-bus';
import { FakeNode, type FakeNodeOptions } from './fake-node';

export interface Rig {
  sched: ManualScheduler;
  wire: FakeBus;
  transport: ReturnType<FakeBus['transport']>;
  bus: CygnusBus;
  node(o: FakeNodeOptions): FakeNode;
  /** Runs until the board shows up with its INFO pages read. */
  ready(node: FakeNode): Promise<DeviceHandle>;
}

export async function rig(opts: { fd?: boolean } = {}): Promise<Rig> {
  const sched = new ManualScheduler();
  const wire = new FakeBus(sched);
  const transport = wire.transport({ fd: opts.fd ?? true });
  const bus = new CygnusBus(transport, sched);
  await bus.start();
  return {
    sched,
    wire,
    transport,
    bus,
    node: (o) => new FakeNode(wire, o),
    async ready(node) {
      for (let i = 0; i < 3000; i += 10) {
        const h = bus.deviceByUid(node.uid48);
        if (h?.infoLoaded && h.fw) return h;
        await run(sched, 10);
      }
      throw new Error('device did not become ready');
    },
  };
}

/** Catches a rejection so tests can assert on it. */
export async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}
