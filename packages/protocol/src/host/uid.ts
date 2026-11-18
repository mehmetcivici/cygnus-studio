import { CyError } from './errors';

const UID48_MAX = 0xffff_ffff_ffff;

export function uid48ToHex(uid48: number): string {
  return uid48.toString(16).padStart(12, '0');
}

/** Accepts a uid48 as number or hex string (12 digits, optional `0x`, `:`/`-` separators). */
export function parseUid48(uid: string | number): number {
  if (typeof uid === 'number') {
    if (Number.isInteger(uid) && uid >= 0 && uid <= UID48_MAX) return uid;
  } else {
    const s = uid.trim().toLowerCase().replace(/^0x/, '').replace(/[:\-\s]/g, '');
    if (/^[0-9a-f]{1,12}$/.test(s)) return parseInt(s, 16);
  }
  throw new CyError('INVALID', `bad uid48: ${String(uid)}`, { reason: 'bad_uid' });
}
