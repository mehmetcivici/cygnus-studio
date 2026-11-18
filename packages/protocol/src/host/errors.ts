import { COMMAND_STATUS_LABELS, FW_STATUS_LABELS, PARAM_STATUS_LABELS } from '../catalog/common';
import type { Text } from '../catalog/schema';

export type CyErrorCode =
  /** No answer after every retry. */
  | 'TIMEOUT'
  /** The board answered with a non-OK status (see `status` / `statusKind`). */
  | 'REJECTED'
  /** The device, its model or its driver lacks the capability. */
  | 'NOT_SUPPORTED'
  /** The transport closed or the bus stopped while the operation was pending. */
  | 'DISCONNECTED'
  /** Rejected on the host before anything was sent (bad key, out of range, bad image…). */
  | 'INVALID'
  /** The board is unassigned or in conflict and only answers discovery messages. */
  | 'UNRESOLVED'
  /** Every stream slot (15) is taken. */
  | 'NO_SLOTS'
  /** Another operation of the same kind is running (e.g. a firmware update). */
  | 'BUSY'
  /** Cancelled through an abort signal. */
  | 'ABORTED';

export type CyStatusKind = 'param' | 'command' | 'fw';

export interface CyErrorInit {
  status?: number;
  statusKind?: CyStatusKind;
  /** Machine-readable reason for INVALID / NOT_SUPPORTED, e.g. `out_of_range`, `wrong_model`. */
  reason?: string;
}

/** Every failure of the host client is a CyError; UIs switch on `code` (+ `status`/`reason`). */
export class CyError extends Error {
  readonly code: CyErrorCode;
  readonly status: number | undefined;
  readonly statusKind: CyStatusKind | undefined;
  readonly reason: string | undefined;

  constructor(code: CyErrorCode, message: string, init: CyErrorInit = {}) {
    super(message);
    this.name = 'CyError';
    this.code = code;
    this.status = init.status;
    this.statusKind = init.statusKind;
    this.reason = init.reason;
  }

  /** Catalog label of the board status for REJECTED errors. */
  get statusLabel(): Text | undefined {
    if (this.status === undefined) return undefined;
    const table =
      this.statusKind === 'param' ? PARAM_STATUS_LABELS : this.statusKind === 'fw' ? FW_STATUS_LABELS : COMMAND_STATUS_LABELS;
    return table[this.status];
  }
}

export function isCyError(e: unknown, code?: CyErrorCode): e is CyError {
  return e instanceof CyError && (code === undefined || e.code === code);
}

export const disconnectedError = (): CyError => new CyError('DISCONNECTED', 'transport closed');
