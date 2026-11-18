import { ScenarioBuilder, scenarios, type Simulation } from '@cygnus/simulator';
import { connection, useConnection } from '../../core';

export const simScenarioId = (templateId: string): string => `vehicle.${templateId}`;

export const hasSimScenario = (templateId: string): boolean => scenarios.some((s) => s.id === simScenarioId(templateId));

/**
 * Starts the template's simulated vehicle with factory-fresh boards (number 63, no name,
 * default parameters), as a team gets them out of the box.
 */
export async function startSimVehicle(templateId: string): Promise<boolean> {
  const ok = await connection.connectScenario(simScenarioId(templateId), { assigned: false });
  return ok && useConnection.getState().sim !== null;
}

/** "Turn it by hand" on the simulated shaft behind a slot. */
export function simTurn(sim: Simulation, slotId: string): boolean {
  const shaft = sim.slotPlacements[slotId]?.shaftId;
  if (!shaft) return false;
  sim.world.handRotate(shaft, 0.35, sim.timeMs, 500);
  return true;
}

/** Tilts the simulated vehicle for a moment so its gyro sees it. */
export function simTilt(sim: Simulation, holdMs = 1500): () => void {
  sim.world.tiltBody(25, 10);
  const t = setTimeout(() => sim.world.tiltBody(0, 0), holdMs);
  return () => {
    clearTimeout(t);
    sim.world.tiltBody(0, 0);
  };
}

export const simHasServoBoard = (sim: Simulation): boolean => sim.nodes.some((n) => n.def.key === 'servo16');

/** Plugs a factory-fresh 16-channel servo board into the simulated bus (to try channel slots). */
export function simAddServoBoard(sim: Simulation): void {
  let i = 1;
  while (sim.nodes.some((n) => n.id === `servo16.${i}`)) i++;
  new ScenarioBuilder(sim, false).servo16({ id: `servo16.${i}` });
}
