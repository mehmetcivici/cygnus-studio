import type { CanFrame } from '../core/frame';

export type TransportPhase = 'closed' | 'opening' | 'open' | 'error';

export interface TransportState {
  phase: TransportPhase;
  /** Human-readable reason when phase is 'error'. */
  error?: string;
  /**
   * Set on 'open' when the link works with less than asked for. `fd_unsupported`: the adapter
   * refused the CAN-FD data rate and runs classic CAN (`info.fd` is false).
   */
  notice?: 'fd_unsupported';
}

export interface TransportInfo {
  kind: 'sim' | 'slcan' | string;
  label: string;
  /** True when the link can carry CAN-FD frames. */
  fd: boolean;
}

export interface Transport {
  readonly info: TransportInfo;
  open(): Promise<void>;
  close(): Promise<void>;
  send(frame: Omit<CanFrame, 'timestamp'>): void;
  /** Returns an unsubscribe function. */
  onFrame(cb: (f: CanFrame) => void): () => void;
  /** Returns an unsubscribe function. */
  onState(cb: (s: TransportState) => void): () => void;
}

/** The only source of time for the host client and simulator. */
export interface Scheduler {
  /** Milliseconds, monotonic. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
