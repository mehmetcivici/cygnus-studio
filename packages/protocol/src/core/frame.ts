import { fdRoundUp } from './fd';

/** A CAN frame as seen by transports. `id` is always a 29-bit extended identifier. */
export interface CanFrame {
  id: number;
  data: Uint8Array;
  fd: boolean;
  brs: boolean;
  /** Receive time in ms (scheduler clock). */
  timestamp: number;
}

export type TxFrame = Omit<CanFrame, 'timestamp'>;

/** A board address: (DEVTYPE, NUM). */
export interface Address {
  devType: number;
  num: number;
}

/** DEVTYPE 0 + NUM 0: every Cygnus board on the bus. */
export const BROADCAST_ALL: Readonly<Address> = Object.freeze({ devType: 0, num: 0 });

/**
 * Wraps a payload into a TxFrame. Payloads longer than 8 bytes become CAN-FD frames
 * (with bit-rate switch), zero-padded up to the next valid FD length.
 */
export function makeTxFrame(id: number, data: Uint8Array): TxFrame {
  if (data.length <= 8) return { id, data, fd: false, brs: false };
  const len = fdRoundUp(data.length);
  if (len < 0) throw new RangeError(`payload of ${data.length} bytes exceeds CAN-FD maximum`);
  if (len === data.length) return { id, data, fd: true, brs: true };
  const padded = new Uint8Array(len);
  padded.set(data);
  return { id, data: padded, fd: true, brs: true };
}
