/** Four pulses of one `servo4` CTRL frame starting at `firstChannel` (1-based); 0 = channel off. */
export function framePulses(channels: ReadonlyArray<{ on: boolean; us: number }>, firstChannel: number): number[] {
  return [0, 1, 2, 3].map((i) => {
    const c = channels[firstChannel - 1 + i];
    return c && c.on ? Math.round(c.us) : 0;
  });
}
