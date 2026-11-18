import { CygnusBus } from '../../src/host/bus';
import { CyncoderV3Driver, type CyncoderV3DriverOptions } from '../../src/legacy';
import { ManualScheduler } from '../../src/transport/scheduler';
import { FakeBus } from '../helpers/fake-bus';
import { FakeCyncoderV3, type FakeV3Options } from './fake-cyncoder-v3';

export async function legacyRig(opts: CyncoderV3DriverOptions = {}) {
  const sched = new ManualScheduler();
  const wire = new FakeBus(sched);
  const transport = wire.transport({ fd: false });
  const legacy = new CyncoderV3Driver({ initialSequence: 10, ...opts });
  const bus = new CygnusBus(transport, sched, { drivers: [legacy] });
  await bus.start();
  return {
    sched,
    wire,
    transport,
    bus,
    legacy,
    board: (o: FakeV3Options) => new FakeCyncoderV3(wire, o),
  };
}
