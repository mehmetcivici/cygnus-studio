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
  /**
   * `accept` recognises its own answer (e.g. ASSIGN_ID's echoed number), so late answers to an
   * earlier request on the same key need not be filtered out.
   */
  selfMatching?: boolean;
}

interface Pending {
  spec: RequestSpec<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: CyError) => void;
  attemptsLeft: number;
  timer: unknown;
  started: boolean;
  /** Frames sent so far; each may still draw an answer. */
  sent: number;
  /** Board answered IN_PROGRESS. */
  inProgress: boolean;
}

/** Answers still expected to earlier transmissions of a finished request on the same key. */
interface Stale {
  left: number;
  until: number;
}

/**
 * Request/response bookkeeping for one device: timeouts, retransmission (PROTOCOL §10:
 * 100 ms, 3 attempts), per-key serialisation, and failing everything at once on disconnect.
 */
export class RequestTracker {
  private readonly queues = new Map<string, Pending[]>();
  private readonly stale = new Map<string, Stale>();

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
        sent: 0,
        inProgress: false,
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
    if (this.swallowStale(key)) return true;
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
        p.inProgress = true;
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
    this.stale.clear();
    for (const p of all) {
      this.scheduler.clearTimeout(p.timer);
      p.reject(error);
    }
  }

  /** Fails the requests the board acknowledged with IN_PROGRESS (it restarted or stopped). */
  failInProgress(error: CyError): void {
    for (const q of [...this.queues.values()]) {
      const p = q[0];
      if (!p?.inProgress) continue;
      this.finish(p, false);
      p.reject(error);
    }
  }

  /**
   * A retransmitted request can draw one answer per copy. Once it has finished, the answers
   * still on their way belong to it and not to the next request on the same key (which would
   * otherwise take, say, the previous SET's value as its own).
   */
  private swallowStale(key: string): boolean {
    const st = this.stale.get(key);
    if (!st) return false;
    if (st.left <= 0 || this.scheduler.now() > st.until) {
      this.stale.delete(key);
      return false;
    }
    st.left--;
    return true;
  }

  private begin(p: Pending): void {
    p.started = true;
    this.transmit(p);
  }

  private transmit(p: Pending): void {
    p.attemptsLeft--;
    p.sent++;
    p.timer = this.scheduler.setTimeout(() => this.expire(p), p.spec.timeoutMs ?? Timing.REQUEST_TIMEOUT_MS);
    this.send(p.spec.frame());
  }

  private expire(p: Pending): void {
    this.onTimeout();
    if (p.attemptsLeft > 0) {
      this.transmit(p);
      return;
    }
    this.finish(p, false);
    p.reject(new CyError('TIMEOUT', `${p.spec.what}: no answer`));
  }

  /** `answered`: the request consumed one answer, so one fewer may still be in flight. */
  private finish(p: Pending, answered = true): void {
    this.scheduler.clearTimeout(p.timer);
    const late = p.sent - (answered ? 1 : 0);
    if (late > 0 && !p.spec.selfMatching) {
      this.stale.set(p.spec.key, { left: late, until: this.scheduler.now() + (p.spec.timeoutMs ?? Timing.REQUEST_TIMEOUT_MS) });
    }
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
