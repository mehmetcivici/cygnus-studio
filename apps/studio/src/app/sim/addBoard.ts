import { CATALOG, Model, getModel } from '@cygnus/protocol';
import { MOTORS, ScenarioBuilder, type Simulation } from '@cygnus/simulator';

/** Models the panel can plug in. */
export const ADDABLE_MODELS: readonly number[] = CATALOG.map((m) => m.model);

let counter = 0;

function freeId(sim: Simulation, base: string): string {
  let id: string;
  do id = `${base}-${++counter}`;
  while (sim.findNode(id) || sim.world.shafts.some((s) => s.id === `${id}.shaft`));
  return id;
}

/**
 * Hot-plugs a factory-fresh board (number 63, defaults) of `model`. Actuators get their own
 * free shaft; an encoder reads `shaftId` when given (so "turn by hand" moves it).
 */
export function addBoard(sim: Simulation, model: number, shaftId?: string): string {
  const b = new ScenarioBuilder(sim, false);
  const key = getModel(model)?.key ?? 'board';
  const id = freeId(sim, key);
  const newShaft = (inertia = 0.002) => sim.world.addShaft({ id: `${id}.shaft`, label: id, inertia, viscous: 1e-4, coulomb: 0.02 });
  switch (model) {
    case Model.ESC_20A:
      b.esc({ id, model: Model.ESC_20A, motor: MOTORS.neo550, shaft: newShaft(5e-4) });
      break;
    case Model.ESC_80A:
      b.esc({ id, model: Model.ESC_80A, motor: MOTORS.neo, shaft: newShaft() });
      break;
    case Model.CYNCODER: {
      const shaft = shaftId ? sim.world.shafts.find((s) => s.id === shaftId) : undefined;
      b.encoder({ id, shaft: shaft ?? newShaft() });
      break;
    }
    case Model.GYRO:
      b.gyro({ id });
      break;
    case Model.SERVO_16CH:
      b.servo16({ id });
      break;
    case Model.SEALED_SERVO:
      b.sealedServo({ id, shaft: newShaft(5e-3) });
      break;
    case Model.POWER_DIST_SMALL:
      b.pdhSmall({ id });
      break;
    case Model.POWER_DIST_LARGE:
      b.pdhLarge({ id });
      break;
    case Model.SOC_REGULATOR:
      b.soc({ id });
      break;
    case Model.DEBUG_OLED:
      b.oled({ id });
      break;
    default:
      b.usbCan({ id });
  }
  return id;
}
