import { useDevices, useDrive, useSignal, type DeviceView } from '../../core';
import { LOW_VOLTAGE_V } from './logic';

const POWER_KEYS = ['pdh_large', 'pdh_small'];

export interface FwSafety {
  /** A drive session is armed: updates must not start. */
  driveActive: boolean;
  /** Supply voltage read from the power distribution board, when available. */
  voltage: number | null;
  lowVoltage: boolean;
  /** Boards that are enabled (actuating) right now. */
  enabledBoards: number;
}

export function useFwSafety(): FwSafety {
  const devices = useDevices();
  const driveActive = useDrive((s) => s.session?.armed === true);
  const pdh = devices.find((d: DeviceView) => d.online && d.def && POWER_KEYS.includes(d.def.key));
  const v = useSignal(pdh?.uid48, 'input.voltage');
  const voltage = pdh && Number.isFinite(v) ? v : null;
  return {
    driveActive,
    voltage,
    lowVoltage: voltage !== null && voltage < LOW_VOLTAGE_V,
    enabledBoards: devices.filter((d) => d.online && !d.legacy && d.flags.enabled).length,
  };
}
