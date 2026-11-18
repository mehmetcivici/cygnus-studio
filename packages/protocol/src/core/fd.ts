// CAN-FD payload lengths: DLC codes 9..15 map to 12, 16, 20, 24, 32, 48, 64 bytes.

const DLC_TO_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64] as const;

export const FD_MAX_LEN = 64;
export const CLASSIC_MAX_LEN = 8;

export function dlcToLength(dlc: number): number {
  return DLC_TO_LEN[dlc & 15] ?? 0;
}

/** Smallest DLC whose length holds `len` bytes; -1 if `len` exceeds 64. */
export function lengthToDlc(len: number): number {
  for (let d = 0; d < 16; d++) if ((DLC_TO_LEN[d] ?? 0) >= len) return d;
  return -1;
}

/** Rounds up to the next valid FD payload length; -1 if `len` exceeds 64. */
export function fdRoundUp(len: number): number {
  const d = lengthToDlc(len);
  return d < 0 ? -1 : dlcToLength(d);
}

export function isValidFdLength(len: number): boolean {
  return fdRoundUp(len) === len;
}
