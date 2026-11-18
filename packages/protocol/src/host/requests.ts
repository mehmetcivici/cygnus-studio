import { Timing } from '../core/constants';
import type { TxFrame } from '../core/frame';
import type { Scheduler } from '../transport/types';
import { CyError } from './errors';

/** Verdict of a response matcher for one received payload. */
export type Accept<T> =
  | { kind: 'done'; value: T }
  | { kind: 'fail'; error: CyError }
  /** Board answered IN_PROGRESS: stop retransmitting and wait up to `finalTimeoutMs`. */
  | { kind: 'progress' }
  | null;

export interface RequestSpec<T> {
  /** Responses are routed by key; requests with the same key run one after another. */
  key: string;
  /** Built on every (re)transmission so number changes are honoured. */
  frame: () => TxFrame;
  accept: (data: Uint8Array) => Accept<T>;
  timeoutMs?: number;
  attempts?: number;
  finalTimeoutMs?: number;
  onProgress?: () => void;
  /** Label for TIMEOUT messages. */
  what: string;
}

interface Pending {
  spec: RequestSpec<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: CyError) => void;
  attemptsLeft: number;
  timer: unknown;
  started: boolean;
}

/**
 * Request/response bookkeeping for one device: timeouts, retransmission (PROTOCOL §10:
 * 100 ms, 3 attempts), per-key serialisation, and failing everything at once on disconnect.
 */
export class RequestTracker {
  private readonly queues = new Map<string, Pending[]>();

  constructor(
    private readonly scheduler: Scheduler,
    private readonly send: (f: TxFrame) => void,
    private readonly onTimeout: () => void,
  ) {}

  request<T>(spec: RequestSpec<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const p: Pending = {
        spec: spec as RequestSpec<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        attemptsLeft: spec.attempts ?? Timing.REQUEST_RETRIES,
        timer: undefined,
        started: false,
      };
      let q = this.queues.get(spec.key);
      if (!q) {
        q = [];
        this.queues.set(spec.key, q);
      }
      q.push(p);
      if (q.length === 1) this.begin(p);
    });
  }

  /** Offers a response payload to the request waiting on `key`. Returns true if one consumed it. */
  deliver(key: string, data: Uint8Array): boolean {
    const p = this.queues.get(key)?.[0];
    if (!p || !p.started) return false;
    const verdict = p.spec.accept(data);
    if (!verdict) return false;
    switch (verdict.kind) {
      case 'done':
        this.finish(p);
        p.resolve(verdict.value);
        break;
      case 'fail':
        this.finish(p);
        p.reject(verdict.error);
        break;
      case 'progress':
        this.scheduler.clearTimeout(p.timer);
        p.attemptsLeft = 0;
        p.spec.onProgress?.();
        p.timer = this.scheduler.setTimeout(() => this.expire(p), p.spec.finalTimeoutMs ?? 60_000);
        break;
    }
    return true;
  }

  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  failAll(error: CyError): void {
    const all = [...this.queues.values()].flat();
    this.queues.clear();
    for (const p of all) {
      this.scheduler.clearTimeout(p.timer);
      p.reject(error);
    }
  }

  private begin(p: Pending): void {
    p.started = true;
    this.transmit(p);
  }

  private transmit(p: Pending): void {
    p.attemptsLeft--;
    p.timer = this.scheduler.setTimeout(() => this.expire(p), p.spec.timeoutMs ?? Timing.REQUEST_TIMEOUT_MS);
    this.send(p.spec.frame());
  }

  private expire(p: Pending): void {
    this.onTimeout();
    if (p.attemptsLeft > 0) {
      this.transmit(p);
      return;
    }
    this.finish(p);
    p.reject(new CyError('TIMEOUT', `${p.spec.what}: no answer`));
  }

  private finish(p: Pending): void {
    this.scheduler.clearTimeout(p.timer);
    const q = this.queues.get(p.spec.key);
    if (!q) return;
    const i = q.indexOf(p);
    if (i >= 0) q.splice(i, 1);
    const next = q[0];
    if (next) {
      if (!next.started) this.begin(next);
    } else {
      this.queues.delete(p.spec.key);
    }
  }
}
