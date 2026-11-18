/** CTRL TEXT carries 6 characters at (line, col); the panel has 8 lines of 21 columns. */
export const OLED_COLS = 21;
export const OLED_LINES = 8;
const CHUNK = 6;

/** Splits a line of text into CTRL TEXT frames (6 characters each, padded with spaces to the line end). */
export function textFrames(line: number, text: string): Array<{ line: number; col: number; text: string }> {
  const padded = text.slice(0, OLED_COLS).padEnd(OLED_COLS, ' ');
  const out: Array<{ line: number; col: number; text: string }> = [];
  for (let col = 0; col < OLED_COLS; col += CHUNK) out.push({ line, col, text: padded.slice(col, col + CHUNK) });
  return out;
}
