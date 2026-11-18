import type { SeriesBuffer } from '../../ui';
import type { ScopeSignalCfg } from './layout';

/** A layout entry joined with what the catalog and the sources say about it. */
export interface PlotSignal extends ScopeSignalCfg {
  label: string;
  /** Board name alone (for compact lists). */
  device: string;
  /** Signal label alone. */
  name: string;
  unit: string;
  digits: number;
  /** The board is on the bus. */
  present: boolean;
  buffer: SeriesBuffer | undefined;
}
