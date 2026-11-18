import type { ActionDef } from '@cygnus/protocol';

/** True when running the action moves a mechanism (catalog `movesActuator`): it needs a drive session and hold-to-arm. */
export function movesActuator(action: ActionDef): boolean {
  return action.movesActuator === true;
}
